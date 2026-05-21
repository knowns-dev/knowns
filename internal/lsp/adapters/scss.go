package adapters

import (
	"context"
	"fmt"
	"os/exec"

	"github.com/howznguyen/knowns/internal/lsp"
)

type ScssAdapter struct{ lsp.BaseAdapter }

func NewScssAdapter() *ScssAdapter { return &ScssAdapter{} }

func (a *ScssAdapter) ID() string           { return "scss" }
func (a *ScssAdapter) Name() string         { return "SCSS/Sass/CSS" }
func (a *ScssAdapter) Extensions() []string { return []string{".scss", ".sass", ".css"} }
func (a *ScssAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{Name: "some-sass-language-server", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}
}
func (a *ScssAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{Name: "Node.js 18+", CheckCmd: "node --version", InstallHint: "Install Node.js 18+ from https://nodejs.org/"}}
}
func (a *ScssAdapter) CheckPrerequisites(ctx context.Context) error {
	output, err := commandOutput(ctx, "node", "--version")
	if err != nil {
		return err
	}
	return requireMinVersion(output, "Node.js", 18, 0)
}
func (a *ScssAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{Command: "npm install -g some-sass-language-server", KnownsCmd: "knowns lsp install scss", Notes: "Requires Node.js 18+; handles .scss, .sass, and .css files"}
}
func (a *ScssAdapter) CanInstall() bool                     { return true }
func (a *ScssAdapter) RuntimeDeps() []lsp.RuntimeDependency { return nil }
func (a *ScssAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	pm := preferredCmd("bun", "pnpm", "npm")
	args := []string{"install", "-g", "some-sass-language-server"}
	if pm == "bun" {
		args = []string{"add", "--global", "some-sass-language-server"}
	}
	cmd := exec.CommandContext(ctx, pm, args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("%s install failed: %w: %s", pm, err, output)
	}
	path, err := exec.LookPath("some-sass-language-server")
	if err != nil {
		return "", fmt.Errorf("some-sass-language-server installed but not found in PATH: %w", err)
	}
	return path, nil
}
func (a *ScssAdapter) InstalledPath() (string, bool) { return installedPath(a.ID(), a.RuntimeDeps()) }
func (a *ScssAdapter) DefaultArgs() []string         { return []string{"--stdio"} }
func (a *ScssAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}
func (a *ScssAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *ScssAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{"node_modules": {}, "dist": {}, "build": {}, ".next": {}})
}
