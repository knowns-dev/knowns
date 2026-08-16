package doctor

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/qdrantruntime"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

// qdrantDiagnosticSnapshot intentionally contains only readiness metadata.
// In particular, it never carries the configured external URL, API key,
// request headers, raw errors, or collection payloads.
type qdrantDiagnosticSnapshot struct {
	Resolution     models.SemanticVectorStoreResolution
	Runtime        qdrantruntime.Status
	Pointer        *search.QdrantPointer
	Readiness      search.SemanticIndexReadiness
	Expected       search.SemanticIndexIdentity
	Collection     search.QdrantCollectionInfo
	Probed         bool
	Healthy        bool
	ProbeErrorCode string
	Orphans        []string
}

func qdrantCheckers(state *localState) []Checker {
	return []Checker{
		qdrantRuntimeChecker(state),
		qdrantPointerChecker(state),
		qdrantCollectionChecker(state),
		qdrantOrphanChecker(state),
	}
}

func qdrantSkip(snapshot qdrantDiagnosticSnapshot, disabled, notApplicable string) (CheckResult, bool) {
	if !snapshot.Resolution.Enabled || snapshot.Resolution.OptedOut || snapshot.Resolution.Backend == models.SemanticVectorBackendNone {
		return subsystemDisabled(disabled, "config_disabled"), true
	}
	if snapshot.Resolution.Backend != models.SemanticVectorBackendQdrant {
		return subsystemDisabled(notApplicable, "not_applicable"), true
	}
	return CheckResult{}, false
}

func qdrantRuntimeChecker(state *localState) Checker {
	return Checker{ID: "search.qdrant-runtime", Scope: ScopeSearch, Check: func(ctx context.Context) (CheckResult, error) {
		if state.store == nil {
			return skippedForMissingProject(), nil
		}
		snapshot, err := state.qdrantSnapshot(ctx)
		if err != nil {
			return CheckResult{}, err
		}
		if skip, ok := qdrantSkip(snapshot, "Qdrant semantic search is intentionally disabled", "Qdrant runtime is not applicable to the configured semantic backend"); ok {
			return skip, nil
		}
		if snapshot.Resolution.Mode == models.SemanticVectorStoreModeExternal {
			return CheckResult{Status: StatusPass, Summary: "External Qdrant mode is configured", Evidence: Evidence{
				"backend": "qdrant", "mode": "external", "managed": false,
			}}, nil
		}
		evidence := Evidence{"backend": "qdrant", "mode": "managed", "managed": true, "installed": snapshot.Runtime.Installed, "state": snapshot.Runtime.State}
		switch snapshot.Runtime.State {
		case qdrantruntime.StatusRunning:
			evidence["running"] = true
			if !snapshot.Healthy {
				evidence["healthy"] = false
				evidence["errorCode"] = snapshot.ProbeErrorCode
				return CheckResult{Status: StatusWarn, Summary: "Managed Qdrant process is running but unhealthy", Evidence: evidence, Remediation: &Remediation{Description: "Restart the configured managed Qdrant runtime explicitly.", Command: "knowns qdrant start"}}, nil
			}
			evidence["healthy"] = true
			return CheckResult{Status: StatusPass, Summary: "Managed Qdrant process is running", Evidence: evidence}, nil
		case qdrantruntime.StatusNotInstalled:
			return CheckResult{Status: StatusWarn, Summary: "Managed Qdrant binary is not installed", Evidence: evidence, Remediation: &Remediation{Description: "Install the managed Qdrant binary explicitly.", Command: "knowns qdrant install"}}, nil
		default:
			evidence["running"] = false
			return CheckResult{Status: StatusWarn, Summary: "Managed Qdrant process is not healthy", Evidence: evidence, Remediation: &Remediation{Description: "Start the configured managed Qdrant runtime explicitly.", Command: "knowns qdrant start"}}, nil
		}
	}}
}

