package readiness

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestLSPStatusFromRuntimeIncludesRuntimeFields(t *testing.T) {
	got := lspStatusFromRuntime(lsp.LanguageRuntimeStatus{
		ID:                     lsp.CSharpLanguageID,
		Name:                   "C#",
		Enabled:                true,
		Detected:               true,
		Status:                 lsp.RuntimeInstallInstalled,
		InstallState:           lsp.RuntimeInstallInstalled,
		RunningState:           lsp.RuntimeRunningUnknown,
		ReadinessState:         lsp.RuntimeReadinessUnknown,
		Backend:                lsp.CSharpBackendCSharp,
		BackendSource:          lsp.RuntimeSourceAuto,
		ProjectPath:            "/repo/App.sln",
		ProjectKind:            "sln",
		LogPath:                "/repo/.knowns/logs/lsp/csharp-csharp-ls.log",
		Attempts:               []lsp.BackendAttempt{{Backend: lsp.CSharpBackendCSharp, Status: lsp.BackendAttemptChosen}},
		Owner:                  "daemon",
		DaemonState:            "running",
		DaemonPID:              1234,
		CapabilitiesKnown:      true,
		Capabilities:           []string{lsp.CapabilityDocumentSymbols, lsp.CapabilityReferences},
		AdvertisedCapabilities: []string{lsp.CapabilityDocumentSymbols},
		RequiredCapabilities:   []string{lsp.CapabilityDefinition, lsp.CapabilityDocumentSymbols, lsp.CapabilityReferences},
		MissingCapabilities:    []string{lsp.CapabilityDefinition},
	})
	if got.Backend != lsp.CSharpBackendCSharp || got.BackendSource != lsp.RuntimeSourceAuto {
		t.Fatalf("backend fields missing: %#v", got)
	}
	if got.InstallState != lsp.RuntimeInstallInstalled || got.RunningState != lsp.RuntimeRunningUnknown || got.ReadinessState != lsp.RuntimeReadinessUnknown {
		t.Fatalf("state fields missing: %#v", got)
	}
	if got.ProjectPath == "" || got.LogPath == "" || len(got.Attempts) != 1 {
		t.Fatalf("project/log/attempt fields missing: %#v", got)
	}
	if got.Owner != "daemon" || got.DaemonState != "running" || got.DaemonPID != 1234 {
		t.Fatalf("daemon fields missing: %#v", got)
	}
	if !got.CapabilitiesKnown || !reflect.DeepEqual(got.MissingCapabilities, []string{lsp.CapabilityDefinition}) || !reflect.DeepEqual(got.AdvertisedCapabilities, []string{lsp.CapabilityDocumentSymbols}) {
		t.Fatalf("capability fields missing: %#v", got)
	}
}

func TestSemanticRuntimeReadinessReportsDisabledState(t *testing.T) {
	t.Setenv("KNOWNS_SEMANTIC_RUNTIME_DISABLED", "1")
	search.DefaultSemanticRuntime().Close()
	t.Cleanup(search.DefaultSemanticRuntime().Close)

	got := buildSemanticRuntimeReadiness()
	if got.Enabled {
		t.Fatalf("enabled = true, want false")
	}
	if got.DisabledBy != "KNOWNS_SEMANTIC_RUNTIME_DISABLED" {
		t.Fatalf("disabledBy = %q", got.DisabledBy)
	}
	if got.Loaded {
		t.Fatalf("loaded = true, want false")
	}
}

func TestSemanticModelInstalledDoesNotRequireONNXForRemoteProviders(t *testing.T) {
	for _, provider := range []string{"api", "ollama"} {
		settings := &models.SemanticSearchSettings{Provider: provider, Model: "remote-model"}
		if !semanticModelInstalled(settings, false) {
			t.Fatalf("provider %q should not require a local ONNX runtime", provider)
		}
	}

	local := &models.SemanticSearchSettings{Provider: "local", Model: "gte-small"}
	if semanticModelInstalled(local, false) {
		t.Fatal("local provider should require an available ONNX runtime")
	}
	if !semanticModelInstalled(local, true) {
		t.Fatal("local provider with ONNX runtime should be ready")
	}
}

