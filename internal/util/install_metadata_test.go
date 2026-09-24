package util

import (
	"os"
	"path/filepath"
	"testing"
)

// install.sh writes linkPaths and uninstall.sh reads them back. A self-update
// in between rewrites install.json through SaveInstallMetadata, so the links
// must survive that round trip or uninstall leaves them behind.
func TestInstallMetadataKeepsScriptLinkPaths(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	written := `{
  "method": "script",
  "managedBy": "knowns-script",
  "binaryPath": "/home/u/.knowns/bin/knowns",
  "linkPaths": ["/home/u/.local/bin/knowns", "/home/u/.local/bin/kn"],
  "version": "0.34.0"
}
`
	path := filepath.Join(home, ".knowns", "install.json")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(written), 0644); err != nil {
		t.Fatal(err)
	}

	meta, err := LoadInstallMetadata()
	if err != nil {
		t.Fatal(err)
	}
	meta.Version = "0.35.0"
	if err := SaveInstallMetadata(meta); err != nil {
		t.Fatal(err)
	}

	reloaded, err := LoadInstallMetadata()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/home/u/.local/bin/knowns", "/home/u/.local/bin/kn"}
	if len(reloaded.LinkPaths) != len(want) {
		t.Fatalf("LinkPaths = %v, want %v", reloaded.LinkPaths, want)
	}
	for i := range want {
		if reloaded.LinkPaths[i] != want[i] {
			t.Fatalf("LinkPaths = %v, want %v", reloaded.LinkPaths, want)
		}
	}
}

// os.Executable returns the symlink on macOS. A script install linked into
// /opt/homebrew/bin must still be detected by its real ~/.knowns/bin path,
// or `knowns update` shells out to a brew that never installed it.
func TestDetectInstallMethodFollowsInstallerLink(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	t.Setenv("HOME", home)
	t.Setenv("npm_config_user_agent", "")

	binDir := filepath.Join(home, ".knowns", "bin")
	linkDir := filepath.Join(root, "opt", "homebrew", "bin")
	for _, dir := range []string{binDir, linkDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	binary := filepath.Join(binDir, "knowns")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(linkDir, "knowns")
	if err := os.Symlink(binary, link); err != nil {
		t.Fatal(err)
	}

	if got, _ := detectInstallMethodFor(link); got != InstallMethodScript {
		t.Fatalf("detectInstallMethodFor(link) = %q, want %q", got, InstallMethodScript)
	}

	// A real Homebrew install resolves into the Cellar and stays brew.
	cellar := filepath.Join(root, "opt", "homebrew", "Cellar", "knowns", "1.0.0", "bin")
	if err := os.MkdirAll(cellar, 0755); err != nil {
		t.Fatal(err)
	}
	brewBinary := filepath.Join(cellar, "knowns")
	if err := os.WriteFile(brewBinary, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
	brewLink := filepath.Join(linkDir, "knowns-brew")
	if err := os.Symlink(brewBinary, brewLink); err != nil {
		t.Fatal(err)
	}
	if got, _ := detectInstallMethodFor(brewLink); got != InstallMethodBrew {
		t.Fatalf("detectInstallMethodFor(brew link) = %q, want %q", got, InstallMethodBrew)
	}
}
