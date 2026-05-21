package adapters

import (
	"context"
	"fmt"

	"github.com/howznguyen/knowns/internal/lsp"
)

type JdtlsAdapter struct{ lsp.BaseAdapter }

func NewJdtlsAdapter() *JdtlsAdapter { return &JdtlsAdapter{} }

func (a *JdtlsAdapter) ID() string           { return "java" }
func (a *JdtlsAdapter) Name() string         { return "Java" }
func (a *JdtlsAdapter) Extensions() []string { return []string{".java"} }
func (a *JdtlsAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{Name: "jdtls", CheckArgs: []string{"--version"}}}
}
func (a *JdtlsAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{Name: "Java JDK 17+", CheckCmd: "java -version", InstallHint: "Install JDK 17+ from https://adoptium.net/"}}
}
func (a *JdtlsAdapter) CheckPrerequisites(ctx context.Context) error {
	output, err := commandOutput(ctx, "java", "-version")
	if err != nil {
		return err
	}
	return requireMinVersion(output, "Java", 17, 0)
}
func (a *JdtlsAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{KnownsCmd: "knowns lsp install java", URL: "https://github.com/eclipse-jdtls/eclipse.jdt.ls", Notes: "Requires JDK 17+"}
}
func (a *JdtlsAdapter) CanInstall() bool { return true }
func (a *JdtlsAdapter) RuntimeDeps() []lsp.RuntimeDependency {
	// TODO: update SHA-256 values for the pinned jdtls release asset.
	return []lsp.RuntimeDependency{
		{ID: "1.40.0", PlatformID: "darwin-arm64", URL: "https://download.eclipse.org/jdtls/milestones/1.40.0/jdt-language-server-1.40.0-202501301015.tar.gz", SHA256: "TODO", ArchiveType: "tar.gz", BinaryName: "jdtls", ExtractPath: ""},
		{ID: "1.40.0", PlatformID: "darwin-amd64", URL: "https://download.eclipse.org/jdtls/milestones/1.40.0/jdt-language-server-1.40.0-202501301015.tar.gz", SHA256: "TODO", ArchiveType: "tar.gz", BinaryName: "jdtls", ExtractPath: ""},
		{ID: "1.40.0", PlatformID: "linux-amd64", URL: "https://download.eclipse.org/jdtls/milestones/1.40.0/jdt-language-server-1.40.0-202501301015.tar.gz", SHA256: "TODO", ArchiveType: "tar.gz", BinaryName: "jdtls", ExtractPath: ""},
		{ID: "1.40.0", PlatformID: "linux-arm64", URL: "https://download.eclipse.org/jdtls/milestones/1.40.0/jdt-language-server-1.40.0-202501301015.tar.gz", SHA256: "TODO", ArchiveType: "tar.gz", BinaryName: "jdtls", ExtractPath: ""},
		{ID: "1.40.0", PlatformID: "windows-amd64", URL: "https://download.eclipse.org/jdtls/milestones/1.40.0/jdt-language-server-1.40.0-202501301015.tar.gz", SHA256: "TODO", ArchiveType: "tar.gz", BinaryName: "jdtls", ExtractPath: ""},
	}
}
func (a *JdtlsAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	installer := lsp.NewInstaller(targetDir)
	path, err := installer.Install(ctx, a)
	if err != nil {
		return "", fmt.Errorf("install jdtls: %w", err)
	}
	return path, nil
}
func (a *JdtlsAdapter) InstalledPath() (string, bool) { return installedPath(a.ID(), a.RuntimeDeps()) }
func (a *JdtlsAdapter) DefaultArgs() []string         { return nil }
func (a *JdtlsAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}
func (a *JdtlsAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *JdtlsAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{"target": {}, ".gradle": {}, "build": {}, ".idea": {}, "out": {}})
}
