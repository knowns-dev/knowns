package readiness

import (
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/search"
)

func TestLSPStatusFromRuntimeIncludesRuntimeFields(t *testing.T) {
	got := lspStatusFromRuntime(lsp.LanguageRuntimeStatus{
		ID:             lsp.CSharpLanguageID,
		Name:           "C#",
		Enabled:        true,
		Detected:       true,
		Status:         lsp.RuntimeInstallInstalled,
		InstallState:   lsp.RuntimeInstallInstalled,
		RunningState:   lsp.RuntimeRunningUnknown,
		ReadinessState: lsp.RuntimeReadinessUnknown,
		Backend:        lsp.CSharpBackendCSharp,
		BackendSource:  lsp.RuntimeSourceAuto,
		ProjectPath:    "/repo/App.sln",
		ProjectKind:    "sln",
		LogPath:        "/repo/.knowns/logs/lsp/csharp-csharp-ls.log",
		Attempts:       []lsp.BackendAttempt{{Backend: lsp.CSharpBackendCSharp, Status: lsp.BackendAttemptChosen}},
		Owner:          "daemon",
		DaemonState:    "running",
		DaemonPID:      1234,
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