func qdrantPointerChecker(state *localState) Checker {
	return Checker{ID: "search.qdrant-pointer", Scope: ScopeSearch, Check: func(ctx context.Context) (CheckResult, error) {
		if state.store == nil {
			return skippedForMissingProject(), nil
		}
		snapshot, err := state.qdrantSnapshot(ctx)
		if err != nil {
			return CheckResult{}, err
		}
		if skip, ok := qdrantSkip(snapshot, "Qdrant pointer is dormant because semantic search is disabled", "Qdrant pointer is not applicable to the configured semantic backend"); ok {
			return skip, nil
		}
		if snapshot.Pointer == nil {
			return CheckResult{Status: StatusWarn, Summary: "Qdrant active collection pointer is missing", Evidence: Evidence{"pointer": "missing"}, Remediation: &Remediation{Description: "Build and activate a Qdrant generation explicitly.", Command: "knowns search index --wait"}}, nil
		}
		evidence := Evidence{"pointer": "present", "actualModel": snapshot.Pointer.Embedding.Model, "actualDimensions": snapshot.Pointer.Embedding.Dimensions, "actualChunkVersion": snapshot.Pointer.ChunkVersion, "chunkCount": snapshot.Pointer.ChunkCount, "expectedModel": snapshot.Expected.Model, "expectedDimensions": snapshot.Expected.Dimensions, "expectedChunkVersion": snapshot.Expected.ChunkVersion}
		if snapshot.Readiness.Stale || snapshot.Readiness.Degraded || !snapshot.Readiness.Ready {
			evidence["ready"] = false
			evidence["errorCode"] = qdrantPointerErrorCode(snapshot)
			return CheckResult{Status: StatusWarn, Summary: "Qdrant active pointer is stale or incomplete", Evidence: evidence, Remediation: &Remediation{Description: "Rebuild the active collection for the configured model, dimensions, and chunk version.", Command: "knowns search index --wait"}}, nil
		}
		evidence["ready"] = true
		return CheckResult{Status: StatusPass, Summary: "Qdrant active pointer is valid", Evidence: evidence}, nil
	}}
}

func qdrantCollectionChecker(state *localState) Checker {
	return Checker{ID: "search.qdrant-collection", Scope: ScopeSearch, Check: func(ctx context.Context) (CheckResult, error) {
		if state.store == nil {
			return skippedForMissingProject(), nil
		}
		snapshot, err := state.qdrantSnapshot(ctx)
		if err != nil {
			return CheckResult{}, err
		}
		if skip, ok := qdrantSkip(snapshot, "Qdrant collection is dormant because semantic search is disabled", "Qdrant collection is not applicable to the configured semantic backend"); ok {
			return skip, nil
		}
		if snapshot.Resolution.Mode == models.SemanticVectorStoreModeExternal {
			return CheckResult{Status: StatusWarn, Summary: "External Qdrant collection is not probed by offline doctor", Evidence: Evidence{"mode": "external", "probed": false}, Remediation: &Remediation{Description: "Verify the external Qdrant endpoint, credentials, and active collection manually, then run a blocking reindex if needed."}}, nil
		}
		if !snapshot.Probed {
			remediation := &Remediation{Description: "Start managed Qdrant, then rerun doctor.", Command: "knowns qdrant start"}
			if snapshot.Runtime.State == qdrantruntime.StatusRunning && snapshot.Healthy {
				remediation = &Remediation{Description: "Rebuild the active collection explicitly, then rerun doctor.", Command: "knowns search index --wait"}
			}
			return CheckResult{Status: StatusWarn, Summary: "Qdrant collection cannot be inspected", Evidence: Evidence{"probed": false, "errorCode": snapshot.ProbeErrorCode}, Remediation: remediation}, nil
		}
		evidence := Evidence{"probed": true, "exists": snapshot.Collection.Exists, "dimensions": snapshot.Collection.Dimensions, "points": snapshot.Collection.PointsCount, "status": snapshot.Collection.Status}
		if !snapshot.Collection.Exists {
			return CheckResult{Status: StatusWarn, Summary: "Qdrant active collection does not exist", Evidence: evidence, Remediation: &Remediation{Description: "Rebuild and activate the missing collection explicitly.", Command: "knowns search index --wait"}}, nil
		}
		if snapshot.Pointer != nil && snapshot.Collection.Dimensions != snapshot.Pointer.Embedding.Dimensions {
			return CheckResult{Status: StatusWarn, Summary: "Qdrant collection dimensions do not match the active pointer", Evidence: evidence, Remediation: &Remediation{Description: "Rebuild the collection with the configured embedding dimensions.", Command: "knowns search index --wait"}}, nil
		}
		return CheckResult{Status: StatusPass, Summary: "Qdrant active collection is present and compatible", Evidence: evidence}, nil
	}}
}

