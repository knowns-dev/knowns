//go:build windows

package process

import "testing"

func TestCommandContextAppliesNoWindow(t *testing.T) {
	cmd := Command("dotnet", "--version")
	if !NoWindowApplied(cmd) {
		t.Fatalf("Command did not apply Windows no-window process attributes: %#v", cmd.SysProcAttr)
	}
}
