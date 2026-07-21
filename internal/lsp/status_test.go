package lsp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

type statusMockAdapter struct {
	id          string
	name        string
	extensions  []string
	binaries    []BinaryCandidate
	guide       InstallGuide
	canInstall  bool
	profile     CapabilityProfile
	runtimeDeps []RuntimeDependency
}

type statusRoutingAdapter struct {
	statusMockAdapter
	matchers []PathMatcher
}

func (a statusRoutingAdapter) PathMatchers() []PathMatcher { return a.matchers }

func (a statusMockAdapter) ID() string                                             { return a.id }
func (a statusMockAdapter) Name() string                                           { return a.name }
func (a statusMockAdapter) Extensions() []string                                   { return a.extensions }
func (a statusMockAdapter) Binaries() []BinaryCandidate                            { return a.binaries }
func (a statusMockAdapter) Prerequisites() []Prerequisite                          { return nil }
func (a statusMockAdapter) CheckPrerequisites(context.Context) error               { return nil }
func (a statusMockAdapter) InstallGuide() InstallGuide                             { return a.guide }
func (a statusMockAdapter) CanInstall() bool                                       { return a.canInstall }
func (a statusMockAdapter) RuntimeDeps() []RuntimeDependency                       { return a.runtimeDeps }
func (a statusMockAdapter) Install(context.Context, string) (string, error)        { return "", nil }
func (a statusMockAdapter) InstalledPath() (string, bool)                          { return "", false }
func (a statusMockAdapter) DefaultArgs() []string                                  { return nil }
func (a statusMockAdapter) InitializeParams(string, map[string]any) map[string]any { return nil }
func (a statusMockAdapter) InitializationOptions(map[string]any) map[string]any    { return nil }
func (a statusMockAdapter) IsIgnoredDir(string) bool                               { return false }
func (a statusMockAdapter) NormalizeSymbolName(name string) string                 { return name }
func (a statusMockAdapter) SupportsImplementation() bool                           { return true }
func (a statusMockAdapter) SupportsReferences() bool                               { return true }
func (a statusMockAdapter) CapabilityProfile() CapabilityProfile                   { return a.profile }

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

func TestCollectRuntimeStatusesBinaryCheckUsesTimeout(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	adapter := statusMockAdapter{
		id:         "go",
		name:       "Go",
		extensions: []string{".go"},
		binaries:   []BinaryCandidate{{Name: "gopls", CheckArgs: []string{"version"}}},
	}
	detector := &Detector{
		Registry: NewRegistry([]Language{{ID: "go", Name: "Go", Extensions: []string{".go"}}}),
		LookPath: func(name string) (string, error) {
			if name == "gopls" {
				return "/opt/knowns/bin/gopls", nil
			}
			return "", errors.New("missing")
		},
		RunCheck: func(ctx context.Context, path string, args ...string) error {
			deadline, ok := ctx.Deadline()
			if !ok {
				t.Fatalf("RunCheck context has no deadline")
			}
			if remaining := time.Until(deadline); remaining <= 0 || remaining > runtimeStatusProbeTimeout+time.Second {
				t.Fatalf("RunCheck deadline remaining = %s, want near %s", remaining, runtimeStatusProbeTimeout)
			}
			return nil
		},
	}

	statuses := CollectRuntimeStatuses(context.Background(), RuntimeStatusOptions{
		Root:     root,
		Adapters: []LanguageAdapter{adapter},
		Detector: detector,
	})
	if len(statuses) != 1 {
		t.Fatalf("statuses = %#v, want one Go status", statuses)
	}
	if statuses[0].InstallState != RuntimeInstallInstalled {
		t.Fatalf("InstallState = %q, want installed", statuses[0].InstallState)
	}
}

func TestCollectRuntimeStatusesExposesExpectedBackendWhenNotInstalled(t *testing.T) {
	adapter := statusMockAdapter{
		id:       "markdown",
		name:     "Markdown",
		binaries: []BinaryCandidate{{Name: "marksman"}},
		guide:    InstallGuide{KnownsCmd: "knowns lsp install markdown"},
	}
	detector := &Detector{
		Registry:  NewEmptyRegistry(),
		LookPath:  func(string) (string, error) { return "", os.ErrNotExist },
		Installer: NewInstaller(t.TempDir()),
	}

	statuses := CollectRuntimeStatuses(context.Background(), RuntimeStatusOptions{
		Root:     t.TempDir(),
		Adapters: []LanguageAdapter{adapter},
		Detector: detector,
	})
	if len(statuses) != 1 {
		t.Fatalf("statuses = %#v, want one status", statuses)
	}
	status := statuses[0]
	if status.Backend != "marksman" || status.BackendSource != RuntimeSourceAuto {
		t.Fatalf("backend = %q/%q, want marksman/auto", status.Backend, status.BackendSource)
	}
	if status.InstallState != RuntimeInstallNotInstalled {
		t.Fatalf("InstallState = %q, want not_installed", status.InstallState)
	}
}

