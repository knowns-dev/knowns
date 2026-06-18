package adapters

import (
	"context"

	"github.com/howznguyen/knowns/internal/lsp"
)

type RoslynAdapter struct{ lsp.BaseAdapter }

func NewRoslynAdapter() *RoslynAdapter { return &RoslynAdapter{} }

func (a *RoslynAdapter) ID() string           { return "csharp" }
func (a *RoslynAdapter) Name() string         { return "C#" }
func (a *RoslynAdapter) Extensions() []string { return []string{".cs"} }
func (a *RoslynAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{Name: "roslyn-ls", CheckArgs: []string{"--version"}}, {Name: "csharp-ls", CheckArgs: []string{"--version"}}, {Name: "omnisharp", Args: []string{"--languageserver"}, CheckArgs: []string{"--version"}}}
}
func (a *RoslynAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{Name: ".NET SDK 10+", CheckCmd: "dotnet --version", InstallHint: "Install .NET SDK 10+ from https://dotnet.microsoft.com/download"}}
}
func (a *RoslynAdapter) CheckPrerequisites(ctx context.Context) error {
	output, err := commandOutput(ctx, "dotnet", "--version")
	if err != nil {
		return err
	}
	return requireMinVersion(output, ".NET SDK", 10, 0)
}
func (a *RoslynAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{Command: "knowns lsp install csharp", KnownsCmd: "knowns lsp install csharp", URL: "https://www.nuget.org/packages/Microsoft.CodeAnalysis.LanguageServer.neutral", Notes: "Downloads Roslyn LS from NuGet and requires .NET SDK 10+"}
}
func (a *RoslynAdapter) CanInstall() bool { return true }
func (a *RoslynAdapter) RuntimeDeps() []lsp.RuntimeDependency {
	return []lsp.RuntimeDependency{lsp.CSharpRoslynRuntimeDependency(lsp.Config{})}
}
func (a *RoslynAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	return lsp.NewInstaller(targetDir).Install(ctx, a)
}
func (a *RoslynAdapter) InstalledPath() (string, bool) { return installedPath(a.ID(), a.RuntimeDeps()) }
func (a *RoslynAdapter) DefaultArgs() []string         { return nil }
func (a *RoslynAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}
func (a *RoslynAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *RoslynAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{"bin": {}, "obj": {}, ".vs": {}, "packages": {}})
}
