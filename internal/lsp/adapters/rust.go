package adapters

import (
	"context"
	"fmt"

	"github.com/howznguyen/knowns/internal/lsp"
)

type RustAnalyzerAdapter struct{ lsp.BaseAdapter }

func NewRustAnalyzerAdapter() *RustAnalyzerAdapter { return &RustAnalyzerAdapter{} }

func (a *RustAnalyzerAdapter) ID() string           { return "rust" }
func (a *RustAnalyzerAdapter) Name() string         { return "Rust" }
func (a *RustAnalyzerAdapter) Extensions() []string { return []string{".rs"} }
func (a *RustAnalyzerAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{Name: "rust-analyzer", CheckArgs: []string{"--version"}}}
}
func (a *RustAnalyzerAdapter) Prerequisites() []lsp.Prerequisite            { return nil }
func (a *RustAnalyzerAdapter) CheckPrerequisites(ctx context.Context) error { return nil }
func (a *RustAnalyzerAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{Command: "rustup component add rust-analyzer", KnownsCmd: "knowns lsp install rust", URL: "https://rust-analyzer.github.io/", Notes: "Standalone binaries can be installed by Knowns for supported platforms"}
}
func (a *RustAnalyzerAdapter) CanInstall() bool { return true }
func (a *RustAnalyzerAdapter) RuntimeDeps() []lsp.RuntimeDependency {
	// TODO: update SHA-256 values for the pinned rust-analyzer release assets.
	return []lsp.RuntimeDependency{
		{ID: "2024-01-01", PlatformID: "darwin-arm64", URL: "https://github.com/rust-lang/rust-analyzer/releases/download/2024-01-01/rust-analyzer-aarch64-apple-darwin.gz", SHA256: "TODO", ArchiveType: "binary", BinaryName: "rust-analyzer"},
		{ID: "2024-01-01", PlatformID: "darwin-amd64", URL: "https://github.com/rust-lang/rust-analyzer/releases/download/2024-01-01/rust-analyzer-x86_64-apple-darwin.gz", SHA256: "TODO", ArchiveType: "binary", BinaryName: "rust-analyzer"},
		{ID: "2024-01-01", PlatformID: "linux-amd64", URL: "https://github.com/rust-lang/rust-analyzer/releases/download/2024-01-01/rust-analyzer-x86_64-unknown-linux-gnu.gz", SHA256: "TODO", ArchiveType: "binary", BinaryName: "rust-analyzer"},
		{ID: "2024-01-01", PlatformID: "linux-arm64", URL: "https://github.com/rust-lang/rust-analyzer/releases/download/2024-01-01/rust-analyzer-aarch64-unknown-linux-gnu.gz", SHA256: "TODO", ArchiveType: "binary", BinaryName: "rust-analyzer"},
		{ID: "2024-01-01", PlatformID: "windows-amd64", URL: "https://github.com/rust-lang/rust-analyzer/releases/download/2024-01-01/rust-analyzer-x86_64-pc-windows-msvc.gz", SHA256: "TODO", ArchiveType: "binary", BinaryName: "rust-analyzer"},
	}
}
func (a *RustAnalyzerAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	installer := lsp.NewInstaller(targetDir)
	path, err := installer.Install(ctx, a)
	if err != nil {
		return "", fmt.Errorf("install rust-analyzer: %w", err)
	}
	return path, nil
}
func (a *RustAnalyzerAdapter) InstalledPath() (string, bool) {
	return installedPath(a.ID(), a.RuntimeDeps())
}
func (a *RustAnalyzerAdapter) DefaultArgs() []string { return nil }
func (a *RustAnalyzerAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}
func (a *RustAnalyzerAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *RustAnalyzerAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{"target": {}})
}
