//go:build windows

package process

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// ApplyNoWindow prevents short-lived console-subsystem child processes from
// opening or attaching a visible console host when spawned by browser/daemon
// status probes on Windows.
func ApplyNoWindow(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	attr := cmd.SysProcAttr
	if attr == nil {
		attr = &syscall.SysProcAttr{}
		cmd.SysProcAttr = attr
	}
	attr.CreationFlags |= windows.CREATE_NO_WINDOW
	attr.HideWindow = true
}

// NoWindowApplied reports whether ApplyNoWindow configured the Windows process
// attributes expected by runtime probe call sites.
func NoWindowApplied(cmd *exec.Cmd) bool {
	if cmd == nil || cmd.SysProcAttr == nil {
		return false
	}
	return cmd.SysProcAttr.HideWindow && cmd.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW != 0
}
