package lsp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type statusMockAdapter struct {
	id         string
	name       string
	extensions []string
	binaries   []BinaryCandidate
	guide      InstallGuide
	canInstall bool
}

func (a statusMockAdapter) ID() string                                             { return a.id }
func (a statusMockAdapter) Name() string                                           { return a.name }
func (a statusMockAdapter) Extensions() []string                                   { return a.extensions }
func (a statusMockAdapter) Binaries() []BinaryCandidate                            { return a.binaries }
func (a statusMockAdapter) Prerequisites() []Prerequisite                          { return nil }
func (a statusMockAdapter) CheckPrerequisites(context.Context) error               { return nil }
func (a statusMockAdapter) InstallGuide() InstallGuide                             { return a.guide }
func (a statusMockAdapter) CanInstall() bool                                       { return a.canInstall }
func (a statusMockAdapter) RuntimeDeps() []RuntimeDependency                       { return nil }
func (a statusMockAdapter) Install(context.Context, string) (string, error)        { return "", nil }
func (a statusMockAdapter) InstalledPath() (string, bool)                          { return "", false }
func (a statusMockAdapter) DefaultArgs() []string                                  { return nil }
func (a statusMockAdapter) InitializeParams(string, map[string]any) map[string]any { return nil }
func (a statusMockAdapter) InitializationOptions(map[string]any) map[string]any    { return nil }
func (a statusMockAdapter) IsIgnoredDir(string) bool                               { return false }
func (a statusMockAdapter) NormalizeSymbolName(name string) string                 { return name }
func (a statusMockAdapter) SupportsImplementation() bool                           { return true }
func (a statusMockAdapter) SupportsReferences() bool                               { return true }

func TestCollectRuntimeStatusesCSharpIncludesBackendProjectLogAndAttempts(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "App.sln"), []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Program.cs"), []byte("class Program {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	adapter := statusMockAdapter{
		id:         CSharpLanguageID,
		name:       "C#",
		extensions: []string{".cs"},
		binaries: []BinaryCandidate{
			{Name: "roslyn-ls", CheckArgs: []string{"--version"}},
			{Name: "csharp-ls", CheckArgs: []string{"--version"}},
			{Name: "omnisharp", CheckArgs: []string{"--version"}},
		},
		guide:      InstallGuide{KnownsCmd: "knowns lsp install csharp"},
		canInstall: true,
	}
	detector := &Detector{
		Registry: NewRegistry([]Language{{ID: CSharpLanguageID, Name: "C#", Extensions: []string{".cs"}}}),
		LookPath: func(name string) (string, error) {
			if name == "csharp-ls" {
				return "/bin/csharp-ls", nil
			}
			return "", errors.New("missing")
		},
		RunCheck:  func(context.Context, string, ...string) error { return nil },
		Installer: NewInstaller(t.TempDir()),
	}

	statuses := CollectRuntimeStatuses(context.Background(), RuntimeStatusOptions{
		Root:     root,
		Adapters: []LanguageAdapter{adapter},
		Detector: detector,
	})
	if len(statuses) != 1 {
		t.Fatalf("statuses = %#v, want one C# status", statuses)
	}
	status := statuses[0]
	if !status.Detected {
		t.Fatalf("Detected = false, want true")
	}
	if status.Backend != CSharpBackendCSharp || status.BackendSource != RuntimeSourceAuto {
		t.Fatalf("backend = %q/%q, want csharp-ls/auto", status.Backend, status.BackendSource)
	}
	if status.InstallState != RuntimeInstallInstalled || status.Source != RuntimeSourcePATH {
		t.Fatalf("install/source = %q/%q, want installed/PATH", status.InstallState, status.Source)
	}
	if status.ProjectPath != filepath.Join(root, "App.sln") || status.ProjectKind != "sln" {
		t.Fatalf("project = %q/%q, want App.sln", status.ProjectPath, status.ProjectKind)
	}
	if !strings.Contains(status.LogPath, "csharp-csharp-ls.log") {
		t.Fatalf("LogPath = %q, want csharp backend log", status.LogPath)
	}
	if len(status.Attempts) < 3 {
		t.Fatalf("Attempts = %#v, want roslyn/csharp/omnisharp decisions", status.Attempts)
	}
	var selectedCSharp, skippedOmni bool
	for _, attempt := range status.Attempts {
		if attempt.Backend == CSharpBackendCSharp && attempt.Status == BackendAttemptChosen {
			selectedCSharp = true
		}
		if attempt.Backend == CSharpBackendOmni && attempt.Status == BackendAttemptSkipped {
			skippedOmni = true
		}
	}
	if !selectedCSharp || !skippedOmni {
		t.Fatalf("Attempts = %#v, want selected csharp-ls and skipped omnisharp", status.Attempts)
	}
}

