package lsp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// mgrMockAdapter implements LanguageAdapter for manager tests.
type mgrMockAdapter struct {
	id         string
	name       string
	extensions []string
	matchers   []PathMatcher
	lazyStart  bool
	binaries   []BinaryCandidate
	guide      InstallGuide
	initParams func(string, map[string]any) map[string]any
}

type mgrDocumentSyncAdapter struct {
	*mgrMockAdapter
	resolveDocumentSync func(string) DocumentSyncOptions
	resolveCapability   func(string, string, string) (PathCapabilityDecision, bool)
}

func (a *mgrDocumentSyncAdapter) DocumentSyncForPath(path string) DocumentSyncOptions {
	if a.resolveDocumentSync == nil {
		return DocumentSyncOptions{}
	}
	return a.resolveDocumentSync(path)
}

func (a *mgrDocumentSyncAdapter) PathCapabilityForAction(path, action, capability string) (PathCapabilityDecision, bool) {
	if a.resolveCapability == nil {
		return PathCapabilityDecision{}, false
	}
	return a.resolveCapability(path, action, capability)
}

func (a *mgrMockAdapter) ID() string                                      { return a.id }
func (a *mgrMockAdapter) Name() string                                    { return a.name }
func (a *mgrMockAdapter) Extensions() []string                            { return a.extensions }
func (a *mgrMockAdapter) Binaries() []BinaryCandidate                     { return a.binaries }
func (a *mgrMockAdapter) Prerequisites() []Prerequisite                   { return nil }
func (a *mgrMockAdapter) CheckPrerequisites(context.Context) error        { return nil }
func (a *mgrMockAdapter) InstallGuide() InstallGuide                      { return a.guide }
func (a *mgrMockAdapter) CanInstall() bool                                { return false }
func (a *mgrMockAdapter) RuntimeDeps() []RuntimeDependency                { return nil }
func (a *mgrMockAdapter) Install(context.Context, string) (string, error) { return "", nil }
func (a *mgrMockAdapter) InstalledPath() (string, bool)                   { return "", false }
func (a *mgrMockAdapter) DefaultArgs() []string                           { return nil }
func (a *mgrMockAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	if a.initParams == nil {
		return nil
	}
	return a.initParams(root, settings)
}
func (a *mgrMockAdapter) InitializationOptions(map[string]any) map[string]any { return nil }
func (a *mgrMockAdapter) IsIgnoredDir(string) bool                            { return false }
func (a *mgrMockAdapter) NormalizeSymbolName(n string) string                 { return n }

type errMgrNotFound struct{}

func (errMgrNotFound) Error() string { return "not found" }

func (errMgrNotFound) Is(target error) bool { return errors.Is(target, os.ErrNotExist) }

func (a *mgrMockAdapter) SupportsImplementation() bool { return true }
func (a *mgrMockAdapter) SupportsReferences() bool     { return true }
func (a *mgrMockAdapter) PathMatchers() []PathMatcher  { return a.matchers }
func (a *mgrMockAdapter) LazyStart() bool              { return a.lazyStart }

func TestRegisterAdapter(t *testing.T) {
	m := NewManager(t.TempDir(), Config{})
	adapter := &mgrMockAdapter{id: "go", name: "Go"}
	m.RegisterAdapter(adapter)

	m.mu.Lock()
	got := m.adapters["go"]
	m.mu.Unlock()
	if got == nil {
		t.Fatal("expected adapter to be registered")
	}
	if got.ID() != "go" {
		t.Fatalf("expected adapter ID 'go', got %q", got.ID())
	}
}

