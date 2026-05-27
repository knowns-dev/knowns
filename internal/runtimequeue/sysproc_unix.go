//go:build !windows

package runtimequeue

import (
	"os/exec"
	"syscall"
)

func setSysProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

func forceKillDaemon() error {
	pid, err := readPID()
	if err != nil {
		return err
	}
	return syscall.Kill(pid, syscall.SIGKILL)
}
