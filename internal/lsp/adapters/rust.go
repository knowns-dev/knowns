package adapters

import (
	"context"
	"fmt"
	"os/exec"

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
func (a *RustAnalyzerAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{Name: "rustup", CheckCmd: "rustup --version", InstallHint: "Install Rust via https://rustup.rs/"}}
}
func (a *RustAnalyzerAdapter) CheckPrerequisites(ctx context.Context) error {
	_, err := commandOutput(ctx, "rustup", "--version")
	return err
}
func (a *RustAnalyzerAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{Command: "rustup component add rust-analyzer", KnownsCmd: "knowns lsp install rust", URL: "https://rust-analyzer.github.io/", Notes: "Requires rustup installed"}
}
func (a *RustAnalyzerAdapter) CanInstall() bool                     { return true }
func (a *RustAnalyzerAdapter) RuntimeDeps() []lsp.RuntimeDependency { return nil }
func (a *RustAnalyzerAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	cmd := exec.CommandContext(ctx, "rustup", "component", "add", "rust-analyzer")
	if output, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("rustup install failed: %w: %s", err, output)
	}
	path, err := exec.LookPath("rust-analyzer")
	if err != nil {
		return "", fmt.Errorf("rust-analyzer installed but not found in PATH: %w", err)
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
