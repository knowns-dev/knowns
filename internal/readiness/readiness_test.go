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
