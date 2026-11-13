// Package testutil holds helpers shared by tests across packages.
package testutil

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// SetHome points the user home at dir for the rest of the test, on every OS.
// os.UserHomeDir reads HOME on unix but USERPROFILE on Windows, so a test that
// sets HOME alone still reads and writes the real home of whoever runs it
// there (settings store, install metadata, runtime root), and its outcome then
// depends on what earlier tests left behind. HOMEDRIVE and HOMEPATH are set too
// on Windows for code that rebuilds the home from them.
func SetHome(t testing.TB, dir string) {
	t.Helper()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	if runtime.GOOS == "windows" {
		volume := filepath.VolumeName(dir)
		t.Setenv("HOMEDRIVE", volume)
		t.Setenv("HOMEPATH", strings.TrimPrefix(dir, volume))
	}
}

// TempHome points the user home at a fresh t.TempDir() and returns it.
func TempHome(t testing.TB) string {
	t.Helper()
	dir := t.TempDir()
	SetHome(t, dir)
	return dir
}
