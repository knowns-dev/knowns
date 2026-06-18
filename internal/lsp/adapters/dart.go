package adapters

import (
	"context"
	"fmt"

	"github.com/howznguyen/knowns/internal/lsp"
)

type DartAdapter struct{ lsp.BaseAdapter }

func NewDartAdapter() *DartAdapter { return &DartAdapter{} }

func (a *DartAdapter) ID() string           { return lsp.DartLanguageID }
func (a *DartAdapter) Name() string         { return "Dart" }
func (a *DartAdapter) Extensions() []string { return []string{".dart"} }
func (a *DartAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{Name: "dart", Args: []string{"language-server"}, CheckArgs: []string{"--version"}}}
}
func (a *DartAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{Name: "Dart SDK", CheckCmd: "dart --version", InstallHint: "Install Dart SDK from https://dart.dev/get-dart"}}
}
func (a *DartAdapter) CheckPrerequisites(ctx context.Context) error {
	_, err := commandOutput(ctx, "dart", "--version")
	return err
}
func (a *DartAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{Command: "Install Dart SDK from https://dart.dev/get-dart", URL: "https://dart.dev/get-dart", Notes: "Dart language server is bundled with the Dart SDK"}
}
func (a *DartAdapter) CanInstall() bool                     { return false }
func (a *DartAdapter) RuntimeDeps() []lsp.RuntimeDependency { return nil }
func (a *DartAdapter) Install(context.Context, string) (string, error) {
	return "", fmt.Errorf("dart adapter is not auto-installable; install the Dart SDK from %s", a.InstallGuide().URL)
}
func (a *DartAdapter) InstalledPath() (string, bool) { return installedPath(a.ID(), a.RuntimeDeps()) }
func (a *DartAdapter) DefaultArgs() []string         { return []string{"language-server"} }
func (a *DartAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}
func (a *DartAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
func (a *DartAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{"build": {}, ".dart_tool": {}, ".pub": {}, ".packages": {}})
}
