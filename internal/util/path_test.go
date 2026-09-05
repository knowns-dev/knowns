package util

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// caseInsensitiveFS reports whether dir lives on a filesystem that treats two
// spellings of one name as the same entry.
func caseInsensitiveFS(t *testing.T, dir string) bool {
	t.Helper()
	probe := filepath.Join(dir, "CaseProbe")
	if err := os.Mkdir(probe, 0755); err != nil {
		t.Fatalf("create probe dir: %v", err)
	}
	defer os.RemoveAll(probe)
	_, err := os.Stat(filepath.Join(dir, "caseprobe"))
	return err == nil
}

func TestCanonicalPathKeepsExistingSpelling(t *testing.T) {
	tmpDir := t.TempDir()
	dir := filepath.Join(tmpDir, "Projects")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	if got := CanonicalPath(dir); got != dir {
		t.Fatalf("CanonicalPath(%q) = %q, want unchanged", dir, got)
	}
}

func TestCanonicalPathResolvesOnDiskCasing(t *testing.T) {
	tmpDir := t.TempDir()
	if !caseInsensitiveFS(t, tmpDir) {
		t.Skip("filesystem is case-sensitive; the two spellings are different folders")
	}

	dir := filepath.Join(tmpDir, "Projects")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	lower := filepath.Join(tmpDir, "projects")
	if got := CanonicalPath(lower); got != dir {
		t.Fatalf("CanonicalPath(%q) = %q, want %q", lower, got, dir)
	}
}

func TestCanonicalPathKeepsDistinctDirectoriesApart(t *testing.T) {
	tmpDir := t.TempDir()
	if caseInsensitiveFS(t, tmpDir) {
		t.Skip("filesystem is case-insensitive; both spellings name one folder")
	}

	upper := filepath.Join(tmpDir, "Projects")
	lower := filepath.Join(tmpDir, "projects")
	for _, dir := range []string{upper, lower} {
		if err := os.Mkdir(dir, 0755); err != nil {
			t.Fatalf("mkdir %q: %v", dir, err)
		}
	}

	if got := CanonicalPath(upper); got != upper {
		t.Fatalf("CanonicalPath(%q) = %q, want unchanged", upper, got)
	}
	if got := CanonicalPath(lower); got != lower {
		t.Fatalf("CanonicalPath(%q) = %q, want unchanged", lower, got)
	}
}

func TestCanonicalPathKeepsMissingComponents(t *testing.T) {
	tmpDir := t.TempDir()
	dir := filepath.Join(tmpDir, "Projects")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	missing := filepath.Join(dir, "not-there", "deeper")
	if got := CanonicalPath(missing); got != missing {
		t.Fatalf("CanonicalPath(%q) = %q, want unchanged", missing, got)
	}
}

func TestCanonicalPathEmptyInput(t *testing.T) {
	if got := CanonicalPath(""); got != "" {
		t.Fatalf("CanonicalPath(\"\") = %q, want empty", got)
	}
}

// TestCanonicalPathResolvesPastAnUnlistableComponent locks the behaviour that
// broke on Windows CI, where TMP arrives as a path containing the 8.3 short
// name RUNNER~1: the component opens fine but never appears in its parent's
// directory listing, so resolution has to carry on past it instead of leaving
// the whole remainder of the path as the caller spelled it.
//
// An execute-only directory reproduces the same shape portably: it can be
// traversed but not listed.
func TestCanonicalPathResolvesPastAnUnlistableComponent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permissions do not gate listing on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root reads a directory regardless of its mode")
	}

	tmpDir := t.TempDir()
	if !caseInsensitiveFS(t, tmpDir) {
		t.Skip("filesystem is case-sensitive; the two spellings are different folders")
	}

	// "inner" cannot be found in opaque's listing, standing in for RUNNER~1;
	// the component below it still has to resolve.
	opaque := filepath.Join(tmpDir, "opaque")
	inner := filepath.Join(opaque, "inner")
	dir := filepath.Join(inner, "Projects")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Execute-only: traversable, unlistable. Restored so t.TempDir can clean up.
	if err := os.Chmod(opaque, 0111); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(opaque, 0755) })

	lower := filepath.Join(inner, "projects")
	if got := CanonicalPath(lower); got != dir {
		t.Fatalf("CanonicalPath(%q) = %q, want %q", lower, got, dir)
	}
}