func TestCollectRuntimeStatusesDartIncludesSDKProjectAndLog(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "pubspec.yaml"), []byte("name: sample\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "lib", "main.dart"), []byte("void main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	adapter := statusMockAdapter{
		id:         DartLanguageID,
		name:       "Dart",
		extensions: []string{".dart"},
		binaries:   []BinaryCandidate{{Name: "dart", Args: []string{"language-server"}, CheckArgs: []string{"--version"}}},
		guide:      InstallGuide{Command: "Install Dart SDK from https://dart.dev/get-dart", URL: "https://dart.dev/get-dart"},
	}
	detector := &Detector{
		Registry: NewRegistry([]Language{{ID: DartLanguageID, Name: "Dart", Extensions: []string{".dart"}}}),
		LookPath: func(name string) (string, error) {
			if name == "dart" {
				return "/opt/dart/bin/dart", nil
			}
			return "", errors.New("missing")
		},
		RunCheck: func(context.Context, string, ...string) error { return nil },
		RunCommand: func(_ context.Context, path string, args ...string) ([]byte, error) {
			if path != "/opt/dart/bin/dart" || !reflect.DeepEqual(args, []string{"--version"}) {
				t.Fatalf("RunCommand(%q, %#v), want dart --version", path, args)
			}
			return []byte("Dart SDK version: 3.4.1 (stable)\n"), nil
		},
	}

	statuses := CollectRuntimeStatuses(context.Background(), RuntimeStatusOptions{
		Root:     root,
		Adapters: []LanguageAdapter{adapter},
		Detector: detector,
	})
	if len(statuses) != 1 {
		t.Fatalf("statuses = %#v, want one Dart status", statuses)
	}
	status := statuses[0]
	if !status.Detected {
		t.Fatalf("Detected = false, want true")
	}
	if status.InstallState != RuntimeInstallInstalled || status.Source != RuntimeSourcePATH {
		t.Fatalf("install/source = %q/%q, want installed/PATH", status.InstallState, status.Source)
	}
	if status.Binary != "dart" || status.BinaryPath != "/opt/dart/bin/dart" {
		t.Fatalf("binary = %q/%q, want dart path", status.Binary, status.BinaryPath)
	}
	if status.Version != "3.4.1" {
		t.Fatalf("Version = %q, want 3.4.1", status.Version)
	}
	if status.ProjectPath != root || status.ProjectKind != "pubspec" {
		t.Fatalf("project = %q/%q, want root pubspec", status.ProjectPath, status.ProjectKind)
	}
	if status.LogPath != LanguageLogPath(root, DartLanguageID) {
		t.Fatalf("LogPath = %q, want shared Dart log path", status.LogPath)
	}
	if status.InstallError != "" {
		t.Fatalf("InstallError = %q, want empty for SDK-managed Dart resolved from PATH", status.InstallError)
	}
	if status.InstallCmd != "Install Dart SDK from https://dart.dev/get-dart" {
		t.Fatalf("InstallCmd = %q, want manual Dart SDK install guide", status.InstallCmd)
	}
}

