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

// TestNameOfSameFileResolvesAnUnlistedSpelling covers the branch that RUNNER~1
// takes on Windows: a name the parent's listing never enumerates, which the
// filesystem still opens. No portable filesystem creates such an alias, so the
// listing is narrowed by hand and a hard link supplies the second spelling of
// one file. The real 8.3 shape is only exercised on the Windows runners.
func TestNameOfSameFileResolvesAnUnlistedSpelling(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "Target")
	if err := os.WriteFile(target, []byte("x"), 0644); err != nil {
		t.Fatalf("write target: %v", err)
	}
	alias := filepath.Join(dir, "alias-not-in-listing")
	if err := os.Link(target, alias); err != nil {
		t.Skipf("filesystem does not support hard links: %v", err)
	}

	all, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	// Drop the alias, leaving the listing the walk would see for a name the
	// directory does not enumerate.
	var listed []os.DirEntry
	for _, entry := range all {
		if entry.Name() != filepath.Base(alias) {
			listed = append(listed, entry)
		}
	}

	requested, err := os.Lstat(alias)
	if err != nil {
		t.Fatalf("lstat alias: %v", err)
	}
	got, ok := nameOfSameFile(dir, listed, requested)
	if !ok {
		t.Fatal("nameOfSameFile found no entry naming the same file")
	}
	if got != "Target" {
		t.Fatalf("nameOfSameFile = %q, want %q", got, "Target")
	}
}

// TestNameOfSameFileRejectsAnUnrelatedEntry keeps the scan from resolving a
// name onto whatever sibling happens to be listed.
func TestNameOfSameFileRejectsAnUnrelatedEntry(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"one", "two"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0644); err != nil {
			t.Fatalf("write %q: %v", name, err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	requested, err := os.Lstat(filepath.Join(dir, "one"))
	if err != nil {
		t.Fatalf("lstat: %v", err)
	}

	var others []os.DirEntry
	for _, entry := range entries {
		if entry.Name() == "two" {
			others = append(others, entry)
		}
	}
	if got, ok := nameOfSameFile(dir, others, requested); ok {
		t.Fatalf("nameOfSameFile = %q, want no match", got)
	}
}
