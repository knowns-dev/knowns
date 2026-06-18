package routes

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/storage"
)

type routeLSPAdapter struct {
	id        string
	name      string
	exts      []string
	binaries  []lsp.BinaryCandidate
	guide     lsp.InstallGuide
	installFn func(context.Context, string) (string, error)
}

func (a routeLSPAdapter) ID() string                               { return a.id }
func (a routeLSPAdapter) Name() string                             { return a.name }
func (a routeLSPAdapter) Extensions() []string                     { return a.exts }
func (a routeLSPAdapter) Binaries() []lsp.BinaryCandidate          { return a.binaries }
func (a routeLSPAdapter) Prerequisites() []lsp.Prerequisite        { return nil }
func (a routeLSPAdapter) CheckPrerequisites(context.Context) error { return nil }
func (a routeLSPAdapter) InstallGuide() lsp.InstallGuide           { return a.guide }
func (a routeLSPAdapter) CanInstall() bool                         { return a.installFn != nil }
func (a routeLSPAdapter) RuntimeDeps() []lsp.RuntimeDependency     { return nil }
func (a routeLSPAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	if a.installFn == nil {
		return "", fmt.Errorf("not installable")
	}
	return a.installFn(ctx, targetDir)
}
func (a routeLSPAdapter) InstalledPath() (string, bool)                          { return "", false }
func (a routeLSPAdapter) DefaultArgs() []string                                  { return nil }
func (a routeLSPAdapter) InitializeParams(string, map[string]any) map[string]any { return nil }
func (a routeLSPAdapter) InitializationOptions(map[string]any) map[string]any    { return nil }
func (a routeLSPAdapter) IsIgnoredDir(string) bool                               { return false }
func (a routeLSPAdapter) NormalizeSymbolName(name string) string                 { return name }
func (a routeLSPAdapter) SupportsImplementation() bool                           { return true }
func (a routeLSPAdapter) SupportsReferences() bool                               { return true }

func TestLSPRoutesPatchConfigPersistsAndRefreshesManager(t *testing.T) {
	store := setupLSPRouteStore(t)
	root := filepath.Dir(store.Root)
	manager := lsp.NewManager(root, lsp.Config{})
	if err := manager.RegisterAdapter(routeLSPAdapter{id: lsp.CSharpLanguageID, name: "C#", exts: []string{".cs"}}); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	(&LSPRoutes{store: store, lspMgr: manager}).Register(router)

	body := bytes.NewBufferString(`{"backend":"omnisharp","projectPath":"src/App.sln","version":"1.2.3","binary":"/tmp/csharp-ls","settings":{"dotnetBootstrapCommand":"echo ok"}}`)
	req := httptest.NewRequest("PATCH", "/languages/csharp/config", body)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, want 200: %s", w.Code, w.Body.String())
	}

	project, err := store.Config.Load()
	if err != nil {
		t.Fatal(err)
	}
	settings := project.Settings.LSP.Languages[lsp.CSharpLanguageID]
	if settings.Backend != lsp.CSharpBackendOmni || settings.ProjectPath != "src/App.sln" || settings.Version != "1.2.3" || settings.Binary != "/tmp/csharp-ls" {
		t.Fatalf("persisted settings = %+v", settings)
	}
	if settings.Settings["dotnetBootstrapCommand"] != "echo ok" {
		t.Fatalf("nested settings = %#v", settings.Settings)
	}
	cfg := manager.Config()
	if cfg.BackendOverride(lsp.CSharpLanguageID) != lsp.CSharpBackendOmni || cfg.ProjectPathOverride(lsp.CSharpLanguageID) != "src/App.sln" {
		t.Fatalf("manager config was not refreshed: %#v", cfg)
	}
}