// enableSemanticConfig turns on semantic search for a store with a fixed
// local embedding identity so readiness checks are deterministic.
func enableSemanticConfig(t *testing.T, store *storage.Store) {
	t.Helper()
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	project.Settings.SemanticSearch = &models.SemanticSearchSettings{
		Enabled:    true,
		Provider:   "local",
		Model:      "gte-small",
		Dimensions: 384,
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save config: %v", err)
	}
}

// seedReadinessSQLiteIndex writes a minimal legacy SQLite semantic index.
func seedReadinessSQLiteIndex(t *testing.T, storeRoot, model string, dimensions int) {
	t.Helper()
	vecStore := search.NewSQLiteVectorStore(filepath.Join(storeRoot, ".search"), model, dimensions)
	if err := vecStore.Load(); err != nil {
		t.Fatalf("load vector store: %v", err)
	}
	defer vecStore.Close()
	embedding := make([]float32, dimensions)
	embedding[0] = 1
	vecStore.AddChunks([]search.Chunk{{
		ID:         "doc:readiness/semantic:chunk:1",
		Type:       search.ChunkTypeDoc,
		Content:    "readiness semantic chunk",
		TokenCount: 3,
		Embedding:  embedding,
		DocPath:    "readiness/semantic",
		Position:   1,
	}})
	if err := vecStore.Save(); err != nil {
		t.Fatalf("save vector store: %v", err)
	}
}

// writeReadinessQdrantPointer writes a valid pointer for the store root.
func writeReadinessQdrantPointer(t *testing.T, storeRoot string) {
	t.Helper()
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	if err := search.SaveQdrantPointer(storeRoot, &search.QdrantPointer{
		Backend:        "qdrant",
		CollectionUUID: "8f2c6a7b-91d4-4f6a-b9f7-2ef84d72a9c1",
		SchemaVersion:  search.QdrantPointerSchemaVersion,
		ChunkVersion:   search.ChunkVersion,
		Embedding: search.QdrantEmbeddingPointer{
			Provider:   "local",
			Model:      "gte-small",
			Dimensions: 384,
		},
		Owner: search.QdrantOwnerPointer{
			ProjectID:            "readiness-test",
			StoreRootFingerprint: search.StoreRootFingerprint(storeRoot),
		},
		LastIndexedAt: &now,
		ChunkCount:    42,
	}); err != nil {
		t.Fatalf("save qdrant pointer: %v", err)
	}
}

func newReadinessStore(t *testing.T, name string) *storage.Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init(name); err != nil {
		t.Fatal(err)
	}
	return store
}

func TestBuildSearchDisabledState(t *testing.T) {
	store := newReadinessStore(t, "readiness-disabled")
	payload := BuildReadiness(store, Options{})
	s := payload.Search
	if s == nil {
		t.Fatal("search status is nil")
	}
	if s.SemanticEnabled {
		t.Fatal("semanticEnabled = true, want false for unconfigured store")
	}
	if s.SemanticDegraded {
		t.Fatalf("semanticDegraded = true, want false for disabled store (reason: %s)", s.SemanticDegradedReason)
	}
	if s.ProjectIndexReady {
		t.Fatal("projectIndexReady = true, want false for disabled store")
	}
}

func TestBuildSearchQdrantPointerReady(t *testing.T) {
	store := newReadinessStore(t, "readiness-qdrant")
	enableSemanticConfig(t, store)
	writeReadinessQdrantPointer(t, store.Root)

	payload := BuildReadiness(store, Options{})
	s := payload.Search
	if !s.SemanticEnabled {
		t.Fatalf("semanticEnabled = false, want true")
	}
	if s.SemanticBackend != "qdrant" {
		t.Fatalf("semanticBackend = %q, want qdrant", s.SemanticBackend)
	}
	if !s.ProjectIndexReady {
		t.Fatalf("projectIndexReady = false, want true with valid qdrant pointer: %+v", s)
	}
	if s.ProjectIndexStale {
		t.Fatalf("projectIndexStale = true, want false")
	}
	if s.SemanticDegraded {
		t.Fatalf("semanticDegraded = true, want false with valid qdrant pointer: %+v", s)
	}
	if s.ProjectIndexModel != "gte-small" {
		t.Fatalf("projectIndexModel = %q, want gte-small", s.ProjectIndexModel)
	}
	if s.LastReindex == nil {
		t.Fatalf("lastReindex = nil, want pointer indexedAt")
	}
}

