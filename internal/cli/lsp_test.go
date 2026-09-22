package cli

import (
	"bytes"
	"os"
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

func TestLspListGroupBucketsEveryStatus(t *testing.T) {
	for _, tc := range []struct {
		name string
		row  lspListRow
		want int
	}{
		{"installed", lspListRow{Status: lsp.RuntimeInstallInstalled}, lspGroupReady},
		{"running", lspListRow{Status: lsp.RuntimeRunningRunning}, lspGroupReady},
		{"starting", lspListRow{Status: lsp.RuntimeRunningStarting}, lspGroupReady},
		{"not installed", lspListRow{Status: lsp.RuntimeInstallNotInstalled}, lspGroupMissing},
		{"disabled", lspListRow{Status: lsp.RuntimeInstallDisabled}, lspGroupDisabled},
		{"crashed", lspListRow{Status: lsp.RuntimeRunningCrashed}, lspGroupProblem},
		{"degraded", lspListRow{Status: lsp.RuntimeStatusDegraded}, lspGroupProblem},
		// An install error resolves to a not_installed status upstream, so the
		// error field is the only thing separating a real failure from a server
		// the user simply never installed.
		{"install error", lspListRow{Status: lsp.RuntimeInstallNotInstalled, InstallError: "checksum mismatch"}, lspGroupProblem},
		{"update error", lspListRow{Status: lsp.RuntimeInstallInstalled, UpdateError: "download failed"}, lspGroupProblem},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := lspListGroup(tc.row); got != tc.want {
				t.Errorf("lspListGroup(%+v) = %d, want %d", tc.row, got, tc.want)
			}
		})
	}
}

// TestLspShortVersionRejectsProse covers the defect the compact layout exposed:
// Version holds raw `--version` output, and an adapter whose binary has no
// version flag probes with `--help`, which put a sentence of documentation into
// the version column.
func TestLspShortVersionRejectsProse(t *testing.T) {
	for raw, want := range map[string]string{
		"5.6.0":                            "5.6.0",
		"3.10.8":                           "3.10.8",
		"golang.org/x/tools/gopls v0.22.0": "v0.22.0",
		"Apple clangd version 17.0.0 (clang-1700.6.3.2)":              "17.0.0",
		"csharp-ls, 0.25.0 (Punia)+19a9574d7577521555f49bf49e94688a3": "0.25.0",
		"2026-02-08": "2026-02-08",
		"OVERVIEW: Language Server Protocol implementation for Swift": "",
		"":    "",
		"   ": "",
	} {
		if got := lspShortVersion(raw); got != want {
			t.Errorf("lspShortVersion(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestPrintLspListCompactOmitsEmptyGroups(t *testing.T) {
	t.Cleanup(func() { SetPlainOutput(false) })
	SetPlainOutput(true)

	out := captureLspList(t, []lspListRow{
		{ID: "go", Status: lsp.RuntimeInstallInstalled, Binary: "gopls", Source: lsp.RuntimeSourcePATH, Owner: "daemon", DaemonState: "running"},
		{ID: "rust", Status: lsp.RuntimeInstallNotInstalled, InstallCmd: "knowns lsp install rust"},
	})

	for _, want := range []string{"Ready", "Not installed", "gopls", "knowns lsp install rust", lspListLogTemplate} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
	for _, unwanted := range []string{"Problems", "Disabled"} {
		if strings.Contains(out, unwanted) {
			t.Errorf("empty group %q should not render:\n%s", unwanted, out)
		}
	}
	if hasANSI(out) {
		t.Errorf("plain mode must not emit ANSI:\n%q", out)
	}
	// The old table ran to 295 columns. Anything near that defeats the change.
	for _, line := range strings.Split(out, "\n") {
		if len(line) > 100 {
			t.Errorf("line exceeds 100 columns (%d): %q", len(line), line)
		}
	}
}

func captureLspList(t *testing.T, rows []lspListRow) string {
	t.Helper()
	orig := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	printErr := printLspListCompact(rows)
	w.Close()
	os.Stdout = orig
	if printErr != nil {
		t.Fatalf("printLspListCompact: %v", printErr)
	}
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(r); err != nil {
		t.Fatal(err)
	}
	return buf.String()
}
