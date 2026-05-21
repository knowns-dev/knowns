package adapters

import (
	"context"
	"fmt"
	"os/exec"

	"github.com/howznguyen/knowns/internal/lsp"
)

type TypeScriptAdapter struct{ lsp.BaseAdapter }

func NewTypeScriptAdapter() *TypeScriptAdapter { return &TypeScriptAdapter{} }

func (a *TypeScriptAdapter) ID() string           { return "typescript" }
func (a *TypeScriptAdapter) Name() string         { return "TypeScript" }
func (a *TypeScriptAdapter) Extensions() []string { return []string{".ts", ".tsx", ".js", ".jsx"} }
func (a *TypeScriptAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{Name: "typescript-language-server", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}
}
func (a *TypeScriptAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{Name: "Node.js 18+", CheckCmd: "node --version", InstallHint: "Install Node.js 18+ from https://nodejs.org/"}}
}
func (a *TypeScriptAdapter) CheckPrerequisites(ctx context.Context) error {
	output, err := commandOutput(ctx, "node", "--version")
	if err != nil {
		return err
	}
	return requireMinVersion(output, "Node.js", 18, 0)
}
func (a *TypeScriptAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{Command: "npm install -g typescript-language-server typescript", KnownsCmd: "knowns lsp install typescript", Notes: "Requires Node.js 18+ installed"}
}
func (a *TypeScriptAdapter) CanInstall() bool                     { return true }
func (a *TypeScriptAdapter) RuntimeDeps() []lsp.RuntimeDependency { return nil }
func (a *TypeScriptAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	pm := preferredCmd("bun", "pnpm", "npm")
	args := []string{"install", "-g", "typescript-language-server", "typescript"}
	if pm == "bun" {
		args = []string{"add", "--global", "typescript-language-server", "typescript"}
	}
	cmd := exec.CommandContext(ctx, pm, args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("%s install failed: %w: %s", pm, err, output)
	}
	path, err := exec.LookPath("typescript-language-server")
	if err != nil {
		return "", fmt.Errorf("typescript-language-server installed but not found in PATH: %w", err)
	}
	return path, nil
}
func (a *TypeScriptAdapter) InstalledPath() (string, bool) {
	return installedPath(a.ID(), a.RuntimeDeps())
}
func (a *TypeScriptAdapter) DefaultArgs() []string { return []string{"--stdio"} }
func (a *TypeScriptAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}
func (a *TypeScriptAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *TypeScriptAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{"node_modules": {}, "dist": {}, "build": {}, ".next": {}})
}
