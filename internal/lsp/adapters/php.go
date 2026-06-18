package adapters

import (
	"context"

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
func (a *IntelephenseAdapter) CanInstall() bool { return true }
func (a *IntelephenseAdapter) RuntimeDeps() []lsp.RuntimeDependency {
	return []lsp.RuntimeDependency{{
		ID:          "intelephense",
		Version:     "latest",
		Source:      "npm",
		ArchiveType: "npm",
		BinaryName:  "intelephense",
		PackageName: "intelephense",
	}}
}
func (a *IntelephenseAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	return lsp.NewInstaller(targetDir).Install(ctx, a)
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
