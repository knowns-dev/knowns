package cli

import (
	"bytes"
	"reflect"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
)

func TestLspRowFromRuntimeIncludesRuntimeFields(t *testing.T) {
	row := lspRowFromRuntime(lsp.LanguageRuntimeStatus{
		ID:                     lsp.CSharpLanguageID,
		Name:                   "C#",
		Enabled:                true,
		Detected:               true,
		Status:                 lsp.RuntimeInstallInstalled,
		InstallState:           lsp.RuntimeInstallInstalled,
		RunningState:           lsp.RuntimeRunningUnknown,
		ReadinessState:         lsp.RuntimeReadinessUnknown,
		Binary:                 "csharp-ls",
		Source:                 lsp.RuntimeSourcePATH,
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
	if !row.CapabilitiesKnown || !reflect.DeepEqual(row.MissingCapabilities, []string{lsp.CapabilityDefinition}) || !reflect.DeepEqual(row.AdvertisedCapabilities, []string{lsp.CapabilityDocumentSymbols}) {
		t.Fatalf("capability fields missing: %#v", row)
	}
}

func TestConfirmLSPInstallRequiresYesForNonInteractiveInput(t *testing.T) {
	cmd := newLspInstallCmd()
	var stderr bytes.Buffer
	cmd.SetErr(&stderr)
	cmd.SetIn(strings.NewReader("yes\n"))
	err := confirmLSPInstall(cmd, lsp.InstallSelector{Latest: true}, false)
	if err == nil || !strings.Contains(err.Error(), "requires --yes") {
		t.Fatalf("confirmation error = %v", err)
	}
	if !strings.Contains(stderr.String(), "WARNING") || !strings.Contains(stderr.String(), "latest") {
		t.Fatalf("warning missing: %q", stderr.String())
	}
}

func TestConfirmLSPInstallYesAllowsExplicitVersion(t *testing.T) {
	cmd := newLspInstallCmd()
	var stderr bytes.Buffer
	cmd.SetErr(&stderr)
	if err := confirmLSPInstall(cmd, lsp.InstallSelector{Version: "v2.0.0"}, true); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stderr.String(), "v2.0.0") {
		t.Fatalf("warning does not name selected version: %q", stderr.String())
	}
}

func TestLSPInstallFlagsAreMutuallyExclusive(t *testing.T) {
	cmd := newLspInstallCmd()
	cmd.SetArgs([]string{"json", "--latest", "--version", "1.0.0", "--yes"})
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "none of the others") {
		t.Fatalf("mutual exclusion error = %v", err)
	}
}
