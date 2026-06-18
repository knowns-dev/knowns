package lsp

import (
	"context"
	"os"
	"path/filepath"
)

func DefaultLSPBaseDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(".knowns", "lsp-servers")
	}
	return filepath.Join(home, ".knowns", "lsp-servers")
}

type dependencyAdapter struct {
	BaseAdapter
	id   string
	deps []RuntimeDependency
}

func (a dependencyAdapter) ID() string                                             { return a.id }
func (a dependencyAdapter) Name() string                                           { return a.id }
func (a dependencyAdapter) Extensions() []string                                   { return nil }
func (a dependencyAdapter) Binaries() []BinaryCandidate                            { return nil }
func (a dependencyAdapter) Prerequisites() []Prerequisite                          { return nil }
func (a dependencyAdapter) CheckPrerequisites(context.Context) error               { return nil }
func (a dependencyAdapter) InstallGuide() InstallGuide                             { return InstallGuide{} }
func (a dependencyAdapter) CanInstall() bool                                       { return len(a.deps) > 0 }
func (a dependencyAdapter) RuntimeDeps() []RuntimeDependency                       { return a.deps }
func (a dependencyAdapter) Install(context.Context, string) (string, error)        { return "", nil }
func (a dependencyAdapter) InstalledPath() (string, bool)                          { return "", false }
func (a dependencyAdapter) DefaultArgs() []string                                  { return nil }
func (a dependencyAdapter) InitializeParams(string, map[string]any) map[string]any { return nil }
func (a dependencyAdapter) InitializationOptions(map[string]any) map[string]any    { return nil }
