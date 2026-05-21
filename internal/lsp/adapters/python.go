package adapters

import (
	"context"
	"fmt"
	"os/exec"

	"github.com/howznguyen/knowns/internal/lsp"
)

type PythonAdapter struct{ lsp.BaseAdapter }

func NewPythonAdapter() *PythonAdapter { return &PythonAdapter{} }

func (a *PythonAdapter) ID() string           { return "python" }
func (a *PythonAdapter) Name() string         { return "Python" }
func (a *PythonAdapter) Extensions() []string { return []string{".py"} }
func (a *PythonAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{
		{Name: "pylsp", CheckArgs: []string{"--version"}},
		{Name: "pyright-langserver", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}},
	}
}
func (a *PythonAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{Name: "Python 3.9+", CheckCmd: "python3 --version", InstallHint: "Install Python 3.9+ from https://www.python.org/downloads/"}}
}
func (a *PythonAdapter) CheckPrerequisites(ctx context.Context) error {
	output, err := commandOutput(ctx, "python3", "--version")
	if err != nil {
		output, err = commandOutput(ctx, "python", "--version")
		if err != nil {
			return err
		}
	}
	return requireMinVersion(output, "Python", 3, 9)
}
func (a *PythonAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{Command: "pip install python-lsp-server", KnownsCmd: "knowns lsp install python", Notes: "Requires Python 3.9+ installed; pyright-langserver is also supported"}
}
func (a *PythonAdapter) CanInstall() bool                     { return true }
func (a *PythonAdapter) RuntimeDeps() []lsp.RuntimeDependency { return nil }
func (a *PythonAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	pm := preferredCmd("uv", "pip3", "pip")
	args := []string{"install", "python-lsp-server"}
	if pm == "uv" {
		args = []string{"tool", "install", "python-lsp-server"}
	}
	cmd := exec.CommandContext(ctx, pm, args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("%s install failed: %w: %s", pm, err, output)
	}
	path, err := exec.LookPath("pylsp")
	if err != nil {
		return "", fmt.Errorf("pylsp installed but not found in PATH: %w", err)
	}
	return path, nil
}
func (a *PythonAdapter) InstalledPath() (string, bool) { return installedPath(a.ID(), a.RuntimeDeps()) }
func (a *PythonAdapter) DefaultArgs() []string         { return nil }
func (a *PythonAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}
func (a *PythonAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *PythonAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{"__pycache__": {}, ".venv": {}, "venv": {}, ".tox": {}, ".mypy_cache": {}})
}
