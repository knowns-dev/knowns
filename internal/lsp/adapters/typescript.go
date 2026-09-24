package adapters

import (
	"context"
	"strings"

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
func (a *TypeScriptAdapter) CanInstall() bool { return true }
func (a *TypeScriptAdapter) RuntimeDeps() []lsp.RuntimeDependency {
	return []lsp.RuntimeDependency{{
		ID:          "typescript-language-server",
		Version:     "latest",
		Source:      "npm",
		ArchiveType: "npm",
		BinaryName:  "typescript-language-server",
		PackageName: "typescript-language-server",
		Packages:    []string{"typescript-language-server", "typescript"},
	}}
}
func (a *TypeScriptAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	return lsp.NewInstaller(targetDir).Install(ctx, a)
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

// DocumentSyncForPath sends the language identifier tsserver expects for each
// file. This adapter serves four extensions under one registry ID, and tsserver
// chooses the script kind from languageId rather than from the file name. Sent
// the registry ID "typescript", a .tsx file is parsed as plain TypeScript, so
// its JSX becomes syntax errors and its components come back as <unknown>
// symbols.
func (a *TypeScriptAdapter) DocumentSyncForPath(path string) lsp.DocumentSyncOptions {
	return lsp.DocumentSyncOptions{LanguageID: typeScriptLanguageID(path)}
}

func typeScriptLanguageID(path string) string {
	normalized := strings.ToLower(strings.ReplaceAll(path, `\`, "/"))
	switch {
	case strings.HasSuffix(normalized, ".tsx"):
		return "typescriptreact"
	case strings.HasSuffix(normalized, ".jsx"):
		return "javascriptreact"
	case strings.HasSuffix(normalized, ".js"):
		return "javascript"
	default:
		return "typescript"
	}
}
