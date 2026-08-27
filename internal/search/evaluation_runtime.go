package search

import (
	"fmt"
	"strings"

	"github.com/howznguyen/knowns/internal/storage"
)

// SemanticEvaluationRuntimeIdentity returns a stable, non-secret identity for
// baseline attribution across machines.
// MockEvaluationRuntimeIdentity is the runtime identity reported while the
// deterministic embedder is active. It is deliberately unmistakable, so a
// baseline recorded against the mock can never be confused with one recorded
// against a real model.
const MockEvaluationRuntimeIdentity = "mock/mock-deterministic@32"

func SemanticEvaluationRuntimeIdentity(store *storage.Store) (string, error) {
	// Under the deterministic embedder the runtime is the mock itself, so it
	// reports a stable identity of its own. The pin still applies; CI pins to
	// this value rather than to a provider that would have to be installed.
	if MockEmbedderEnabled() {
		return MockEvaluationRuntimeIdentity, nil
	}
	cfg, err := loadSemanticRuntimeConfig(store)
	if err != nil {
		return "", fmt.Errorf("load semantic evaluation runtime: %w", err)
	}
	return fmt.Sprintf("%s/%s@%d", cfg.provider, cfg.modelID, cfg.dimensions), nil
}

// RequirePinnedSemanticEvaluationRuntime verifies exact identity and readiness
// before semantic/hybrid evaluation. It never invokes keyword fallback.
func RequirePinnedSemanticEvaluationRuntime(
	store *storage.Store,
	pinnedIdentity string,
) (string, error) {
	pinnedIdentity = strings.TrimSpace(pinnedIdentity)
	if pinnedIdentity == "" {
		return "", fmt.Errorf("pinned semantic runtime identity: required")
	}
	actualIdentity, err := SemanticEvaluationRuntimeIdentity(store)
	if err != nil {
		return "", err
	}
	if actualIdentity != pinnedIdentity {
		return actualIdentity, fmt.Errorf(
			"semantic runtime identity mismatch: configured %q, pinned %q",
			actualIdentity,
			pinnedIdentity,
		)
	}
	// The mock has no daemon to enable and no index to warm: it answers every
	// embed call in process. Identity equality above is the whole check.
	if MockEmbedderEnabled() {
		return actualIdentity, nil
	}
	if !SemanticRuntimeEnabled() {
		status := ObservedSemanticRuntimeStatus()
		return actualIdentity, fmt.Errorf(
			"semantic runtime %q is disabled by %s",
			actualIdentity,
			status.DisabledBy,
		)
	}
	available, err := semanticIndexAvailableForRuntime(store, "")
	if err != nil {
		return actualIdentity, fmt.Errorf(
			"semantic runtime %q index readiness: %w",
			actualIdentity,
			err,
		)
	}
	if !available {
		return actualIdentity, fmt.Errorf(
			"semantic runtime %q index is missing or empty; run an explicit semantic reindex",
			actualIdentity,
		)
	}
	session, err := InitSemanticRuntimeSession(store)
	if err != nil {
		return actualIdentity, fmt.Errorf(
			"semantic runtime %q is not loadable: %w",
			actualIdentity,
			err,
		)
	}
	if err := session.Close(); err != nil {
		return actualIdentity, fmt.Errorf(
			"close semantic runtime %q readiness session: %w",
			actualIdentity,
			err,
		)
	}
	return actualIdentity, nil
}