func qdrantOrphanChecker(state *localState) Checker {
	return Checker{ID: "search.qdrant-orphans", Scope: ScopeSearch, Check: func(ctx context.Context) (CheckResult, error) {
		if state.store == nil {
			return skippedForMissingProject(), nil
		}
		snapshot, err := state.qdrantSnapshot(ctx)
		if err != nil {
			return CheckResult{}, err
		}
		if skip, ok := qdrantSkip(snapshot, "Qdrant cleanup is dormant because semantic search is disabled", "Qdrant cleanup is not applicable to the configured semantic backend"); ok {
			return skip, nil
		}
		if len(snapshot.Orphans) == 0 {
			return CheckResult{Status: StatusPass, Summary: "No Qdrant orphan collection candidates were identified", Evidence: Evidence{"orphanCandidates": 0}}, nil
		}
		return CheckResult{Status: StatusWarn, Summary: "Qdrant orphan collection candidates were identified", Evidence: Evidence{"orphanCandidates": snapshot.Orphans}, Remediation: &Remediation{Description: "Review and explicitly clean eligible inactive Qdrant generations.", Command: "knowns qdrant cleanup"}}, nil
	}}
}

func inspectQdrantReadOnly(ctx context.Context, store *storage.Store) (qdrantDiagnosticSnapshot, error) {
	if store == nil {
		return qdrantDiagnosticSnapshot{}, fmt.Errorf("project store unavailable")
	}
	project, err := store.Config.Load()
	if err != nil {
		return qdrantDiagnosticSnapshot{}, err
	}
	var projectSettings *models.SemanticSearchSettings
	if project != nil {
		projectSettings = project.Settings.SemanticSearch
	}
	var globalSettings *models.SemanticSearchSettings
	if global, loadErr := storage.NewEmbeddingSettingsStore().Load(); loadErr == nil && global.ProjectDefaults != nil {
		globalSettings = global.ProjectDefaults.Settings.SemanticSearch
	}
	resolution := models.ResolveSemanticVectorStore(projectSettings, globalSettings, nil)
	snapshot := qdrantDiagnosticSnapshot{Resolution: resolution}
	if !resolution.Enabled || resolution.Backend != models.SemanticVectorBackendQdrant {
		return snapshot, nil
	}

	manager := qdrantruntime.NewManager(qdrantruntime.ConfigFromResolution(resolution))
	runtimeStatus, err := manager.Status(ctx)
	if err != nil {
		return snapshot, err
	}
	snapshot.Runtime = runtimeStatus
	pointer, err := search.LoadQdrantPointer(store.Root)
	if err != nil {
		return snapshot, err
	}
	snapshot.Pointer = pointer
	snapshot.Readiness = search.ResolveSemanticIndexReadiness(store)
	snapshot.Expected = search.ConfiguredSemanticIndexIdentity(store)
	records, err := search.LoadQdrantGenerations(store.Root)
	if err != nil {
		return snapshot, err
	}
	snapshot.Orphans = qdrantOrphanCandidates(records, pointer, resolution, search.StoreRootFingerprint(store.Root))
	if resolution.Mode != models.SemanticVectorStoreModeManaged || runtimeStatus.State != qdrantruntime.StatusRunning {
		return snapshot, nil
	}
	if err := manager.ProbeHealth(ctx); err != nil {
		snapshot.ProbeErrorCode = "qdrant_health_unavailable"
		return snapshot, nil
	}
	snapshot.Healthy = true
	if pointer == nil {
		return snapshot, nil
	}
	client, err := search.NewConfiguredQdrantClient(store)
	if err != nil {
		snapshot.ProbeErrorCode = "qdrant_client_unavailable"
		return snapshot, nil
	}
	info, err := client.InspectCollection(ctx, pointer.CollectionName)
	if err != nil {
		snapshot.ProbeErrorCode = "qdrant_collection_unavailable"
		return snapshot, nil
	}
	snapshot.Collection, snapshot.Probed = info, true
	return snapshot, nil
}