func TestCollectRuntimeStatusesDartMissingReportsManualInstallGuide(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.dart"), []byte("void main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	adapter := statusMockAdapter{
		id:         DartLanguageID,
		name:       "Dart",
		extensions: []string{".dart"},
		binaries:   []BinaryCandidate{{Name: "dart", Args: []string{"language-server"}, CheckArgs: []string{"--version"}}},
		guide:      InstallGuide{Command: "Install Dart SDK from https://dart.dev/get-dart", URL: "https://dart.dev/get-dart"},
	}
	detector := &Detector{
		Registry: NewRegistry([]Language{{ID: DartLanguageID, Name: "Dart", Extensions: []string{".dart"}}}),
		LookPath: func(string) (string, error) {
			return "", errors.New("missing")
		},
		RunCheck: func(context.Context, string, ...string) error { return nil },
	}

	statuses := CollectRuntimeStatuses(context.Background(), RuntimeStatusOptions{
		Root:     root,
		Adapters: []LanguageAdapter{adapter},
		Detector: detector,
	})
	if len(statuses) != 1 {
		t.Fatalf("statuses = %#v, want one Dart status", statuses)
	}
	status := statuses[0]
	if status.InstallState != RuntimeInstallNotInstalled {
		t.Fatalf("InstallState = %q, want not_installed", status.InstallState)
	}
	if status.InstallError != "" {
		t.Fatalf("InstallError = %q, want empty for missing SDK-managed Dart", status.InstallError)
	}
	if status.InstallCmd != "Install Dart SDK from https://dart.dev/get-dart" {
		t.Fatalf("InstallCmd = %q, want manual Dart SDK install guide", status.InstallCmd)
	}
}

func TestDiscoverDartProjectFallsBackToRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "tool"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "tool", "script.dart"), []byte("void main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	selection := DiscoverDartProject(root)
	if selection.Path != root || selection.Kind != "root" {
		t.Fatalf("DiscoverDartProject() = %#v, want root fallback", selection)
	}
}

func TestDiscoverDartProjectPrefersMarkedPackageOverFirstDartFile(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "aaa_scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "aaa_scripts", "scratch.dart"), []byte("void main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	projectDir := filepath.Join(root, "zzz_app")
	if err := os.MkdirAll(filepath.Join(projectDir, "lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "pubspec.yaml"), []byte("name: zzz_app\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "lib", "main.dart"), []byte("void main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	selection := DiscoverDartProject(root)
	if selection.Path != projectDir || selection.Kind != "pubspec" {
		t.Fatalf("DiscoverDartProject() = %#v, want marked pubspec package", selection)
	}
}

func TestManagerRuntimeStatusesIncludesLiveReadiness(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := NewManager(root, Config{})
	m.RegisterAdapter(statusMockAdapter{
		id:         "go",
		name:       "Go",
		extensions: []string{".go"},
		binaries:   []BinaryCandidate{{Name: "gopls"}},
	})
	m.SetDetector(&Detector{
		Registry: NewRegistry([]Language{{ID: "go", Name: "Go", Extensions: []string{".go"}, Binaries: []Binary{{Name: "gopls"}}}}),
		LookPath: func(name string) (string, error) {
			if name == "gopls" {
				return "/bin/gopls", nil
			}
			return "", errors.New("missing")
		},
		RunCheck: func(context.Context, string, ...string) error { return nil },
	})
	server := NewServer(root, ServerCommand{Language: "go", Name: "gopls", Path: "/bin/gopls", LogPath: LanguageLogPath(root, "go")})
	server.mu.Lock()
	server.running = true
	server.mu.Unlock()
	server.readyOnce.Do(func() { close(server.ready) })
	m.mu.Lock()
	m.servers["go"] = server
	m.status["go"] = StatusRunning
	m.mu.Unlock()

	statuses := m.RuntimeStatuses(context.Background())
	if len(statuses) != 1 {
		t.Fatalf("statuses = %#v, want one", statuses)
	}
	status := statuses[0]
	if status.Status != RuntimeRunningRunning || status.RunningState != RuntimeRunningRunning {
		t.Fatalf("status/running = %q/%q, want running", status.Status, status.RunningState)
	}
	if status.ReadinessState != RuntimeReadinessReady {
		t.Fatalf("ReadinessState = %q, want ready", status.ReadinessState)
	}
	if status.LogPath != LanguageLogPath(root, "go") {
		t.Fatalf("LogPath = %q, want shared log path", status.LogPath)
	}
}