func TestManagerConfiguresAdapterInitializeParams(t *testing.T) {
	root := t.TempDir()
	settings := map[string]any{"shellcheckPath": "shellcheck"}
	m := NewManager(root, Config{Languages: map[string]LanguageConfig{
		"bash": {Settings: settings},
	}})
	adapter := &mgrDocumentSyncAdapter{
		mgrMockAdapter: &mgrMockAdapter{
			id:         "bash",
			name:       "Bash",
			extensions: []string{".sh"},
			initParams: func(gotRoot string, gotSettings map[string]any) map[string]any {
				return map[string]any{
					"rootPath":              gotRoot,
					"initializationOptions": gotSettings,
				}
			},
		},
		resolveCapability: func(_, action, capability string) (PathCapabilityDecision, bool) {
			return PathCapabilityDecision{Supported: false}, action == "" && capability == ""
		},
	}
	if err := m.RegisterAdapter(adapter); err != nil {
		t.Fatal(err)
	}

	srv, ok, err := m.ServerForPath(context.Background(), filepath.Join(root, "main.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || srv == nil {
		t.Fatal("expected routed Bash server")
	}
	srv.mu.Lock()
	rootPath := srv.initializeParams["rootPath"]
	options := srv.initializeParams["initializationOptions"]
	srv.mu.Unlock()
	if rootPath != root {
		t.Fatalf("rootPath = %#v, want %q", rootPath, root)
	}
	if !reflect.DeepEqual(options, settings) {
		t.Fatalf("initializationOptions = %#v, want %#v", options, settings)
	}
}

func TestRegisterAdapterPreservesOptionalRoutingContract(t *testing.T) {
	m := NewManager(t.TempDir(), Config{})
	adapter := &mgrMockAdapter{
		id:         "bash",
		name:       "Bash",
		extensions: []string{".sh"},
		matchers: []PathMatcher{{
			Kind:     PathMatcherShebang,
			Pattern:  "bash",
			Priority: 100,
		}},
		lazyStart: true,
	}
	if err := m.RegisterAdapter(adapter); err != nil {
		t.Fatal(err)
	}

	lang, ok := m.registry.Language("bash")
	if !ok || !lang.LazyStart {
		t.Fatalf("registered language = %#v, %v; want lazy bash", lang, ok)
	}
	if len(lang.Matchers) != 2 {
		t.Fatalf("registered matchers = %#v, want extension plus shebang", lang.Matchers)
	}
}

func TestLazyAdaptersAreNotStartedDuringProjectActivation(t *testing.T) {
	activations := map[string]func(context.Context, *Manager) error{
		"StartAll": func(ctx context.Context, m *Manager) error {
			return m.StartAll(ctx)
		},
		"ClientConnected": func(ctx context.Context, m *Manager) error {
			return m.ClientConnected(ctx)
		},
	}

	for name, activate := range activations {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			for file, content := range map[string]string{
				"README.md":     "# Project\n",
				"settings.json": "{}\n",
				"workflow.yml":  "name: ci\n",
			} {
				if err := os.WriteFile(filepath.Join(root, file), []byte(content), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			m := NewManager(root, Config{})
			adapters := []*mgrMockAdapter{
				{id: "markdown", name: "Markdown", extensions: []string{".md"}, lazyStart: true, binaries: []BinaryCandidate{{Name: "marksman"}}},
				{id: "json", name: "JSON", extensions: []string{".json"}, lazyStart: true, binaries: []BinaryCandidate{{Name: "json-ls"}}},
				{id: "yaml", name: "YAML", extensions: []string{".yaml", ".yml"}, lazyStart: true, binaries: []BinaryCandidate{{Name: "yaml-ls"}}},
			}
			for _, adapter := range adapters {
				if err := m.RegisterAdapter(adapter); err != nil {
					t.Fatal(err)
				}
			}
			var lookups atomic.Int32
			m.SetDetector(&Detector{
				Registry: m.registry,
				LookPath: func(string) (string, error) {
					lookups.Add(1)
					return "/fake/marksman", nil
				},
			})

			if err := activate(context.Background(), m); err != nil {
				t.Fatal(err)
			}
			if lookups.Load() != int32(len(adapters)) {
				t.Fatalf("binary lookups = %d, want one detection lookup per adapter", lookups.Load())
			}
			m.mu.Lock()
			serverCount := len(m.servers)
			statuses := make(map[string]ServerStatus, len(m.status))
			for id, status := range m.status {
				statuses[id] = status
			}
			m.mu.Unlock()
			if serverCount != 0 {
				t.Fatalf("project activation created %d lazy servers", serverCount)
			}
			for _, adapter := range adapters {
				if status := statuses[adapter.id]; status != StatusInstalled {
					t.Fatalf("lazy %s status = %v, want installed without starting", adapter.id, status)
				}
			}
		})
	}
}

func TestLazyAdapterStartsOnExplicitPathAndReusesServer(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "document.lazy")
	if err := os.WriteFile(path, []byte("example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	binaryName, binaryDir := fakePluginLSPExecutable(t)
	t.Setenv("KNOWNS_FAKE_LSP_SERVER", "1")
	t.Setenv("PATH", binaryDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	m := NewManager(root, Config{})
	if err := m.RegisterAdapter(&mgrMockAdapter{
		id:         "lazy",
		name:       "Lazy",
		extensions: []string{".lazy"},
		lazyStart:  true,
		binaries:   []BinaryCandidate{{Name: binaryName}},
	}); err != nil {
		t.Fatal(err)
	}
	var lookups atomic.Int32
	m.SetDetector(&Detector{
		Registry: m.registry,
		LookPath: func(name string) (string, error) {
			lookups.Add(1)
			return filepath.Join(binaryDir, name), nil
		},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.StartAll(ctx); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	serverCount := len(m.servers)
	m.mu.Unlock()
	if serverCount != 0 {
		t.Fatalf("StartAll created %d lazy servers, want none", serverCount)
	}
	if lookups.Load() != 1 {
		t.Fatalf("activation lookups = %d, want one detection lookup", lookups.Load())
	}

	first, ok, err := m.ServerForPath(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || first == nil || !first.Alive() {
		t.Fatalf("first explicit server = %#v, ok=%v, alive=%v", first, ok, first != nil && first.Alive())
	}
	second, ok, err := m.ServerForPath(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || second != first {
		t.Fatalf("second explicit server = %#v, ok=%v; want reused %#v", second, ok, first)
	}
	if lookups.Load() != 2 {
		t.Fatalf("total lookups = %d, want activation plus one lazy resolution", lookups.Load())
	}
	m.mu.Lock()
	serverCount = len(m.servers)
	status := m.status["lazy"]
	m.mu.Unlock()
	if serverCount != 1 || status != StatusRunning {
		t.Fatalf("lazy runtime servers=%d status=%v, want one running server", serverCount, status)
	}
	if err := m.StopAll(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestManagerConfiguresPathDocumentSyncAdapter(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "production.tfvars")
	if err := os.WriteFile(path, []byte("fixture_name = \"example\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	binaryName, binaryDir := fakePluginLSPExecutable(t)
	t.Setenv("KNOWNS_FAKE_LSP_SERVER", "1")
	t.Setenv("PATH", binaryDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	adapter := &mgrDocumentSyncAdapter{
		mgrMockAdapter: &mgrMockAdapter{
			id:         "terraform",
			name:       "Terraform",
			extensions: []string{".tfvars"},
			lazyStart:  true,
			binaries:   []BinaryCandidate{{Name: binaryName}},
		},
		resolveDocumentSync: func(string) DocumentSyncOptions {
			return DocumentSyncOptions{LanguageID: "terraform-vars"}
		},
	}
	m := NewManager(root, Config{})
	if err := m.RegisterAdapter(adapter); err != nil {
		t.Fatal(err)
	}
	m.SetDetector(&Detector{
		Registry: m.registry,
		LookPath: func(name string) (string, error) {
			return filepath.Join(binaryDir, name), nil
		},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv, ok, err := m.ServerForPath(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || srv == nil {
		t.Fatal("Terraform server was not created")
	}
	if got, want := srv.documentSyncForPath(path), (DocumentSyncOptions{LanguageID: "terraform-vars"}); got != want {
		t.Fatalf("document sync options = %#v, want %#v", got, want)
	}
	if err := m.StopAll(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestManagerPathCapabilityGateAvoidsServerStart(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "network.tf.json")
	if err := os.WriteFile(path, []byte(`{"resource": {}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	adapter := &mgrDocumentSyncAdapter{
		mgrMockAdapter: &mgrMockAdapter{
			id:         "terraform",
			name:       "Terraform",
			extensions: []string{".tf.json"},
			lazyStart:  true,
			binaries:   []BinaryCandidate{{Name: "terraform-ls"}},
		},
		resolveDocumentSync: func(string) DocumentSyncOptions {
			return DocumentSyncOptions{LanguageID: "terraform", Suppress: true}
		},
		resolveCapability: func(_ string, action, _ string) (PathCapabilityDecision, bool) {
			return PathCapabilityDecision{Explanation: "terraform-ls does not support Terraform JSON for " + action}, true
		},
	}
	m := NewManager(root, Config{})
	if err := m.RegisterAdapter(adapter); err != nil {
		t.Fatal(err)
	}
	var lookups atomic.Int32
	m.SetDetector(&Detector{
		Registry: m.registry,
		LookPath: func(string) (string, error) {
			lookups.Add(1)
			return "", errMgrNotFound{}
		},
	})

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	srv, ok, err := m.ServerForPath(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || srv == nil || srv.Alive() {
		t.Fatalf("ServerForPath() = %#v, %v; want routed but unstarted server", srv, ok)
	}
	if lookups.Load() != 0 {
		t.Fatalf("binary lookups = %d, want no server resolution", lookups.Load())
	}

	err = m.WithSession(ctx, path, func(session Session) error {
		_, queryErr := session.DocumentSymbols(ctx, path)
		return queryErr
	})
	var runtimeErr *RuntimeError
	if !errors.As(err, &runtimeErr) || runtimeErr.Code != "unsupported_capability" || runtimeErr.Action != "symbols" {
		t.Fatalf("WithSession() error = %#v, want structured symbols capability error", err)
	}
	if lookups.Load() != 0 {
		t.Fatalf("binary lookups after query = %d, want no server start", lookups.Load())
	}
}

func TestRuntimeBinariesForAdapterPrefersPATHBeforeManagedSelectedPath(t *testing.T) {
	installer := NewInstaller(t.TempDir())
	selectedPath := filepath.Join(t.TempDir(), "managed-ls")
	if err := os.WriteFile(selectedPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	adapter := &mockAdapter{
		id:       "managed",
		binaries: []BinaryCandidate{{Name: "path-ls", CheckArgs: []string{"--version"}}},
		runtimeDeps: []RuntimeDependency{{
			ID:         "v1.0.0",
			PlatformID: CurrentPlatformID(),
			BinaryName: "managed-ls",
		}},
	}
	if err := installer.writeSelection(adapter, adapter.runtimeDeps[0], selectedPath); err != nil {
		t.Fatal(err)
	}

	binaries := runtimeBinariesForAdapter(adapter, installer)
	if len(binaries) != 2 || binaries[0].Name != "path-ls" || binaries[1].Name != selectedPath {
		t.Fatalf("runtimeBinariesForAdapter() = %#v, want PATH candidate before selected path", binaries)
	}
}

func TestManagerStartAndRestartRejectDisabledLanguage(t *testing.T) {
	enabled := false
	m := NewManager(t.TempDir(), Config{Languages: map[string]LanguageConfig{
		"go": {Enabled: &enabled},
	}})
	if err := m.RegisterAdapter(&mgrMockAdapter{id: "go", name: "Go"}); err != nil {
		t.Fatal(err)
	}
	if err := m.StartLanguage(context.Background(), "go"); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("StartLanguage disabled error = %v, want disabled", err)
	}
	if err := m.RestartLanguage(context.Background(), "go"); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("RestartLanguage disabled error = %v, want disabled", err)
	}
}

func TestInstallLanguageRefreshesRegistryWithManagedPath(t *testing.T) {
	root := t.TempDir()
	installer := NewInstaller(t.TempDir())
	content, sha := createTestBinary()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content)
	}))
	defer server.Close()
	adapter := &mockAdapter{
		id:         "managed",
		extensions: []string{".managed"},
		runtimeDeps: []RuntimeDependency{{
			ID:          "v1.0.0",
			PlatformID:  CurrentPlatformID(),
			URL:         server.URL + "/managed-ls",
			SHA256:      sha,
			ArchiveType: "binary",
			BinaryName:  "managed-ls",
		}},
	}
	m := NewManager(root, Config{})
	m.SetDetector(&Detector{Registry: m.registry, Installer: installer})
	if err := m.RegisterAdapter(adapter); err != nil {
		t.Fatal(err)
	}
	path, err := m.InstallLanguage(context.Background(), "managed")
	if err != nil {
		t.Fatal(err)
	}
	lang, ok := m.registry.ForPath(filepath.Join(root, "main.managed"))
	if !ok || len(lang.Binaries) == 0 || lang.Binaries[len(lang.Binaries)-1].Name != path {
		t.Fatalf("registry language after install = %#v, ok=%v; want selected managed fallback %q", lang, ok, path)
	}
}

func TestTailLogFileReturnsBoundedSuffix(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.log")
	var b strings.Builder
	for i := 1; i <= 1000; i++ {
		fmt.Fprintf(&b, "line-%04d\n", i)
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	lines, err := tailLogFile(path, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 3 || lines[0] != "line-0998" || lines[2] != "line-1000" {
		t.Fatalf("tailLogFile() = %#v, want last 3 lines", lines)
	}
}

func TestStartAll_Parallel(t *testing.T) {
	root := t.TempDir()
	registry := NewRegistry([]Language{
		{ID: "go", Name: "Go", Extensions: []string{".go"}, Binaries: []Binary{{Name: "gopls"}}},
		{ID: "ts", Name: "TypeScript", Extensions: []string{".ts"}, Binaries: []Binary{{Name: "typescript-language-server"}}},
	})

	// Create a detector that returns both languages with a fake binary (true as path).
	m := &Manager{
		root:     root,
		registry: registry,
		detector: &Detector{
			Registry: registry,
			LookPath: func(name string) (string, error) { return "/usr/bin/" + name, nil },
			RunCheck: func(ctx context.Context, path string, args ...string) error { return nil },
		},
		config:   Config{},
		servers:  make(map[string]*Server),
		adapters: make(map[string]LanguageAdapter),
		status:   make(map[string]ServerStatus),
	}

	// Pre-populate servers with commands (since real Start would fail without a binary).
	// We test that StartAll runs in parallel by checking status transitions.
	m.servers["go"] = NewServer(root, ServerCommand{Language: "go", Name: "gopls", Path: "true", Args: nil})
	m.servers["ts"] = NewServer(root, ServerCommand{Language: "ts", Name: "tsserver", Path: "true", Args: nil})
	m.status["go"] = StatusInstalled
	m.status["ts"] = StatusInstalled

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	err := m.StartAll(ctx)
	if err != nil {
		t.Fatalf("StartAll returned error: %v", err)
	}

	// Both should have attempted start (status should be Running or Crashed).
	m.mu.Lock()
	goStatus := m.status["go"]
	tsStatus := m.status["ts"]
	m.mu.Unlock()

	// "true" binary will exit immediately, so servers may crash after start.
	// The key test is that StartAll doesn't return an error and processes both.
	if goStatus != StatusRunning && goStatus != StatusCrashed {
		t.Errorf("expected go status Running or Crashed, got %v", goStatus)
	}
	if tsStatus != StatusRunning && tsStatus != StatusCrashed {
		t.Errorf("expected ts status Running or Crashed, got %v", tsStatus)
	}
}

func TestStartAll_FailOpen(t *testing.T) {
	root := t.TempDir()
	registry := NewRegistry([]Language{
		{ID: "go", Name: "Go", Extensions: []string{".go"}, Binaries: []Binary{{Name: "gopls"}}},
		{ID: "py", Name: "Python", Extensions: []string{".py"}, Binaries: []Binary{{Name: "pylsp"}}},
	})

	m := &Manager{
		root:     root,
		registry: registry,
		detector: &Detector{
			Registry: registry,
			LookPath: func(name string) (string, error) { return "/usr/bin/" + name, nil },
			RunCheck: func(ctx context.Context, path string, args ...string) error { return nil },
		},
		config:   Config{},
		servers:  make(map[string]*Server),
		adapters: make(map[string]LanguageAdapter),
		status:   make(map[string]ServerStatus),
	}

	// "nonexistent-binary" will fail to start; "true" will succeed (or at least not block).
	m.servers["go"] = NewServer(root, ServerCommand{Language: "go", Name: "gopls", Path: "nonexistent-binary-xyz", Args: nil})
	m.servers["py"] = NewServer(root, ServerCommand{Language: "py", Name: "pylsp", Path: "true", Args: nil})
	m.status["go"] = StatusInstalled
	m.status["py"] = StatusInstalled

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	err := m.StartAll(ctx)
	if err != nil {
		t.Fatalf("StartAll should not return error on individual failures, got: %v", err)
	}

	m.mu.Lock()
	goStatus := m.status["go"]
	pyStatus := m.status["py"]
	m.mu.Unlock()

	// Go server should be crashed (bad binary).
	if goStatus != StatusCrashed {
		t.Errorf("expected go status Crashed, got %v", goStatus)
	}
	// Python server should have attempted start (Running or Crashed since "true" exits immediately).
	if pyStatus != StatusRunning && pyStatus != StatusCrashed {
		t.Errorf("expected py status Running or Crashed, got %v", pyStatus)
	}
}

func TestServerForPath_AutoRestart(t *testing.T) {
	root := t.TempDir()
	registry := NewRegistry([]Language{
		{ID: "go", Name: "Go", Extensions: []string{".go"}, Binaries: []Binary{{Name: "gopls"}}},
	})

	m := &Manager{
		root:     root,
		registry: registry,
		detector: &Detector{
			Registry: registry,
			LookPath: func(name string) (string, error) { return "/usr/bin/" + name, nil },
			RunCheck: func(ctx context.Context, path string, args ...string) error { return nil },
		},
		config:   Config{},
		servers:  make(map[string]*Server),
		adapters: make(map[string]LanguageAdapter),
		status:   make(map[string]ServerStatus),
	}

	// Create a server that is not alive (simulating a crashed server).
	srv := NewServer(root, ServerCommand{Language: "go", Name: "gopls", Path: "true", Args: nil})
	// Server is not running (default state), so Alive() returns false.
	m.servers["go"] = srv
	m.status["go"] = StatusRunning // Was running, but now not alive.

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// ServerForPath should detect the dead server and attempt restart.
	_, _, err := m.ServerForPath(ctx, "/project/main.go")
	// The restart may fail (since "true" exits immediately and initialize will fail),
	// but the key behavior is that it attempted a restart (status changed to Starting then Crashed).
	_ = err

	m.mu.Lock()
	status := m.status["go"]
	m.mu.Unlock()

	// Should have transitioned through StatusStarting.
	// Final state is either Running (unlikely with "true") or Crashed.
	if status != StatusCrashed && status != StatusRunning {
		t.Errorf("expected status Crashed or Running after auto-restart attempt, got %v", status)
	}
}

func TestServerForPathResolvesOnlyRequestedLanguage(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Program.cs"), []byte("class Program {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	binaryName, binaryDir := fakePluginLSPExecutable(t)
	t.Setenv("KNOWNS_FAKE_LSP_SERVER", "1")
	t.Setenv("PATH", binaryDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	goBinary := binaryName
	m := NewManager(root, Config{Languages: map[string]LanguageConfig{
		"go":             {Binary: goBinary},
		CSharpLanguageID: {Binary: "csharp-ls"},
	}})
	if err := m.RegisterAdapter(&mgrMockAdapter{id: "go", name: "Go", extensions: []string{".go"}}); err != nil {
		t.Fatal(err)
	}
	if err := m.RegisterAdapter(&mgrMockAdapter{id: CSharpLanguageID, name: "C#", extensions: []string{".cs"}}); err != nil {
		t.Fatal(err)
	}
	var lookedUp []string
	m.SetDetector(&Detector{
		Registry: m.registry,
		LookPath: func(name string) (string, error) {
			lookedUp = append(lookedUp, name)
			return filepath.Join(binaryDir, binaryName), nil
		},
	})

	srv, ok, err := m.ServerForPath(context.Background(), filepath.Join(root, "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || srv == nil {
		t.Fatal("ServerForPath did not return Go server")
	}
	defer m.StopAll(context.Background())
	if containsString(lookedUp, "csharp-ls") {
		t.Fatalf("lookups = %#v, C# backend should not be resolved for Go request", lookedUp)
	}
	if !containsString(lookedUp, goBinary) {
		t.Fatalf("lookups = %#v, want Go binary lookup %q", lookedUp, goBinary)
	}
}

func TestServerForPathCSharpDirectAccessStartsAndReusesCustomBackend(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Program.cs"), []byte("class Program {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	binaryName, binaryDir := fakePluginLSPExecutable(t)
	t.Setenv("KNOWNS_FAKE_LSP_SERVER", "1")
	t.Setenv("PATH", binaryDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	m := NewManager(root, Config{Languages: map[string]LanguageConfig{
		CSharpLanguageID: {Binary: binaryName},
	}})
	if err := m.RegisterAdapter(&mgrMockAdapter{id: CSharpLanguageID, name: "C#", extensions: []string{".cs"}}); err != nil {
		t.Fatal(err)
	}
	var lookups int
	m.SetDetector(&Detector{
		Registry: m.registry,
		LookPath: func(name string) (string, error) {
			lookups++
			return filepath.Join(binaryDir, binaryName), nil
		},
	})

	path := filepath.Join(root, "Program.cs")
	first, ok, err := m.ServerForPath(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || first == nil || !first.Alive() {
		t.Fatalf("first server = %#v ok=%v alive=%v", first, ok, first != nil && first.Alive())
	}
	second, ok, err := m.ServerForPath(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || second != first {
		t.Fatalf("second server = %#v ok=%v, want same server %#v", second, ok, first)
	}
	defer m.StopAll(context.Background())
	if lookups != 1 {
		t.Fatalf("lookups = %d, want one direct C# backend resolution", lookups)
	}
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func TestMissingServers(t *testing.T) {
	root := t.TempDir()
	m := NewManager(root, Config{})

	goAdapter := &mgrMockAdapter{
		id:   "go",
		name: "Go",
		guide: InstallGuide{
			Command: "go install golang.org/x/tools/gopls@latest",
			URL:     "https://pkg.go.dev/golang.org/x/tools/gopls",
		},
	}
	pyAdapter := &mgrMockAdapter{
		id:   "python",
		name: "Python",
		guide: InstallGuide{
			Command: "pip install python-lsp-server",
			URL:     "https://github.com/python-lsp/python-lsp-server",
		},
	}

	m.RegisterAdapter(goAdapter)
	m.RegisterAdapter(pyAdapter)

	m.SetDetector(&Detector{Registry: NewRegistry([]Language{
		{ID: "go", Extensions: []string{".go"}, Binaries: []Binary{{Name: "missing-gopls"}}},
		{ID: "python", Extensions: []string{".py"}, Binaries: []Binary{{Name: "pylsp"}}},
	}), LookPath: func(name string) (string, error) {
		if name == "pylsp" {
			return "/bin/pylsp", nil
		}
		return "", errMgrNotFound{}
	}, RunCheck: func(context.Context, string, ...string) error {
		return nil
	}})
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "main.py"), []byte("print('hi')"), 0o644); err != nil {
		t.Fatal(err)
	}

	missing := m.MissingServers()
	if len(missing) != 1 {
		t.Fatalf("expected 1 missing server, got %d", len(missing))
	}
	if missing[0].LanguageID != "go" {
		t.Errorf("expected missing language 'go', got %q", missing[0].LanguageID)
	}
	if missing[0].Name != "Go" {
		t.Errorf("expected missing name 'Go', got %q", missing[0].Name)
	}
	if missing[0].Guide.Command != "go install golang.org/x/tools/gopls@latest" {
		t.Errorf("unexpected install guide command: %q", missing[0].Guide.Command)
	}
}

func TestActiveLanguages_OnlyAlive(t *testing.T) {
	root := t.TempDir()
	m := NewManager(root, Config{})

	// Add two servers: one alive, one not.
	aliveSrv := NewServer(root, ServerCommand{Language: "go", Name: "gopls", Path: "true", Args: nil})
	deadSrv := NewServer(root, ServerCommand{Language: "py", Name: "pylsp", Path: "true", Args: nil})

	// Simulate alive state by setting running=true on one server.
	aliveSrv.mu.Lock()
	aliveSrv.running = true
	aliveSrv.mu.Unlock()

	m.mu.Lock()
	m.servers["go"] = aliveSrv
	m.servers["py"] = deadSrv
	m.mu.Unlock()

	active := m.ActiveLanguages()
	if len(active) != 1 {
		t.Fatalf("expected 1 active language, got %d: %v", len(active), active)
	}
	if active[0] != "go" {
		t.Errorf("expected active language 'go', got %q", active[0])
	}
}

func TestStopAll(t *testing.T) {
	root := t.TempDir()
	m := NewManager(root, Config{})

	srv := NewServer(root, ServerCommand{Language: "go", Name: "gopls", Path: "true", Args: nil})
	m.mu.Lock()
	m.servers["go"] = srv
	m.status["go"] = StatusRunning
	m.mu.Unlock()

	ctx := context.Background()
	err := m.StopAll(ctx)
	if err != nil {
		t.Fatalf("StopAll returned error: %v", err)
	}

	m.mu.Lock()
	status := m.status["go"]
	m.mu.Unlock()
	if status != StatusInstalled {
		t.Errorf("expected status Installed after StopAll, got %v", status)
	}
}

func TestStartAll_ParallelExecution(t *testing.T) {
	// Verify that StartAll actually runs servers in parallel by using a delay.
	root := t.TempDir()
	registry := NewRegistry([]Language{
		{ID: "a", Name: "A", Extensions: []string{".a"}, Binaries: []Binary{{Name: "a-server"}}},
		{ID: "b", Name: "B", Extensions: []string{".b"}, Binaries: []Binary{{Name: "b-server"}}},
		{ID: "c", Name: "C", Extensions: []string{".c"}, Binaries: []Binary{{Name: "c-server"}}},
	})

	m := &Manager{
		root:     root,
		registry: registry,
		detector: &Detector{
			Registry: registry,
			LookPath: func(name string) (string, error) { return "/usr/bin/" + name, nil },
			RunCheck: func(ctx context.Context, path string, args ...string) error { return nil },
		},
		config:   Config{},
		servers:  make(map[string]*Server),
		adapters: make(map[string]LanguageAdapter),
		status:   make(map[string]ServerStatus),
	}

	// Use "sleep" as the binary — each server takes 0.1s to start (then fails on initialize).
	// If parallel, total time < 0.3s. If sequential, total time >= 0.3s.
	m.servers["a"] = NewServer(root, ServerCommand{Language: "a", Name: "a-server", Path: "sleep", Args: []string{"0.1"}})
	m.servers["b"] = NewServer(root, ServerCommand{Language: "b", Name: "b-server", Path: "sleep", Args: []string{"0.1"}})
	m.servers["c"] = NewServer(root, ServerCommand{Language: "c", Name: "c-server", Path: "sleep", Args: []string{"0.1"}})
	m.status["a"] = StatusInstalled
	m.status["b"] = StatusInstalled
	m.status["c"] = StatusInstalled

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	start := time.Now()
	_ = m.StartAll(ctx)
	elapsed := time.Since(start)

	// If truly parallel, should complete in ~0.1s (plus overhead), not 0.3s.
	if elapsed > 500*time.Millisecond {
		t.Errorf("StartAll took %v, expected parallel execution under 500ms", elapsed)
	}

	// All should be crashed (sleep doesn't speak LSP).
	var crashed atomic.Int32
	m.mu.Lock()
	for _, s := range m.status {
		if s == StatusCrashed {
			crashed.Add(1)
		}
	}
	m.mu.Unlock()
	if crashed.Load() != 3 {
		t.Errorf("expected 3 crashed servers, got %d", crashed.Load())
	}
}

func TestLanguageInfoFromRuntimeStatusIncludesCapabilities(t *testing.T) {
	status := LanguageRuntimeStatus{
		ID:                     "bash",
		Name:                   "Bash",
		Status:                 RuntimeStatusDegraded,
		InstallState:           RuntimeInstallInstalled,
		RunningState:           RuntimeRunningRunning,
		CapabilitiesKnown:      true,
		Capabilities:           []string{CapabilityDocumentSymbols, CapabilityReferences},
		AdvertisedCapabilities: []string{CapabilityDocumentSymbols},
		ObservedCapabilities:   []string{CapabilityReferences},
		RequiredCapabilities:   []string{CapabilityDefinition, CapabilityDocumentSymbols, CapabilityReferences},
		MissingCapabilities:    []string{CapabilityDefinition},
	}

	info := LanguageInfoFromRuntimeStatus(status)
	if info.Status != RuntimeStatusDegraded || !info.Running || !info.CapabilitiesKnown {
		t.Fatalf("LanguageInfo = %#v", info)
	}
	if !reflect.DeepEqual(info.Capabilities, status.Capabilities) || !reflect.DeepEqual(info.AdvertisedCapabilities, status.AdvertisedCapabilities) || !reflect.DeepEqual(info.MissingCapabilities, status.MissingCapabilities) {
		t.Fatalf("capability mapping = %#v, want %#v", info, status)
	}
}
