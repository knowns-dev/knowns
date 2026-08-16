//go:build windows

package qdrantruntime

import (
	"os"
	"os/exec"
	"syscall"
)

func setSysProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// Windows FindProcess does not guarantee liveness. Signal(0) is unsupported,
	// so treat the PID as potentially alive; stale cleanup remains best-effort.
	_ = process.Release()
	return true
}

func signalTerm(process *os.Process) error {
	return process.Kill()
}
