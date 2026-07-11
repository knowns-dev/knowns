package cli

import (
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
)

func TestLspRowFromRuntimeIncludesRuntimeFields(t *testing.T) {
	row := lspRowFromRuntime(lsp.LanguageRuntimeStatus{
		ID:             lsp.CSharpLanguageID,
		Name:           "C#",
		Enabled:        true,
		Detected:       true,
		Status:         lsp.RuntimeInstallInstalled,
		InstallState:   lsp.RuntimeInstallInstalled,
		RunningState:   lsp.RuntimeRunningUnknown,
		ReadinessState: lsp.RuntimeReadinessUnknown,
		Binary:         "csharp-ls",
		Source:         lsp.RuntimeSourcePATH,
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
	if row.Backend != lsp.CSharpBackendCSharp || row.BackendSource != lsp.RuntimeSourceAuto {
		t.Fatalf("backend fields missing: %#v", row)
	}
	if row.InstallState != lsp.RuntimeInstallInstalled || row.RunningState != lsp.RuntimeRunningUnknown || row.ReadinessState != lsp.RuntimeReadinessUnknown {
		t.Fatalf("state fields missing: %#v", row)
	}
	if row.ProjectPath == "" || row.LogPath == "" || len(row.Attempts) != 1 {
		t.Fatalf("project/log/attempt fields missing: %#v", row)
	}
	if row.Owner != "daemon" || row.DaemonState != "running" || row.DaemonPID != 1234 {
		t.Fatalf("daemon fields missing: %#v", row)
	}
}