func qdrantPointerErrorCode(snapshot qdrantDiagnosticSnapshot) string {
	if snapshot.Pointer == nil {
		return "qdrant_pointer_missing"
	}
	switch {
	case snapshot.Expected.Model != "" && snapshot.Pointer.Embedding.Model != snapshot.Expected.Model:
		return "qdrant_model_mismatch"
	case snapshot.Expected.Dimensions > 0 && snapshot.Pointer.Embedding.Dimensions != snapshot.Expected.Dimensions:
		return "qdrant_dimensions_mismatch"
	case snapshot.Expected.ChunkVersion > 0 && snapshot.Pointer.ChunkVersion != snapshot.Expected.ChunkVersion:
		return "qdrant_chunk_version_mismatch"
	default:
		return "qdrant_pointer_invalid"
	}
}

func qdrantOrphanCandidates(records []search.QdrantGenerationRecord, active *search.QdrantPointer, resolution models.SemanticVectorStoreResolution, currentStoreFingerprint string) []string {
	if active == nil || active.Owner.StoreRootFingerprint == "" || currentStoreFingerprint == "" || active.Owner.StoreRootFingerprint != currentStoreFingerprint {
		return nil
	}
	keep := models.DefaultSemanticVectorRetentionGenerations
	if resolution.Retention.PreviousGenerations != nil {
		keep = *resolution.Retention.PreviousGenerations
	}
	// D7 is a hard safety cap, regardless of user-configured retention.
	if keep > models.DefaultSemanticVectorRetentionGenerations {
		keep = models.DefaultSemanticVectorRetentionGenerations
	}
	ttl := search.DefaultQdrantGenerationTTL
	if raw := strings.TrimSpace(resolution.Retention.PreviousGenerationTTL); raw != "" {
		if parsed, err := models.ParseTaskLifecycleDuration(raw); err == nil {
			ttl = parsed
		}
	}
	type candidate struct {
		name       string
		generation int
		retired    *time.Time
	}
	seen := map[string]candidate{}
	for _, record := range records {
		if record.Status != search.QdrantGenerationStatusInactive || record.CollectionName == "" || record.CollectionName == active.CollectionName || record.Owner.StoreRootFingerprint != active.Owner.StoreRootFingerprint {
			continue
		}
		seen[record.CollectionName] = candidate{record.CollectionName, record.Generation, record.RetiredAt}
	}
	items := make([]candidate, 0, len(seen))
	for _, item := range seen {
		items = append(items, item)
	}
	// The history writer assigns monotonically increasing generations; sort here
	// without importing collection contents or any secret-bearing configuration.
	sort.Slice(items, func(i, j int) bool {
		if items[i].generation != items[j].generation {
			return items[i].generation > items[j].generation
		}
		return items[i].name < items[j].name
	})
	now := time.Now().UTC()
	out := make([]string, 0)
	for i, item := range items {
		if i >= keep || (item.retired != nil && !now.Before(item.retired.Add(ttl))) {
			out = append(out, item.name)
		}
	}
	return out
}
