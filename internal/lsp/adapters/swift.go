package adapters

import (
	"context"
	"fmt"
	"runtime"

	"github.com/howznguyen/knowns/internal/lsp"
)

type SwiftAdapter struct{ lsp.BaseAdapter }

func NewSwiftAdapter() *SwiftAdapter { return &SwiftAdapter{} }

func (a *SwiftAdapter) ID() string   { return "swift" }
func (a *SwiftAdapter) Name() string { return "Swift" }

// Extensions covers only Swift. sourcekit-lsp also serves C, C++, Objective-C
// and Objective-C++ by delegating to clangd, but the clangd adapter already
// claims those and a registry extension may belong to one language.
func (a *SwiftAdapter) Extensions() []string { return []string{".swift"} }

// Binaries checks with `--help` rather than `--version`. sourcekit-lsp has no
// version flag at all: `sourcekit-lsp --version` exits 64 with "Unknown option
// '--version'", and Detector treats a failing check as a missing binary, so the
// obvious choice would report an installed toolchain as absent. `--help` exits
// 0. This also means Version carries help text rather than a version string,
// which the CLI list handles by extracting a version token or printing none.
func (a *SwiftAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{Name: "sourcekit-lsp", CheckArgs: []string{"--help"}}}
}

func (a *SwiftAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{
		Name:        "Swift toolchain",
		CheckCmd:    "swift --version",
		InstallHint: "Install the Swift toolchain from https://swift.org/install, or Xcode on macOS",
	}}
}

// CheckPrerequisites accepts either a toolchain on PATH or, on macOS, one
// inside Xcode. A machine with only Xcode installed has a working
// sourcekit-lsp reachable through xcrun while `swift` itself may be absent
// from PATH, so requiring the PATH binary alone would reject a usable setup.
func (a *SwiftAdapter) CheckPrerequisites(ctx context.Context) error {
	if _, err := commandOutput(ctx, "swift", "--version"); err == nil {
		return nil
	}
	if runtime.GOOS == "darwin" {
		if _, err := commandOutput(ctx, "xcrun", "--find", "sourcekit-lsp"); err == nil {
			return nil
		}
	}
	return fmt.Errorf("Swift toolchain prerequisite failed: install Swift from %s", a.InstallGuide().URL)
}

func (a *SwiftAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{
		Command: "Install the Swift toolchain from https://swift.org/install",
		URL:     "https://swift.org/install",
		Notes:   "sourcekit-lsp ships inside the Swift toolchain and Xcode; it is never downloaded separately",
	}
}

func (a *SwiftAdapter) CanInstall() bool                     { return false }
func (a *SwiftAdapter) RuntimeDeps() []lsp.RuntimeDependency { return nil }

func (a *SwiftAdapter) Install(context.Context, string) (string, error) {
	return "", fmt.Errorf("swift adapter is not auto-installable; install the Swift toolchain from %s", a.InstallGuide().URL)
}

func (a *SwiftAdapter) InstalledPath() (string, bool) { return installedPath(a.ID(), a.RuntimeDeps()) }
func (a *SwiftAdapter) DefaultArgs() []string         { return nil }

func (a *SwiftAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}

func (a *SwiftAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}

// IsIgnoredDir skips build output for both project layouts sourcekit-lsp
// supports: `.build` and `.swiftpm` for Swift Package Manager, `DerivedData`
// and `Pods` for Xcode projects.
func (a *SwiftAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{
		".build":      {},
		".swiftpm":    {},
		"DerivedData": {},
		"Pods":        {},
	})
}
