package search

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/storage"
)

func TestSemanticEvaluationRuntimeIdentityIsStableAndNonSecret(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("evaluation-runtime"); err != nil {
		t.Fatal(err)
	}
	if err := store.Config.Set("settings.semanticSearch.enabled", true); err != nil {
		t.Fatal(err)
	}
	if err := store.Config.Set("settings.semanticSearch.model", "gte-small"); err != nil {
		t.Fatal(err)
	}
	if err := store.Config.Set("settings.semanticSearch.provider", "local"); err != nil {
		t.Fatal(err)
	}
	if err := store.Config.Set("settings.semanticSearch.dimensions", 384); err != nil {
		t.Fatal(err)
	}

	identity, err := SemanticEvaluationRuntimeIdentity(store)
	if err != nil {
		t.Fatal(err)
	}
	if identity != "local/gte-small@384" {
		t.Fatalf("identity = %q", identity)
	}
	if strings.Contains(identity, store.Root) {
		t.Fatalf("identity %q must not include machine-local paths", identity)
	}
}

func TestRequirePinnedSemanticEvaluationRuntimeRejectsMismatchBeforeFallback(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("evaluation-runtime"); err != nil {
		t.Fatal(err)
	}
	if err := store.Config.Set("settings.semanticSearch.enabled", true); err != nil {
		t.Fatal(err)
	}
	if err := store.Config.Set("settings.semanticSearch.model", "gte-small"); err != nil {
		t.Fatal(err)
	}
	if err := store.Config.Set("settings.semanticSearch.provider", "local"); err != nil {
		t.Fatal(err)
	}
	if err := store.Config.Set("settings.semanticSearch.dimensions", 384); err != nil {
		t.Fatal(err)
	}

	actual, err := RequirePinnedSemanticEvaluationRuntime(store, "local/other-model@384")
	if actual != "local/gte-small@384" {
		t.Fatalf("actual identity = %q", actual)
	}
	if err == nil || !strings.Contains(err.Error(), "identity mismatch") {
		t.Fatalf("error = %v, want identity mismatch", err)
	}
	if strings.Contains(err.Error(), "keyword") {
		t.Fatalf("readiness failure must not mention keyword fallback: %v", err)
	}
}
