//go:build windows

package search

import "os"

// isProcessAlive reports whether a PID recorded in a lock file still belongs to
// a running process.
func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// Windows FindProcess does not guarantee liveness and Signal(0) is
	// unsupported, so treat the PID as potentially alive and let the caller's
	// staleness window reclaim the lock instead.
	_ = process.Release()
	return true
}
