package adapters

import (
	"context"
	"runtime"

	"github.com/howznguyen/knowns/internal/lsp"
)

const (
	bashLanguageServerVersion   = "5.6.0"
	bashLanguageServerIntegrity = "sha512-DCuV+/BZAAozsp5blvi6jDnU/ZDaTpJpWM0zqwGjnirfqv7iBsMK32xOze/jipxU0PUZ6CBUKgRUMKI7Kk70Lg=="
)

// BashAdapter configures bash-language-server for Bash and POSIX shell files.
type BashAdapter struct{ lsp.BaseAdapter }

func NewBashAdapter() *BashAdapter { return &BashAdapter{} }

func (a *BashAdapter) ID() string           { return "bash" }
func (a *BashAdapter) Name() string         { return "Bash" }
func (a *BashAdapter) Extensions() []string { return []string{".sh", ".bash"} }
func (a *BashAdapter) PathMatchers() []lsp.PathMatcher {
	return []lsp.PathMatcher{
		{Kind: lsp.PathMatcherSuffix, Pattern: ".bash", Priority: 220},
		{Kind: lsp.PathMatcherSuffix, Pattern: ".sh", Priority: 210},
		{Kind: lsp.PathMatcherShebang, Pattern: "bash", Priority: 120},
		{Kind: lsp.PathMatcherShebang, Pattern: "sh", Priority: 110},
	}
}
func (a *BashAdapter) LazyStart() bool { return true }
func (a *BashAdapter) CapabilityProfile() lsp.CapabilityProfile {
	return lsp.CodeCapabilityProfile()
}
func (a *BashAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{
		Name:      "bash-language-server",
		Args:      []string{"start"},
		CheckArgs: []string{"--version"},
	}}
}
func (a *BashAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{
		Name:        "Node.js 20+",
		CheckCmd:    "node --version",
		InstallHint: "Install Node.js 20+ from https://nodejs.org/",
	}}
}
func (a *BashAdapter) CheckPrerequisites(ctx context.Context) error {
	output, err := commandOutput(ctx, "node", "--version")
	if err != nil {
		return err
	}
	return requireMinVersion(output, "Node.js", 20, 0)
}
func (a *BashAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{
		Command:   "npm install -g bash-language-server@" + bashLanguageServerVersion,
		URL:       "https://github.com/bash-lsp/bash-language-server",
		KnownsCmd: "knowns lsp install bash",
		Notes:     "Requires Node.js 20+; Knowns uses the pinned recommended version by default",
	}
}
func (a *BashAdapter) CanInstall() bool { return true }
func (a *BashAdapter) RuntimeDeps() []lsp.RuntimeDependency {
	return []lsp.RuntimeDependency{{
		ID:                   "bash-language-server",
		Version:              bashLanguageServerVersion,
		RecommendedVersion:   bashLanguageServerVersion,
		RecommendedIntegrity: bashLanguageServerIntegrity,
		Source:               "npm",
		ArchiveType:          "npm",
		BinaryName:           "bash-language-server",
		PackageName:          "bash-language-server",
		Packages:             []string{"bash-language-server"},
	}}
}
func (a *BashAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	return lsp.NewInstaller(targetDir).Install(ctx, a)
}
func (a *BashAdapter) InstalledPath() (string, bool) {
	return installedPath(a.ID(), a.RuntimeDeps())
}
func (a *BashAdapter) DefaultArgs() []string { return []string{"start"} }
func (a *BashAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return bashInitializeParams(root, settings, runtime.GOOS)
}
func bashInitializeParams(root string, settings map[string]any, goos string) map[string]any {
	// bash-language-server 5.6.0 cannot resolve relative sourced files from a
	// file URI on Windows. Its rootPath fallback accepts the native path and
	// preserves cross-file definition and reference navigation.
	if goos == "windows" {
		return map[string]any{
			"rootPath":              root,
			"initializationOptions": initializationOptions(settings),
		}
	}
	return initializeParams(root, settings)
}
func (a *BashAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *BashAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{
		".git":         {},
		"dist":         {},
		"generated":    {},
		"node_modules": {},
		"vendor":       {},
	})
}
