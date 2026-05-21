package adapters

import (
	"context"
	"fmt"

	"github.com/howznguyen/knowns/internal/lsp"
)

type ClangdAdapter struct{ lsp.BaseAdapter }

func NewClangdAdapter() *ClangdAdapter { return &ClangdAdapter{} }

func (a *ClangdAdapter) ID() string   { return "c_cpp" }
func (a *ClangdAdapter) Name() string { return "C/C++" }
func (a *ClangdAdapter) Extensions() []string {
	return []string{".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"}
}
func (a *ClangdAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{Name: "clangd", CheckArgs: []string{"--version"}}}
}
func (a *ClangdAdapter) Prerequisites() []lsp.Prerequisite            { return nil }
func (a *ClangdAdapter) CheckPrerequisites(ctx context.Context) error { return nil }
func (a *ClangdAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{KnownsCmd: "knowns lsp install c_cpp", URL: "https://clangd.llvm.org/installation", Notes: "Standalone clangd binaries can be installed by Knowns for supported platforms"}
}
func (a *ClangdAdapter) CanInstall() bool { return true }
func (a *ClangdAdapter) RuntimeDeps() []lsp.RuntimeDependency {
	// TODO: update SHA-256 values for the pinned clangd release assets.
	return []lsp.RuntimeDependency{
		{ID: "18.1.3", PlatformID: "darwin-arm64", URL: "https://github.com/clangd/clangd/releases/download/18.1.3/clangd-mac-18.1.3.zip", SHA256: "TODO", ArchiveType: "zip", BinaryName: "clangd", ExtractPath: "clangd_18.1.3/bin"},
		{ID: "18.1.3", PlatformID: "darwin-amd64", URL: "https://github.com/clangd/clangd/releases/download/18.1.3/clangd-mac-18.1.3.zip", SHA256: "TODO", ArchiveType: "zip", BinaryName: "clangd", ExtractPath: "clangd_18.1.3/bin"},
		{ID: "18.1.3", PlatformID: "linux-amd64", URL: "https://github.com/clangd/clangd/releases/download/18.1.3/clangd-linux-18.1.3.zip", SHA256: "TODO", ArchiveType: "zip", BinaryName: "clangd", ExtractPath: "clangd_18.1.3/bin"},
		{ID: "18.1.3", PlatformID: "linux-arm64", URL: "https://github.com/clangd/clangd/releases/download/18.1.3/clangd-linux-18.1.3.zip", SHA256: "TODO", ArchiveType: "zip", BinaryName: "clangd", ExtractPath: "clangd_18.1.3/bin"},
		{ID: "18.1.3", PlatformID: "windows-amd64", URL: "https://github.com/clangd/clangd/releases/download/18.1.3/clangd-windows-18.1.3.zip", SHA256: "TODO", ArchiveType: "zip", BinaryName: "clangd", ExtractPath: "clangd_18.1.3/bin"},
	}
}
func (a *ClangdAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	installer := lsp.NewInstaller(targetDir)
	path, err := installer.Install(ctx, a)
	if err != nil {
		return "", fmt.Errorf("install clangd: %w", err)
	}
	return path, nil
}
func (a *ClangdAdapter) InstalledPath() (string, bool) { return installedPath(a.ID(), a.RuntimeDeps()) }
func (a *ClangdAdapter) DefaultArgs() []string         { return nil }
func (a *ClangdAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}
func (a *ClangdAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *ClangdAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{"build": {}, "cmake-build-debug": {}, "cmake-build-release": {}, ".cache": {}})
}
