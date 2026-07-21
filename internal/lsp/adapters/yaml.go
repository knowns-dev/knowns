package adapters

import (
	"context"

	"github.com/howznguyen/knowns/internal/lsp"
)

const (
	yamlLanguageServerVersion   = "1.24.0"
	yamlLanguageServerIntegrity = "sha512-+HGcwu4M7IC+UDhDZScTZR8qsl2MMj/X1E5e83QcWzWn2pctj0fv8HHdrHHcbc1KB3CuRPJ4gc1Nm36D0iCu0g=="
	yamlPathPriority            = 100
)

// YAMLAdapter provides YAML document intelligence through yaml-language-server.
type YAMLAdapter struct{ lsp.BaseAdapter }

func NewYAMLAdapter() *YAMLAdapter { return &YAMLAdapter{} }

func (a *YAMLAdapter) ID() string           { return "yaml" }
func (a *YAMLAdapter) Name() string         { return "YAML" }
func (a *YAMLAdapter) Extensions() []string { return []string{".yaml", ".yml"} }
func (a *YAMLAdapter) PathMatchers() []lsp.PathMatcher {
	return []lsp.PathMatcher{
		{Kind: lsp.PathMatcherSuffix, Pattern: ".yaml", Priority: yamlPathPriority},
		{Kind: lsp.PathMatcherSuffix, Pattern: ".yml", Priority: yamlPathPriority},
	}
}
func (a *YAMLAdapter) LazyStart() bool { return true }
func (a *YAMLAdapter) CapabilityProfile() lsp.CapabilityProfile {
	return lsp.DocumentConfigCapabilityProfile()
}
func (a *YAMLAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{
		Name: "yaml-language-server",
		Args: []string{"--stdio"},
	}}
}
func (a *YAMLAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{
		Name:        "Node.js 12+",
		CheckCmd:    "node --version",
		InstallHint: "Install Node.js 12+ from https://nodejs.org/",
	}}
}
func (a *YAMLAdapter) CheckPrerequisites(ctx context.Context) error {
	output, err := commandOutput(ctx, "node", "--version")
	if err != nil {
		return err
	}
	return requireMinVersion(output, "Node.js", 12, 0)
}
func (a *YAMLAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{
		Command:   "npm install -g yaml-language-server@" + yamlLanguageServerVersion,
		KnownsCmd: "knowns lsp install yaml",
		URL:       "https://github.com/redhat-developer/yaml-language-server",
		Notes:     "Requires Node.js 12+; Knowns installs the recommended integrity-pinned version",
	}
}
func (a *YAMLAdapter) CanInstall() bool { return true }
func (a *YAMLAdapter) RuntimeDeps() []lsp.RuntimeDependency {
	return []lsp.RuntimeDependency{{
		ID:                   "yaml-language-server",
		Version:              yamlLanguageServerVersion,
		RecommendedVersion:   yamlLanguageServerVersion,
		RecommendedIntegrity: yamlLanguageServerIntegrity,
		Source:               "npm",
		ArchiveType:          "npm",
		BinaryName:           "yaml-language-server",
		PackageName:          "yaml-language-server",
		Packages:             []string{"yaml-language-server"},
	}}
}
func (a *YAMLAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	return lsp.NewInstaller(targetDir).Install(ctx, a)
}
func (a *YAMLAdapter) InstalledPath() (string, bool) {
	return installedPath(a.ID(), a.RuntimeDeps())
}
func (a *YAMLAdapter) DefaultArgs() []string { return []string{"--stdio"} }
func (a *YAMLAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}
func (a *YAMLAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *YAMLAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{
		"build":        {},
		"dist":         {},
		"generated":    {},
		"node_modules": {},
		"testdata":     {},
		"vendor":       {},
	})
}
func (a *YAMLAdapter) SupportsImplementation() bool { return false }
func (a *YAMLAdapter) SupportsReferences() bool     { return false }
