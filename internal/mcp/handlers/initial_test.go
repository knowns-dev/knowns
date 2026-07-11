package handlers

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

type initialMockAdapter struct {
	id       string
	name     string
	binaries []lsp.BinaryCandidate
	guide    lsp.InstallGuide
}

func (a initialMockAdapter) ID() string                                             { return a.id }
func (a initialMockAdapter) Name() string                                           { return a.name }
func (a initialMockAdapter) Extensions() []string                                   { return nil }
func (a initialMockAdapter) Binaries() []lsp.BinaryCandidate                        { return a.binaries }
func (a initialMockAdapter) Prerequisites() []lsp.Prerequisite                      { return nil }
func (a initialMockAdapter) CheckPrerequisites(context.Context) error               { return nil }
func (a initialMockAdapter) InstallGuide() lsp.InstallGuide                         { return a.guide }
func (a initialMockAdapter) CanInstall() bool                                       { return false }
func (a initialMockAdapter) RuntimeDeps() []lsp.RuntimeDependency                   { return nil }
func (a initialMockAdapter) Install(context.Context, string) (string, error)        { return "", nil }
func (a initialMockAdapter) InstalledPath() (string, bool)                          { return "", false }
func (a initialMockAdapter) DefaultArgs() []string                                  { return nil }
func (a initialMockAdapter) InitializeParams(string, map[string]any) map[string]any { return nil }
func (a initialMockAdapter) InitializationOptions(map[string]any) map[string]any    { return nil }
func (a initialMockAdapter) IsIgnoredDir(string) bool                               { return false }
func (a initialMockAdapter) NormalizeSymbolName(name string) string                 { return name }
func (a initialMockAdapter) SupportsImplementation() bool                           { return true }
func (a initialMockAdapter) SupportsReferences() bool                               { return true }

type errInitialNotFound struct{}

func (errInitialNotFound) Error() string { return "not found" }

func (errInitialNotFound) Is(target error) bool { return errors.Is(target, os.ErrNotExist) }

func TestBuildInitialInstructionsContainsExpectedSections(t *testing.T) {
	got := buildInitialInstructions(func() *storage.Store { return nil }, nil)

	expectedSections := []string{
		"# Knowns MCP — Session Ready",
		"## Code Intelligence Rules",
		"**CRITICAL**",
		"**FORBIDDEN**",
		"## Workflow",
		"## Knowledge Lifecycle",
		"semantic review before becoming trusted",
		"## Tools",
	}
	for _, want := range expectedSections {
		if !strings.Contains(got, want) {
			t.Errorf("expected output to contain %q", want)
		}
	}
}

func TestBuildInitialInstructionsLineLimit(t *testing.T) {
	got := buildInitialInstructions(func() *storage.Store { return nil }, nil)
	lines := strings.Split(got, "\n")
	if len(lines) > 80 {
		t.Errorf("initial output has %d lines, expected ≤ 80", len(lines))
	}
}

func TestSemanticRuntimeLineIncludesStatus(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	search.DefaultSemanticRuntime().Close()
	t.Cleanup(search.DefaultSemanticRuntime().Close)
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	project := &models.Project{
		Name: "initial-test",
		ID:   "initial-test",
		Settings: models.ProjectSettings{
			SemanticSearch: &models.SemanticSearchSettings{
				Enabled:  true,
				Provider: "api",
				Model:    "api-model",
			},
		},
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save config: %v", err)
	}

	got := semanticRuntimeLine(store)
	for _, want := range []string{"Semantic runtime:", "enabled=true", "provider=api", "model=api-model", "loaded=false", "log="} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in semantic runtime line, got: %s", want, got)
		}
	}
}

