package adapters

import (
	"context"
	"fmt"
	"os/exec"

	"github.com/howznguyen/knowns/internal/lsp"
)

type RubyLspAdapter struct{ lsp.BaseAdapter }

func NewRubyLspAdapter() *RubyLspAdapter { return &RubyLspAdapter{} }

func (a *RubyLspAdapter) ID() string           { return "ruby" }
func (a *RubyLspAdapter) Name() string         { return "Ruby" }
func (a *RubyLspAdapter) Extensions() []string { return []string{".rb", ".rake", ".gemspec"} }
func (a *RubyLspAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{Name: "ruby-lsp", CheckArgs: []string{"--version"}}}
}
func (a *RubyLspAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{Name: "Ruby 3.1+", CheckCmd: "ruby --version", InstallHint: "Install Ruby 3.1+ from https://www.ruby-lang.org/en/downloads/"}}
}
func (a *RubyLspAdapter) CheckPrerequisites(ctx context.Context) error {
	output, err := commandOutput(ctx, "ruby", "--version")
	if err != nil {
		return err
	}
	return requireMinVersion(output, "Ruby", 3, 1)
}
func (a *RubyLspAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{Command: "gem install ruby-lsp", URL: "https://github.com/Shopify/ruby-lsp", Notes: "Requires Ruby 3.1+"}
}
func (a *RubyLspAdapter) CanInstall() bool                     { return true }
func (a *RubyLspAdapter) RuntimeDeps() []lsp.RuntimeDependency { return nil }
func (a *RubyLspAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	cmd := exec.CommandContext(ctx, "gem", "install", "ruby-lsp")
	if output, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("gem install failed: %w: %s", err, output)
	}
	path, err := exec.LookPath("ruby-lsp")
	if err != nil {
		return "", fmt.Errorf("ruby-lsp installed but not found in PATH: %w", err)
	}
	return path, nil
}
func (a *RubyLspAdapter) InstalledPath() (string, bool) {
	return installedPath(a.ID(), a.RuntimeDeps())
}
func (a *RubyLspAdapter) DefaultArgs() []string { return nil }
func (a *RubyLspAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}
func (a *RubyLspAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *RubyLspAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{"vendor": {}, ".bundle": {}, "tmp": {}})
}
