//go:build windows

package runtimequeue

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

const windowsStillActive = 259

// setSysProcAttr detaches the spawned daemon from the parent CLI process so
// closing the terminal or sending Ctrl+C to the CLI does not kill the daemon.
//   - CREATE_NEW_PROCESS_GROUP: don't receive Ctrl+C broadcast from parent group
//   - DETACHED_PROCESS: don't inherit the parent console
//   - HideWindow: avoid flashing a console window
func setSysProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS,
		HideWindow:    true,
	}
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)

	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	return code == windowsStillActive
}

func forceKillDaemon() error {
	pid, err := readPID()
	if err != nil {
		return err
	}
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	return windows.TerminateProcess(handle, 1)
}