func TestLSPRoutesRestartLogsAndTrace(t *testing.T) {
	if os.Getenv("KNOWNS_ROUTE_LSP_HELPER") == "1" {
		runRouteFakeLSPServer()
		return
	}

	store := setupLSPRouteStore(t)
	root := filepath.Dir(store.Root)
	manager := lsp.NewManager(root, lsp.Config{})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.StopAll(ctx)
	})
	t.Setenv("KNOWNS_ROUTE_LSP_HELPER", "1")
	if err := manager.RegisterAdapter(routeLSPAdapter{
		id:   "toy",
		name: "Toy",
		exts: []string{".toy"},
		binaries: []lsp.BinaryCandidate{{
			Name: os.Args[0],
			Args: []string{"-test.run=TestLSPRoutesRestartLogsAndTrace"},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	(&LSPRoutes{store: store, lspMgr: manager}).Register(router)

	req := httptest.NewRequest("POST", "/languages/toy/restart", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("restart status = %d, want 200: %s", w.Code, w.Body.String())
	}
	var restartPayload map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &restartPayload); err != nil {
		t.Fatalf("decode restart payload: %v", err)
	}
	if restartPayload["action"] != "restarted" {
		t.Fatalf("restart payload = %#v", restartPayload)
	}

	logPath := lsp.LanguageLogPath(root, "toy")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logPath, []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest("GET", "/languages/toy/logs?kind=runtime&tail=2", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("logs status = %d, want 200: %s", w.Code, w.Body.String())
	}
	var logs struct {
		LogPath string   `json:"logPath"`
		Content string   `json:"content"`
		Lines   []string `json:"lines"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &logs); err != nil {
		t.Fatalf("decode logs: %v", err)
	}
	if logs.LogPath != logPath || logs.Content != "two\nthree" || len(logs.Lines) != 2 {
		t.Fatalf("logs payload = %#v", logs)
	}

	req = httptest.NewRequest("POST", "/languages/toy/trace", bytes.NewBufferString(`{"enabled":true}`))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("trace status = %d, want 200: %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(lsp.LanguageTraceLogPath(root, "toy")); err != nil {
		t.Fatalf("trace log not created: %v", err)
	}
	req = httptest.NewRequest("GET", "/languages", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200: %s", w.Code, w.Body.String())
	}
	var listPayload struct {
		Languages []lsp.LanguageInfo `json:"languages"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listPayload); err != nil {
		t.Fatalf("decode list payload: %v", err)
	}
	if len(listPayload.Languages) != 1 || !listPayload.Languages[0].TraceEnabled {
		t.Fatalf("list trace state = %#v, want enabled", listPayload.Languages)
	}
}

func TestLSPRoutesInstallAndCleanupUseManagerLifecycle(t *testing.T) {
	store := setupLSPRouteStore(t)
	root := filepath.Dir(store.Root)
	manager := lsp.NewManager(root, lsp.Config{})
	if err := manager.RegisterAdapter(routeLSPAdapter{
		id:    "installable",
		name:  "Installable",
		guide: lsp.InstallGuide{KnownsCmd: "knowns lsp install installable"},
		installFn: func(_ context.Context, targetDir string) (string, error) {
			path := filepath.Join(targetDir, "installable", "bin", "installable-ls")
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return "", err
			}
			return path, os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755)
		},
	}); err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	(&LSPRoutes{store: store, lspMgr: manager}).Register(router)

	req := httptest.NewRequest("POST", "/languages/installable/install", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("install status = %d, want 200: %s", w.Code, w.Body.String())
	}
	var installPayload map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &installPayload); err != nil {
		t.Fatalf("decode install payload: %v", err)
	}
	path, _ := installPayload["path"].(string)
	if path == "" {
		t.Fatalf("install payload missing path: %#v", installPayload)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("installed marker missing: %v", err)
	}

	req = httptest.NewRequest("POST", "/languages/installable/cleanup", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("cleanup status = %d, want 200: %s", w.Code, w.Body.String())
	}
}

func setupLSPRouteStore(t *testing.T) *storage.Store {
	t.Helper()
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("lsp-route-test"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return store
}

func runRouteFakeLSPServer() {
	reader := bufio.NewReader(os.Stdin)
	for {
		message, err := routeReadLSPMessage(reader)
		if err != nil {
			if err == io.EOF {
				return
			}
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		var envelope struct {
			ID     *int64 `json:"id"`
			Method string `json:"method"`
		}
		if err := json.Unmarshal(message, &envelope); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		switch envelope.Method {
		case "initialize":
			routeWriteLSPMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": map[string]any{"capabilities": map[string]any{}}})
		case "shutdown":
			if envelope.ID != nil {
				routeWriteLSPMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": nil})
			}
		case "exit":
			return
		}
	}
}

func routeReadLSPMessage(reader *bufio.Reader) ([]byte, error) {
	var length int
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		if strings.HasPrefix(strings.ToLower(line), "content-length:") {
			_, _ = fmt.Sscanf(line, "Content-Length: %d", &length)
		}
	}
	if length <= 0 {
		return nil, fmt.Errorf("missing content length")
	}
	message := make([]byte, length)
	_, err := io.ReadFull(reader, message)
	return message, err
}

func routeWriteLSPMessage(message any) {
	data, err := json.Marshal(message)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	fmt.Fprintf(os.Stdout, "Content-Length: %d\r\n\r\n%s", len(data), data)
}