func TestCollectRuntimeStatusesUsesConfiguredBinaryAsExpectedBackend(t *testing.T) {
	adapter := statusMockAdapter{id: "markdown", name: "Markdown", binaries: []BinaryCandidate{{Name: "marksman"}}}
	detector := &Detector{
		Registry:  NewEmptyRegistry(),
		LookPath:  func(string) (string, error) { return "", os.ErrNotExist },
		Installer: NewInstaller(t.TempDir()),
	}
	statuses := CollectRuntimeStatuses(context.Background(), RuntimeStatusOptions{
		Root:     t.TempDir(),
		Config:   Config{Languages: map[string]LanguageConfig{"markdown": {Binary: filepath.Join("custom", "markdown-ls")}}},
		Adapters: []LanguageAdapter{adapter},
		Detector: detector,
	})
	status := statuses[0]
	if status.Backend != "markdown-ls" || status.BackendSource != RuntimeSourceConfig {
		t.Fatalf("backend = %q/%q, want markdown-ls/config", status.Backend, status.BackendSource)
	}
}

func TestCollectRuntimeStatusesUsesCanonicalOrderedDetection(t *testing.T) {
	root := t.TempDir()
	for path, content := range map[string]string{
		"network.tf.json":        "{}\n",
		"deploy":                 "#!/usr/bin/env bash\necho ok\n",
		"testdata/settings.json": "{}\n",
	} {
		fullPath := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	detector := &Detector{
		Registry:  NewEmptyRegistry(),
		LookPath:  func(string) (string, error) { return "", os.ErrNotExist },
		Installer: NewInstaller(t.TempDir()),
	}
	adapters := []LanguageAdapter{
		statusRoutingAdapter{statusMockAdapter: statusMockAdapter{id: "json", name: "JSON", extensions: []string{".json"}, binaries: []BinaryCandidate{{Name: "json-ls"}}}, matchers: []PathMatcher{{Kind: PathMatcherSuffix, Pattern: ".json", Priority: 100}}},
		statusRoutingAdapter{statusMockAdapter: statusMockAdapter{id: "terraform", name: "Terraform", extensions: []string{".tf", ".tf.json"}, binaries: []BinaryCandidate{{Name: "terraform-ls"}}}, matchers: []PathMatcher{{Kind: PathMatcherSuffix, Pattern: ".tf.json", Priority: 300}, {Kind: PathMatcherSuffix, Pattern: ".tf", Priority: 200}}},
		statusRoutingAdapter{statusMockAdapter: statusMockAdapter{id: "bash", name: "Bash", extensions: []string{".sh"}, binaries: []BinaryCandidate{{Name: "bash-language-server"}}}, matchers: []PathMatcher{{Kind: PathMatcherShebang, Pattern: "bash", Priority: 250}}},
	}
	statuses := CollectRuntimeStatuses(context.Background(), RuntimeStatusOptions{
		Root:      root,
		Adapters:  adapters,
		Detector:  detector,
		Installer: NewInstaller(t.TempDir()),
	})
	detected := make(map[string]bool, len(statuses))
	for _, status := range statuses {
		detected[status.ID] = status.Detected
	}
	if !detected["terraform"] {
		t.Fatal("Terraform compound JSON was not detected by ordered routing")
	}
	if detected["json"] {
		t.Fatal("JSON was detected from a Terraform-owned or ignored JSON path")
	}
	if !detected["bash"] {
		t.Fatal("extensionless Bash shebang was not detected")
	}
}

func TestCollectRuntimeStatusesPrefersPATHAndReportsActualVersion(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "config.pathfirst"), []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	dep := RuntimeDependency{Version: "1.0.0", RecommendedVersion: "1.0.0", Source: "npm", PackageName: "pathfirst-ls", BinaryName: "pathfirst-ls"}
	adapter := statusMockAdapter{
		id: "pathfirst", name: "PATH first", extensions: []string{".pathfirst"},
		binaries:    []BinaryCandidate{{Name: "pathfirst-ls", CheckArgs: []string{"--version"}}},
		runtimeDeps: []RuntimeDependency{dep}, canInstall: true,
	}
	installer := NewInstaller(t.TempDir())
	managedPath := filepath.Join(installer.baseDir, adapter.ID(), "pathfirst-ls-1.0.0", "node_modules", ".bin", "pathfirst-ls")
	if runtime.GOOS == "windows" {
		managedPath += ".cmd"
	}
	if err := os.MkdirAll(filepath.Dir(managedPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(managedPath, []byte("managed"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := installer.writeSelectionResolution(adapter, DependencyResolution{
		Dependency: dep, RequestedVersion: "recommended", ResolvedVersion: "1.0.0", Source: "pathfirst-ls@1.0.0", Integrity: "sha512:test", Verified: true,
	}, managedPath); err != nil {
		t.Fatal(err)
	}
	detector := &Detector{
		Registry:  NewRegistry([]Language{{ID: adapter.ID(), Name: adapter.Name(), Extensions: adapter.Extensions()}}),
		Installer: installer,
		LookPath: func(name string) (string, error) {
			if name == "pathfirst-ls" {
				return "/usr/local/bin/pathfirst-ls", nil
			}
			return "", os.ErrNotExist
		},
		RunCheck: func(context.Context, string, ...string) error { return nil },
		RunCommand: func(_ context.Context, path string, args ...string) ([]byte, error) {
			if path != "/usr/local/bin/pathfirst-ls" || !reflect.DeepEqual(args, []string{"--version"}) {
				t.Fatalf("version probe = %q %#v", path, args)
			}
			return []byte("pathfirst-ls 3.4.5\n"), nil
		},
	}
	statuses := CollectRuntimeStatuses(context.Background(), RuntimeStatusOptions{Root: root, Adapters: []LanguageAdapter{adapter}, Detector: detector, Installer: installer})
	if len(statuses) != 1 {
		t.Fatalf("statuses = %#v", statuses)
	}
	status := statuses[0]
	if status.Source != RuntimeSourcePATH || status.BinaryPath != "/usr/local/bin/pathfirst-ls" || status.Version != "pathfirst-ls 3.4.5" {
		t.Fatalf("PATH runtime was not selected with actual version: %#v", status)
	}
	if status.ResolvedVersion != "1.0.0" || !status.Verified {
		t.Fatalf("managed selection provenance was lost: %#v", status)
	}
}

func TestCollectRuntimeStatusesConfigOverridePrecedesPATH(t *testing.T) {
	adapter := statusMockAdapter{
		id: "override", name: "Override", extensions: []string{".override"},
		binaries: []BinaryCandidate{{Name: "path-ls", CheckArgs: []string{"--version"}}},
	}
	override := "/opt/custom/override-ls"
	detector := &Detector{
		Registry: NewRegistry([]Language{{ID: adapter.ID(), Name: adapter.Name(), Extensions: adapter.Extensions()}}),
		LookPath: func(name string) (string, error) {
			switch name {
			case override:
				return override, nil
			case "path-ls":
				return "/usr/bin/path-ls", nil
			default:
				return "", os.ErrNotExist
			}
		},
		RunCheck: func(context.Context, string, ...string) error { return nil },
		RunCommand: func(_ context.Context, path string, _ ...string) ([]byte, error) {
			return []byte(filepath.Base(path) + " 9.8.7"), nil
		},
	}
	statuses := CollectRuntimeStatuses(context.Background(), RuntimeStatusOptions{
		Config:   Config{Languages: map[string]LanguageConfig{adapter.ID(): {Binary: override}}},
		Adapters: []LanguageAdapter{adapter}, Detector: detector,
	})
	status := statuses[0]
	if status.Source != RuntimeSourceConfig || status.BinaryPath != override || status.Version != "override-ls 9.8.7" {
		t.Fatalf("config override did not precede PATH: %#v", status)
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
		RunCommand: func(ctx context.Context, path string, args ...string) ([]byte, error) {
			if _, ok := ctx.Deadline(); !ok {
				t.Fatalf("RunCommand context has no deadline")
			}
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

func TestManagerRuntimeStatusesMarksMissingBaselineDegraded(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "main.go")
	if err := os.WriteFile(path, []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	adapter := statusMockAdapter{
		id:         "go",
		name:       "Go",
		extensions: []string{".go"},
		binaries:   []BinaryCandidate{{Name: "gopls"}},
		profile:    CodeCapabilityProfile(),
	}
	m := NewManager(root, Config{})
	if err := m.RegisterAdapter(adapter); err != nil {
		t.Fatal(err)
	}
	m.SetDetector(&Detector{
		Registry: m.registry,
		LookPath: func(string) (string, error) { return "/bin/gopls", nil },
		RunCheck: func(context.Context, string, ...string) error { return nil },
	})
	server := NewServer(root, ServerCommand{Language: "go", Name: "gopls", Path: "/bin/gopls"})
	server.SetCapabilityProfile(adapter.profile)
	server.mu.Lock()
	server.running = true
	server.initialized = true
	server.capabilitiesKnown = true
	server.advertisedCapabilities = []string{CapabilityDocumentSymbols, CapabilityReferences}
	server.mu.Unlock()
	m.mu.Lock()
	m.servers["go"] = server
	m.status["go"] = StatusRunning
	m.mu.Unlock()

	statuses := m.RuntimeStatuses(context.Background())
	if len(statuses) != 1 {
		t.Fatalf("statuses = %#v", statuses)
	}
	status := statuses[0]
	if status.Status != RuntimeStatusDegraded || status.RunningState != RuntimeRunningRunning {
		t.Fatalf("status/running = %q/%q, want degraded/running", status.Status, status.RunningState)
	}
	if want := []string{CapabilityDefinition}; !reflect.DeepEqual(status.MissingCapabilities, want) {
		t.Fatalf("MissingCapabilities = %#v, want %#v", status.MissingCapabilities, want)
	}
	if err := server.requireCapability("references", CapabilityReferences); err != nil {
		t.Fatalf("advertised supported operation rejected: %v", err)
	}
}

func TestManagerRuntimeStatusesRequireLegacyPushDiagnosticsObservation(t *testing.T) {
	root := t.TempDir()
	adapter := statusMockAdapter{
		id:         "yaml",
		name:       "YAML",
		extensions: []string{".yaml"},
		binaries:   []BinaryCandidate{{Name: "yaml-language-server"}},
		profile:    DocumentConfigCapabilityProfile(),
	}
	m := NewManager(root, Config{})
	if err := m.RegisterAdapter(adapter); err != nil {
		t.Fatal(err)
	}
	server := NewServer(root, ServerCommand{Language: "yaml", Name: "yaml-language-server"})
	server.SetCapabilityProfile(adapter.profile)
	server.mu.Lock()
	server.running = true
	server.initialized = true
	server.capabilitiesKnown = true
	server.advertisedCapabilities = []string{CapabilityDocumentSymbols}
	server.mu.Unlock()
	m.mu.Lock()
	m.servers["yaml"] = server
	m.status["yaml"] = StatusRunning
	m.mu.Unlock()

	before := m.RuntimeStatuses(context.Background())[0]
	if before.Status != RuntimeStatusDegraded || !reflect.DeepEqual(before.MissingCapabilities, []string{CapabilityDiagnostics}) {
		t.Fatalf("legacy push status before observation = %#v, want degraded with missing diagnostics", before)
	}
	if len(before.AdvertisedCapabilities) != 1 || hasCapability(before.AdvertisedCapabilities, CapabilityDiagnostics) {
		t.Fatalf("legacy expectation leaked into advertised capabilities: %#v", before.AdvertisedCapabilities)
	}
	if hasCapability(before.Capabilities, CapabilityDiagnostics) {
		t.Fatalf("legacy diagnostics promoted before observation: %#v", before.Capabilities)
	}
	if err := server.requireCapability("diagnostics", CapabilityDiagnostics); err != nil {
		t.Fatalf("legacy diagnostics action rejected before observation: %v", err)
	}

	params, err := json.Marshal(map[string]any{
		"uri":         FileURI(filepath.Join(root, "config.yaml")),
		"diagnostics": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	server.mu.Lock()
	server.handleNotificationLocked("textDocument/publishDiagnostics", params)
	server.mu.Unlock()

	after := m.RuntimeStatuses(context.Background())[0]
	if after.Status != RuntimeRunningRunning || len(after.MissingCapabilities) != 0 {
		t.Fatalf("legacy push status after observation = %#v, want running without missing baseline", after)
	}
	if !hasCapability(after.Capabilities, CapabilityDiagnostics) || !hasCapability(after.ObservedCapabilities, CapabilityDiagnostics) {
		t.Fatalf("observed diagnostics missing from effective snapshot: %#v", after)
	}
}
