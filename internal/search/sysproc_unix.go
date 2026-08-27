//go:build !windows

package search

import "syscall"

// isProcessAlive reports whether a PID recorded in a lock file still belongs to
// a running process. Signal 0 performs the permission and existence checks
// without delivering anything.
func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}
