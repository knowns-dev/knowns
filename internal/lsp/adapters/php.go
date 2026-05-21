package adapters

import (
	"context"
	"fmt"
	"os/exec"

	"github.com/howznguyen/knowns/internal/lsp"
)

type IntelephenseAdapter struct{ lsp.BaseAdapter }

func NewIntelephenseAdapter() *IntelephenseAdapter { return &IntelephenseAdapter{} }

func (a *IntelephenseAdapter) ID() string           { return "php" }
func (a *IntelephenseAdapter) Name() string         { return "PHP" }
func (a *IntelephenseAdapter) Extensions() []string { return []string{".php"} }
func (a *IntelephenseAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{Name: "intelephense", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}
}
func (a *IntelephenseAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{Name: "Node.js 18+", CheckCmd: "node --version", InstallHint: "Install Node.js 18+ from https://nodejs.org/"}}
}
func (a *IntelephenseAdapter) CheckPrerequisites(ctx context.Context) error {
	output, err := commandOutput(ctx, "node", "--version")
	if err != nil {
		return err
	}
	return requireMinVersion(output, "Node.js", 18, 0)
}
func (a *IntelephenseAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{Command: "npm install -g intelephense", KnownsCmd: "knowns lsp install php", URL: "https://intelephense.com/", Notes: "Requires Node.js 18+"}
}
func (a *IntelephenseAdapter) CanInstall() bool                     { return true }
func (a *IntelephenseAdapter) RuntimeDeps() []lsp.RuntimeDependency { return nil }
func (a *IntelephenseAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	pm := preferredCmd("bun", "pnpm", "npm")
	args := []string{"install", "-g", "intelephense"}
	if pm == "bun" {
		args = []string{"add", "--global", "intelephense"}
	}
	cmd := exec.CommandContext(ctx, pm, args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("%s install failed: %w: %s", pm, err, output)
	}
	path, err := exec.LookPath("intelephense")
	if err != nil {
		return "", fmt.Errorf("intelephense installed but not found in PATH: %w", err)
	}
	return path, nil
}
func (a *IntelephenseAdapter) InstalledPath() (string, bool) {
	return installedPath(a.ID(), a.RuntimeDeps())
}
func (a *IntelephenseAdapter) DefaultArgs() []string { return []string{"--stdio"} }
func (a *IntelephenseAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}
func (a *IntelephenseAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *IntelephenseAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{"vendor": {}, "node_modules": {}, "storage": {}, "bootstrap/cache": {}})
}