func TestBuildSearchQdrantDegraded(t *testing.T) {
	store := newReadinessStore(t, "readiness-qdrant-degraded")
	enableSemanticConfig(t, store)

	payload := BuildReadiness(store, Options{})
	s := payload.Search
	if !s.SemanticEnabled {
		t.Fatal("semanticEnabled = false, want true")
	}
	if s.SemanticBackend != "qdrant" {
		t.Fatalf("semanticBackend = %q, want qdrant", s.SemanticBackend)
	}
	if s.ProjectIndexReady {
		t.Fatal("projectIndexReady = true, want false with no pointer/index")
	}
	if !s.SemanticDegraded {
		t.Fatalf("semanticDegraded = false, want true with unavailable qdrant backend: %+v", s)
	}
	if s.SemanticDegradedReason == "" {
		t.Fatal("semanticDegradedReason is empty")
	}
}

func TestBuildSearchSQLiteLegacyFallback(t *testing.T) {
	store := newReadinessStore(t, "readiness-sqlite-legacy")
	enableSemanticConfig(t, store)
	seedReadinessSQLiteIndex(t, store.Root, "gte-small", 384)

	payload := BuildReadiness(store, Options{})
	s := payload.Search
	if !s.SemanticEnabled {
		t.Fatal("semanticEnabled = false, want true")
	}
	if s.SemanticBackend != "qdrant" {
		t.Fatalf("semanticBackend = %q, want resolved default qdrant", s.SemanticBackend)
	}
	if !s.ProjectIndexReady {
		t.Fatalf("projectIndexReady = false, want true via legacy sqlite fallback: %+v", s)
	}
	if !s.SemanticDegraded {
		t.Fatalf("semanticDegraded = false, want true during migration window: %+v", s)
	}
	if s.ProjectIndexModel != "gte-small" {
		t.Fatalf("projectIndexModel = %q, want gte-small", s.ProjectIndexModel)
	}
}

func TestBuildReadinessIncludesDecisionCountsAndCapabilities(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("readiness-decisions"); err != nil {
		t.Fatal(err)
	}
	verifiedAt := time.Date(2026, 7, 23, 10, 0, 0, 0, time.UTC)
	for _, decision := range []*models.DecisionEntry{
		{Title: "Current", Status: models.DecisionStatusAccepted, Sources: []string{"https://example.com"}, Verification: []string{"reviewed"}, VerifiedAt: &verifiedAt},
		{Title: "Draft", Status: models.DecisionStatusDraft},
		{Title: "Historical", Status: models.DecisionStatusRejected},
	} {
		if err := store.Decisions.Create(decision, storage.DecisionCreateOptions{Now: verifiedAt}); err != nil {
			t.Fatal(err)
		}
	}
	legacy := "---\nid: legacy1\ntitle: Legacy\nlayer: project\ncategory: decision\nstatus: active\nsources: []\ntags: []\ncreatedAt: '2026-07-23T10:00:00Z'\nupdatedAt: '2026-07-23T10:00:00Z'\n---\n\nLegacy.\n"
	if err := os.WriteFile(filepath.Join(store.Root, "memory", models.MemoryFileName("legacy1")), []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}

	payload := BuildReadiness(store, Options{})
	if payload.Knowledge.Decisions != (DecisionCounts{Total: 3, Current: 1, Draft: 1, Historical: 1}) {
		t.Fatalf("decision counts = %+v", payload.Knowledge.Decisions)
	}
	if payload.Knowledge.Memories.LegacyDecision != 1 {
		t.Fatalf("legacy Decision Memory count = %d", payload.Knowledge.Memories.LegacyDecision)
	}
	for _, capability := range []string{"system-decisions", "decision-migration"} {
		found := false
		for _, actual := range payload.Capabilities {
			found = found || actual == capability
		}
		if !found {
			t.Fatalf("capabilities %v missing %s", payload.Capabilities, capability)
		}
	}
}
