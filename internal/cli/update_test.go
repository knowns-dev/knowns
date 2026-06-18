package cli

import (
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/util"
)

func TestPackageManagerUpgradeRequiresExternalShellOnWindows(t *testing.T) {
	oldGOOS := updateRuntimeGOOS
	updateRuntimeGOOS = "windows"
	t.Cleanup(func() { updateRuntimeGOOS = oldGOOS })

	packageManagers := []util.InstallMethod{
		util.InstallMethodNPM,
		util.InstallMethodBun,
		util.InstallMethodPNPM,
		util.InstallMethodYarn,
	}
	for _, method := range packageManagers {
		if !packageManagerUpgradeRequiresExternalShell(method) {
			t.Fatalf("expected %s upgrades to require an external shell on Windows", method)
		}
	}

	for _, method := range []util.InstallMethod{util.InstallMethodScript, util.InstallMethodBrew, util.InstallMethodUnknown} {
		if packageManagerUpgradeRequiresExternalShell(method) {
			t.Fatalf("did not expect %s upgrades to require an external shell on Windows", method)
		}
	}
}

func TestPackageManagerUpgradeRunsInProcessOffWindows(t *testing.T) {
	oldGOOS := updateRuntimeGOOS
	updateRuntimeGOOS = "darwin"
	t.Cleanup(func() { updateRuntimeGOOS = oldGOOS })

	if packageManagerUpgradeRequiresExternalShell(util.InstallMethodNPM) {
		t.Fatal("did not expect npm upgrades to require an external shell off Windows")
	}
}

func TestPackageManagerExternalUpdateGuidanceIncludesCommand(t *testing.T) {
	var output strings.Builder
	printPackageManagerExternalUpdateGuidanceTo(&output, util.InstallMethodNPM, "npm i -g knowns")

	got := output.String()
	if !strings.Contains(got, "npm i -g knowns") {
		t.Fatalf("expected guidance to include npm command, got:\n%s", got)
	}
	if !strings.Contains(got, "fresh PowerShell") {
		t.Fatalf("expected guidance to mention fresh PowerShell, got:\n%s", got)
	}
}
