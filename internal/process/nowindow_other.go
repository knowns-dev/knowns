//go:build !windows

package process

import "os/exec"

// ApplyNoWindow is a no-op on non-Windows platforms.
func ApplyNoWindow(cmd *exec.Cmd) {}

// NoWindowApplied reports whether ApplyNoWindow should set Windows-specific
// process attributes on this platform.
func NoWindowApplied(cmd *exec.Cmd) bool { return false }
