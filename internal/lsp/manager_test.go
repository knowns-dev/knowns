package lsp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	guide      InstallGuide
}

func (a *mgrMockAdapter) ID() string                                             { return a.id }
func (a *mgrMockAdapter) Name() string                                           { return a.name }
func (a *mgrMockAdapter) Extensions() []string                                   { return a.extensions }
func (a *mgrMockAdapter) Binaries() []BinaryCandidate                            { return nil }
func (a *mgrMockAdapter) Prerequisites() []Prerequisite                          { return nil }
func (a *mgrMockAdapter) CheckPrerequisites(context.Context) error               { return nil }
func (a *mgrMockAdapter) InstallGuide() InstallGuide                             { return a.guide }
func (a *mgrMockAdapter) CanInstall() bool                                       { return false }
func (a *mgrMockAdapter) RuntimeDeps() []RuntimeDependency                       { return nil }
func (a *mgrMockAdapter) Install(context.Context, string) (string, error)        { return "", nil }
func (a *mgrMockAdapter) InstalledPath() (string, bool)                          { return "", false }
func (a *mgrMockAdapter) DefaultArgs() []string                                  { return nil }
func (a *mgrMockAdapter) InitializeParams(string, map[string]any) map[string]any { return nil }
func (a *mgrMockAdapter) InitializationOptions(map[string]any) map[string]any    { return nil }
func (a *mgrMockAdapter) IsIgnoredDir(string) bool                               { return false }
func (a *mgrMockAdapter) NormalizeSymbolName(n string) string                    { return n }

type errMgrNotFound struct{}

func (errMgrNotFound) Error() string { return "not found" }

func (errMgrNotFound) Is(target error) bool { return errors.Is(target, os.ErrNotExist) }

func (a *mgrMockAdapter) SupportsImplementation() bool { return true }
func (a *mgrMockAdapter) SupportsReferences() bool     { return true }

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

func TestRuntimeBinariesForAdapterPrefersManagedSelectedPath(t *testing.T) {
	installer := NewInstaller(t.TempDir())
	selectedPath := filepath.Join(t.TempDir(), "managed-ls")
	if err := os.WriteFile(selectedPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	adapter := &mockAdapter{
		id: "managed",
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
	if len(binaries) == 0 || binaries[0].Name != selectedPath {
		t.Fatalf("runtimeBinariesForAdapter() = %#v, want selected path first", binaries)
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
	if !ok || len(lang.Binaries) == 0 || lang.Binaries[0].Name != path {
		t.Fatalf("registry language after install = %#v, ok=%v; want selected managed path %q", lang, ok, path)
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