func TestLspWarningsLineWithMissing(t *testing.T) {
	root := t.TempDir()
	manager := lsp.NewManager(root, lsp.Config{})
	manager.RegisterAdapter(initialMockAdapter{
		id:       "python",
		name:     "Python",
		binaries: []lsp.BinaryCandidate{{Name: "pylsp"}},
		guide: lsp.InstallGuide{
			Command:   "pip install python-lsp-server",
			KnownsCmd: "knowns lsp install python",
			URL:       "https://github.com/python-lsp/python-lsp-server",
		},
	})
	manager.RegisterAdapter(initialMockAdapter{
		id:       "rust",
		name:     "Rust",
		binaries: []lsp.BinaryCandidate{{Name: "rust-analyzer"}},
		guide: lsp.InstallGuide{
			Command:   "rustup component add rust-analyzer",
			KnownsCmd: "knowns lsp install rust",
			URL:       "https://rust-analyzer.github.io/",
		},
	})

	manager.SetDetector(&lsp.Detector{Registry: lsp.NewRegistry([]lsp.Language{
		{ID: "python", Extensions: []string{".py"}, Binaries: []lsp.Binary{{Name: "missing-pylsp"}}},
		{ID: "rust", Extensions: []string{".rs"}, Binaries: []lsp.Binary{{Name: "rust-analyzer"}}},
	}), LookPath: func(name string) (string, error) {
		if name == "rust-analyzer" {
			return "/bin/rust-analyzer", nil
		}
		return "", errInitialNotFound{}
	}})
	if err := os.WriteFile(filepath.Join(root, "main.py"), []byte("print('hi')"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "main.rs"), []byte("fn main() {}"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := lspWarningsLine(manager)
	if !strings.Contains(got, "python") {
		t.Errorf("expected LSP warning to mention python, got: %s", got)
	}
	if strings.Contains(got, "rust") {
		t.Errorf("expected working rust server to be omitted, got: %s", got)
	}
}

func TestLspWarningsLineNoneMissing(t *testing.T) {
	root := t.TempDir()
	manager := lsp.NewManager(root, lsp.Config{})
	manager.RegisterAdapter(initialMockAdapter{id: "python", name: "Python", binaries: []lsp.BinaryCandidate{{Name: "pylsp"}}})
	manager.SetDetector(&lsp.Detector{Registry: lsp.NewRegistry([]lsp.Language{
		{ID: "python", Extensions: []string{".py"}, Binaries: []lsp.Binary{{Name: "pylsp"}}},
	}), LookPath: func(name string) (string, error) { return "/bin/" + name, nil }})
	if err := os.WriteFile(filepath.Join(root, "main.py"), []byte("print('hi')"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := lspWarningsLine(manager)
	if got != "" {
		t.Errorf("expected empty string when no LSP servers missing, got: %s", got)
	}
}

func TestLspWarningsLineIncludesCSharpRuntimeState(t *testing.T) {
	root := t.TempDir()
	manager := lsp.NewManager(root, lsp.Config{})
	manager.RegisterAdapter(initialMockAdapter{
		id:       lsp.CSharpLanguageID,
		name:     "C#",
		binaries: []lsp.BinaryCandidate{{Name: "roslyn-ls"}, {Name: "csharp-ls"}, {Name: "omnisharp"}},
		guide:    lsp.InstallGuide{KnownsCmd: "knowns lsp install csharp"},
	})
	manager.SetDetector(&lsp.Detector{
		Registry: lsp.NewRegistry([]lsp.Language{{ID: lsp.CSharpLanguageID, Extensions: []string{".cs"}, Binaries: []lsp.Binary{{Name: "csharp-ls"}}}}),
		LookPath: func(name string) (string, error) {
			if name == "csharp-ls" {
				return "/bin/csharp-ls", nil
			}
			return "", errInitialNotFound{}
		},
		RunCheck:  func(context.Context, string, ...string) error { return nil },
		Installer: lsp.NewInstaller(t.TempDir()),
	})
	if err := os.WriteFile(filepath.Join(root, "Program.cs"), []byte("class Program {}"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := lspWarningsLine(manager)
	for _, want := range []string{"csharp", "backend=csharp-ls", "install=installed", "readiness=unknown", "log="} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in LSP runtime line, got: %s", want, got)
		}
	}
}

func TestLspWarningsLineIncludesDaemonOwner(t *testing.T) {
	got := lspWarningsLineFromStatuses([]lsp.LanguageRuntimeStatus{{
		ID:             lsp.CSharpLanguageID,
		InstallState:   lsp.RuntimeInstallInstalled,
		ReadinessState: lsp.RuntimeReadinessUnknown,
		Owner:          "daemon",
		DaemonState:    "running",
	}})
	for _, want := range []string{"owner=daemon", "daemon=running"} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in LSP runtime line, got: %s", want, got)
		}
	}
}
