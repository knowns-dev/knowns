package safepath

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveRejectsTraversalAndPlatformAlternatePaths(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{
		"../outside",
		`..\outside`,
		filepath.Join(filepath.Dir(root), "outside"),
		`C:\outside`,
		`\\server\share\outside`,
		`\\?\C:\outside`,
	} {
		if got, err := Resolve(root, path); err == nil {
			t.Errorf("Resolve(%q) = %q, want error", path, got)
		}
	}
}

func TestResolveAllowsContainedPathAndRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	inside, err := Resolve(root, "guides/setup.md")
	if err != nil || inside != filepath.Join(root, "guides", "setup.md") {
		t.Fatalf("contained path = %q, err=%v", inside, err)
	}

	outside := t.TempDir()
	link := filepath.Join(root, "linked")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if got, err := Resolve(root, "linked/escape.md"); err == nil {
		t.Fatalf("symlink escape resolved to %q", got)
	}
}

func TestResolveProjectAllowsOnlyContainedAbsolutePath(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "main.go")
	if got, err := ResolveProject(root, inside); err != nil || got != inside {
		t.Fatalf("contained absolute path = %q, err=%v", got, err)
	}
	outside := filepath.Join(filepath.Dir(root), "outside.go")
	if got, err := ResolveProject(root, outside); err == nil {
		t.Fatalf("outside absolute path resolved to %q", got)
	}
}
