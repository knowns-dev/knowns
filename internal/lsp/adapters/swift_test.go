package adapters

import (
	"strings"
	"testing"
)

// TestSwiftAdapterChecksWithHelpNotVersion guards the trap that makes a working
// Swift toolchain report as missing. `sourcekit-lsp --version` exits 64 with
// "Unknown option '--version'", and Detector treats a failing check command as
// an absent binary, so copying the usual `--version` check from a sibling
// adapter silently disables Swift on every machine.
func TestSwiftAdapterChecksWithHelpNotVersion(t *testing.T) {
	binaries := NewSwiftAdapter().Binaries()
	if len(binaries) != 1 {
		t.Fatalf("expected exactly one binary candidate, got %d", len(binaries))
	}
	bin := binaries[0]
	if bin.Name != "sourcekit-lsp" {
		t.Errorf("binary name = %q, want sourcekit-lsp", bin.Name)
	}
	if len(bin.CheckArgs) != 1 || bin.CheckArgs[0] != "--help" {
		t.Errorf("CheckArgs = %v, want [--help]; sourcekit-lsp has no --version flag", bin.CheckArgs)
	}
}

// TestSwiftAdapterIgnoresBothProjectLayouts covers the two build systems
// sourcekit-lsp supports. Swift Package Manager writes to .build and .swiftpm;
// Xcode projects write to DerivedData and Pods. Missing either layout means
// walking build output as if it were source.
func TestSwiftAdapterIgnoresBothProjectLayouts(t *testing.T) {
	adapter := NewSwiftAdapter()
	for _, dir := range []string{".build", ".swiftpm", "DerivedData", "Pods"} {
		if !adapter.IsIgnoredDir(dir) {
			t.Errorf("IsIgnoredDir(%q) = false, want true", dir)
		}
	}
	for _, dir := range []string{"Sources", "Tests", "ChopKit"} {
		if adapter.IsIgnoredDir(dir) {
			t.Errorf("IsIgnoredDir(%q) = true, want false", dir)
		}
	}
}

// TestSwiftAdapterIsNotAutoInstallable records why Swift has no download path:
// sourcekit-lsp is part of the toolchain, so there is no separate artifact to
// fetch or checksum.
func TestSwiftAdapterIsNotAutoInstallable(t *testing.T) {
	adapter := NewSwiftAdapter()
	if adapter.CanInstall() {
		t.Error("CanInstall() = true, want false; sourcekit-lsp ships with the toolchain")
	}
	if _, err := adapter.Install(t.Context(), t.TempDir()); err == nil {
		t.Error("Install() should refuse rather than pretend to download a bundled binary")
	}
	guide := adapter.InstallGuide()
	if !strings.Contains(guide.URL, "swift.org") {
		t.Errorf("InstallGuide().URL = %q, want a swift.org link", guide.URL)
	}
	if guide.KnownsCmd != "" {
		t.Errorf("InstallGuide().KnownsCmd = %q, want empty; there is nothing for knowns to install", guide.KnownsCmd)
	}
}
