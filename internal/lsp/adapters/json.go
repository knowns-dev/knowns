package adapters

import (
	"context"

	"github.com/howznguyen/knowns/internal/lsp"
)

const (
	jsonLanguageServerVersion   = "1.3.4"
	jsonLanguageServerIntegrity = "sha512-+ghebnslXk6fVDySBrT0BVqozLDdmKY/qxgkDD4JtOQcU2vXc3e7jh7YyMxvuvE93E9OLvBqUrvajttj8xf3BA=="

	jsonPathPriority         = 100
	jsonDetectionBanPriority = 200
)

// JSONAdapter provides JSON and JSONC intelligence through the VS Code JSON
// language server.
type JSONAdapter struct{ lsp.BaseAdapter }

func NewJSONAdapter() *JSONAdapter { return &JSONAdapter{} }

func (a *JSONAdapter) ID() string           { return "json" }
func (a *JSONAdapter) Name() string         { return "JSON/JSONC" }
func (a *JSONAdapter) Extensions() []string { return []string{".json", ".jsonc"} }
func (a *JSONAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{
		Name: "vscode-json-languageserver",
		Args: []string{"--stdio"},
	}}
}
func (a *JSONAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{
		Name:        "Node.js",
		CheckCmd:    "node --version",
		InstallHint: "Install Node.js from https://nodejs.org/",
	}}
}
func (a *JSONAdapter) CheckPrerequisites(ctx context.Context) error {
	return checkBinary(ctx, "node", "--version")
}
func (a *JSONAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{
		Command:   "npm install -g vscode-json-languageserver@" + jsonLanguageServerVersion,
		KnownsCmd: "knowns lsp install json",
		URL:       "https://www.npmjs.com/package/vscode-json-languageserver",
		Notes:     "Requires Node.js; Knowns installs the recommended integrity-pinned version",
	}
}
func (a *JSONAdapter) CanInstall() bool { return true }
func (a *JSONAdapter) RuntimeDeps() []lsp.RuntimeDependency {
	return []lsp.RuntimeDependency{{
		ID:                   "vscode-json-languageserver",
		Version:              jsonLanguageServerVersion,
		RecommendedVersion:   jsonLanguageServerVersion,
		RecommendedIntegrity: jsonLanguageServerIntegrity,
		Source:               "npm",
		ArchiveType:          "npm",
		BinaryName:           "vscode-json-languageserver",
		PackageName:          "vscode-json-languageserver",
		Packages:             []string{"vscode-json-languageserver"},
	}}
}
func (a *JSONAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	return lsp.NewInstaller(targetDir).Install(ctx, a)
}
func (a *JSONAdapter) InstalledPath() (string, bool) {
	return installedPath(a.ID(), a.RuntimeDeps())
}
func (a *JSONAdapter) DefaultArgs() []string { return []string{"--stdio"} }
func (a *JSONAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}
func (a *JSONAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *JSONAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{"node_modules": {}, "dist": {}, "build": {}})
}

// PathMatchers keeps generic JSON routing below Terraform's compound suffix
// matchers. Lockfiles and generated JSON remain explicitly addressable while
// being excluded from repository auto-detection.
func (a *JSONAdapter) PathMatchers() []lsp.PathMatcher {
	return []lsp.PathMatcher{
		{Kind: lsp.PathMatcherExact, Pattern: "package-lock.json", Priority: jsonDetectionBanPriority, ExplicitOnly: true},
		{Kind: lsp.PathMatcherExact, Pattern: "npm-shrinkwrap.json", Priority: jsonDetectionBanPriority, ExplicitOnly: true},
		{Kind: lsp.PathMatcherSuffix, Pattern: ".generated.json", Priority: jsonDetectionBanPriority, ExplicitOnly: true},
		{Kind: lsp.PathMatcherSuffix, Pattern: ".jsonc", Priority: jsonPathPriority},
		{Kind: lsp.PathMatcherSuffix, Pattern: ".json", Priority: jsonPathPriority},
	}
}

func (a *JSONAdapter) LazyStart() bool { return true }

func (a *JSONAdapter) CapabilityProfile() lsp.CapabilityProfile {
	return lsp.DocumentConfigCapabilityProfile()
}

func (a *JSONAdapter) SupportsImplementation() bool { return false }
func (a *JSONAdapter) SupportsReferences() bool     { return false }
