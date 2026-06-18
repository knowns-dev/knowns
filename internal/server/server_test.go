package server

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/agents/opencode"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimememory"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestDeriveOpenCodePortCandidates(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		browserPort int
		defaultPort int
		want        []int
	}{
		{
			name:        "derives browser based ports",
			browserPort: 6420,
			defaultPort: 4096,
			want:        []int{64200, 64201, 64202},
		},
		{
			name:        "falls back to default range when derived ports overflow",
			browserPort: 7000,
			defaultPort: 4096,
			want:        []int{4096, 4097, 4098},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := deriveOpenCodePortCandidates(tt.browserPort, tt.defaultPort)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("deriveOpenCodePortCandidates(%d, %d) = %v, want %v", tt.browserPort, tt.defaultPort, got, tt.want)
			}
		})
	}
}

func TestResolveOpenCodeConfig(t *testing.T) {
	t.Parallel()

	t.Run("uses explicit configured port as-is", func(t *testing.T) {
		t.Parallel()

		resolution := resolveOpenCodeConfig(6420, &models.OpenCodeServerConfig{
			Host: "127.0.0.1",
			Port: 5001,
		})

		if !resolution.configured {
			t.Fatal("expected configuration to be enabled")
		}
		if !resolution.explicitPort {
			t.Fatal("expected explicitPort to be true")
		}
		if resolution.mode != opencode.RuntimeModeManaged {
			t.Fatalf("expected managed mode, got %q", resolution.mode)
		}
		if resolution.cfg.Port != 5001 {
			t.Fatalf("expected explicit port 5001, got %d", resolution.cfg.Port)
		}
	})

	t.Run("derives port from browser port when port is unset", func(t *testing.T) {
		t.Parallel()

		resolution := resolveOpenCodeConfig(6420, &models.OpenCodeServerConfig{
			Host: "127.0.0.1",
		})

		if !resolution.configured {
			t.Fatal("expected configuration to be enabled")
		}
		if resolution.explicitPort {
			t.Fatal("expected explicitPort to be false")
		}
		if resolution.mode != opencode.RuntimeModeManaged {
			t.Fatalf("expected managed mode, got %q", resolution.mode)
		}
		if resolution.cfg.Port != 64200 {
			t.Fatalf("expected derived port 64200, got %d", resolution.cfg.Port)
		}
	})

	t.Run("derives config even when opencodeServer is missing", func(t *testing.T) {
		t.Parallel()

		resolution := resolveOpenCodeConfig(6420, nil)

		if !resolution.configured {
			t.Fatal("expected configuration to be enabled")
		}
		if resolution.explicitPort {
			t.Fatal("expected explicitPort to be false")
		}
		if resolution.mode != opencode.RuntimeModeManaged {
			t.Fatalf("expected managed mode, got %q", resolution.mode)
		}
		if resolution.cfg.Host != "127.0.0.1" {
			t.Fatalf("expected default host 127.0.0.1, got %s", resolution.cfg.Host)
		}
		if resolution.cfg.Port != 64200 {
			t.Fatalf("expected derived port 64200, got %d", resolution.cfg.Port)
		}
	})

	t.Run("supports explicit external mode", func(t *testing.T) {
		t.Parallel()

		resolution := resolveOpenCodeConfig(6420, &models.OpenCodeServerConfig{
			Mode: "external",
			Host: "10.0.0.2",
			Port: 4096,
		})

		if resolution.mode != opencode.RuntimeModeExternal {
			t.Fatalf("expected external mode, got %q", resolution.mode)
		}
		if resolution.cfg.Host != "10.0.0.2" || resolution.cfg.Port != 4096 {
			t.Fatalf("unexpected config: %+v", resolution.cfg)
		}
	})
}

func TestGetOpenCodeStatusReturnsStructuredRuntimeStatus(t *testing.T) {
	t.Parallel()

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/global/health":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"healthy":true,"version":"1.5.0"}`))
		case "/config":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		case "/agent":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer target.Close()

	cfg := opencode.DefaultConfig()
	serverURL := target.URL
	cfg.Host = serverURL[len("http://"):strings.LastIndex(serverURL, ":")]
	var err error
	cfg.Port, err = strconv.Atoi(serverURL[strings.LastIndex(serverURL, ":")+1:])
	if err != nil {
		t.Fatalf("parse port: %v", err)
	}

	s := &Server{
		runtimeOpenCode: &cfg,
		runtimeStatus: opencode.RuntimeStatus{
			Configured:   true,
			Mode:         opencode.RuntimeModeExternal,
			State:        opencode.RuntimeStateDegraded,
			Host:         cfg.Host,
			Port:         cfg.Port,
			CLIInstalled: false,
		},
	}

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/opencode/status", nil)
	s.getOpenCodeStatus(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}
	body := rr.Body.String()
	for _, want := range []string{`"mode":"external"`, `"state":"ready"`, `"ready":true`, `"version":"1.5.0"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("response missing %s: %s", want, body)
		}
	}
}

func TestProxyOpenCodeReturnsServiceUnavailableWhenRuntimeNotReady(t *testing.T) {
	t.Parallel()

	s := &Server{
		runtimeStatus: opencode.RuntimeStatus{
			Configured: true,
			Mode:       opencode.RuntimeModeManaged,
			State:      opencode.RuntimeStateDegraded,
			LastError:  "OpenCode runtime is not ready",
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/opencode/session", nil)
	rr := httptest.NewRecorder()
	s.proxyOpenCode(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusServiceUnavailable)
	}
	if !strings.Contains(rr.Body.String(), "not ready") {
		t.Fatalf("unexpected body: %s", rr.Body.String())
	}
}

func TestProxyOpenCodeInjectsDirectoryHeaderWhenMissing(t *testing.T) {
	t.Parallel()

	var gotHeader string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("x-opencode-directory")
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	cfg := opencode.DefaultConfig()
	serverURL := target.URL
	cfg.Host = serverURL[len("http://"):strings.LastIndex(serverURL, ":")]
	var err error
	cfg.Port, err = strconv.Atoi(serverURL[strings.LastIndex(serverURL, ":")+1:])
	if err != nil {
		t.Fatalf("parse port: %v", err)
	}

	s := &Server{
		projectRoot:     "/tmp/project-a",
		runtimeOpenCode: &cfg,
		opencodeProxy:   buildOpenCodeProxy(cfg),
		runtimeStatus: opencode.RuntimeStatus{
			Configured: true,
			Mode:       opencode.RuntimeModeManaged,
			State:      opencode.RuntimeStateReady,
			Ready:      true,
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/opencode/session/abc/prompt_async", nil)
	rr := httptest.NewRecorder()

	s.proxyOpenCode(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}
	if gotHeader != "/tmp/project-a" {
		t.Fatalf("x-opencode-directory = %q, want %q", gotHeader, "/tmp/project-a")
	}
}

func TestProxyOpenCodePreservesExistingDirectoryHeader(t *testing.T) {
	t.Parallel()

	var gotHeader string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("x-opencode-directory")
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	cfg := opencode.DefaultConfig()
	serverURL := target.URL
	cfg.Host = serverURL[len("http://"):strings.LastIndex(serverURL, ":")]
	var err error
	cfg.Port, err = strconv.Atoi(serverURL[strings.LastIndex(serverURL, ":")+1:])
	if err != nil {
		t.Fatalf("parse port: %v", err)
	}

	s := &Server{
		projectRoot:     "/tmp/project-a",
		runtimeOpenCode: &cfg,
		opencodeProxy:   buildOpenCodeProxy(cfg),
		runtimeStatus: opencode.RuntimeStatus{
			Configured: true,
			Mode:       opencode.RuntimeModeManaged,
			State:      opencode.RuntimeStateReady,
			Ready:      true,
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/api/opencode/session/abc/prompt_async", nil)
	req.Header.Set("x-opencode-directory", "/tmp/project-b")
	rr := httptest.NewRecorder()

	s.proxyOpenCode(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}
	if gotHeader != "/tmp/project-b" {
		t.Fatalf("x-opencode-directory = %q, want %q", gotHeader, "/tmp/project-b")
	}
}

func TestProxyOpenCodeInjectsRuntimeMemoryInAutoMode(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	if err := store.Memory.Create(&models.MemoryEntry{Title: "Runtime queue pattern", Layer: models.MemoryLayerProject, Category: "pattern", Content: "Use the runtime queue pattern when handling prompt execution.", Tags: []string{"runtime", "queue", "prompt"}, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	project.Settings.RuntimeMemory = &models.RuntimeMemorySettings{Mode: runtimememory.ModeAuto, MaxItems: 5, MaxBytes: 2500}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save config: %v", err)
	}

	var gotHeader, gotBody string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("x-opencode-directory")
		data, _ := io.ReadAll(r.Body)
		gotBody = string(data)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	cfg := opencode.DefaultConfig()
	serverURL := target.URL
	cfg.Host = serverURL[len("http://"):strings.LastIndex(serverURL, ":")]
	cfg.Port, err = strconv.Atoi(serverURL[strings.LastIndex(serverURL, ":")+1:])
	if err != nil {
		t.Fatalf("parse port: %v", err)
	}

	s := &Server{
		store:           store,
		projectRoot:     projectRoot,
		runtimeOpenCode: &cfg,
		opencodeProxy:   buildOpenCodeProxy(cfg),
		runtimeStatus:   opencode.RuntimeStatus{Configured: true, Mode: opencode.RuntimeModeManaged, State: opencode.RuntimeStateReady, Ready: true},
	}

	body := `{"parts":[{"type":"text","text":"implement runtime queue prompt execution"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/opencode/session/abc/prompt_async", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	s.proxyOpenCode(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}
	if gotHeader != projectRoot {
		t.Fatalf("x-opencode-directory = %q, want %q", gotHeader, projectRoot)
	}
	if !strings.Contains(gotBody, "Knowns Guidance") || !strings.Contains(gotBody, "memory({ action:") {
		t.Fatalf("expected lightweight injected memory guidance in body, got %s", gotBody)
	}
	if !strings.Contains(gotBody, "Runtime queue pattern") || !strings.Contains(gotBody, "Use the runtime queue pattern when handling prompt execution.") {
		t.Fatalf("expected compact memory fact card in body, got %s", gotBody)
	}
	if strings.Contains(gotBody, "Score:") || strings.Contains(gotBody, "Reasons:") || strings.Contains(gotBody, "keyword-overlap") {
		t.Fatalf("did not expect debug scoring metadata in body, got %s", gotBody)
	}
	if rr.Header().Get(runtimememory.HeaderStatus) != runtimememory.StatusInjected {
		t.Fatalf("status header = %q, want %q", rr.Header().Get(runtimememory.HeaderStatus), runtimememory.StatusInjected)
	}
	if rr.Header().Get(runtimememory.HeaderPack) == "" {
		t.Fatal("expected memory pack header")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(rr.Header().Get(runtimememory.HeaderPack))
	if err != nil {
		t.Fatalf("decode pack header: %v", err)
	}
	if !strings.Contains(string(decoded), "Runtime queue pattern") {
		t.Fatalf("decoded pack missing injected memory: %s", string(decoded))
	}
}

func TestProxyOpenCodeSkipsInjectionWhenNoRelevantMemoryExists(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	project.Settings.RuntimeMemory = &models.RuntimeMemorySettings{Mode: runtimememory.ModeAuto}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save config: %v", err)
	}
	if err := store.Memory.Create(&models.MemoryEntry{Title: "Landing page preference", Layer: models.MemoryLayerProject, Category: "preference", Content: "Prefer editorial serif typography for marketing pages.", Tags: []string{"design"}, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	var gotBody string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		gotBody = string(data)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	cfg := opencode.DefaultConfig()
	serverURL := target.URL
	cfg.Host = serverURL[len("http://"):strings.LastIndex(serverURL, ":")]
	cfg.Port, err = strconv.Atoi(serverURL[strings.LastIndex(serverURL, ":")+1:])
	if err != nil {
		t.Fatalf("parse port: %v", err)
	}

	s := &Server{store: store, projectRoot: projectRoot, runtimeOpenCode: &cfg, opencodeProxy: buildOpenCodeProxy(cfg), runtimeStatus: opencode.RuntimeStatus{Configured: true, Mode: opencode.RuntimeModeManaged, State: opencode.RuntimeStateReady, Ready: true}}
	req := httptest.NewRequest(http.MethodPost, "/api/opencode/session/abc/prompt_async", strings.NewReader(`{"parts":[{"type":"text","text":"debug sqlite vector search"}]}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	s.proxyOpenCode(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}
	if strings.Contains(gotBody, "Knowns Guidance") {
		t.Fatalf("expected no injection, got body %s", gotBody)
	}
	if rr.Header().Get(runtimememory.HeaderStatus) != runtimememory.StatusNone {
		t.Fatalf("status header = %q, want %q", rr.Header().Get(runtimememory.HeaderStatus), runtimememory.StatusNone)
	}
}

func TestProxyOpenCodeSupportsManualAndDebugModes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	if err := store.Memory.Create(&models.MemoryEntry{Title: "Prompt warning", Layer: models.MemoryLayerProject, Category: "warning", Content: "Prompt hooks should stay bounded in runtime execution.", Tags: []string{"prompt", "runtime"}, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	var gotBody string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		gotBody = string(data)
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	cfg := opencode.DefaultConfig()
	serverURL := target.URL
	var err error
	cfg.Host = serverURL[len("http://"):strings.LastIndex(serverURL, ":")]
	cfg.Port, err = strconv.Atoi(serverURL[strings.LastIndex(serverURL, ":")+1:])
	if err != nil {
		t.Fatalf("parse port: %v", err)
	}

	s := &Server{store: store, projectRoot: projectRoot, runtimeOpenCode: &cfg, opencodeProxy: buildOpenCodeProxy(cfg), runtimeStatus: opencode.RuntimeStatus{Configured: true, Mode: opencode.RuntimeModeManaged, State: opencode.RuntimeStateReady, Ready: true}}
	body := `{"parts":[{"type":"text","text":"runtime prompt execution"}]}`

	manualReq := httptest.NewRequest(http.MethodPost, "/api/opencode/session/abc/prompt_async", strings.NewReader(body))
	manualReq.Header.Set("Content-Type", "application/json")
	manualReq.Header.Set(runtimememory.HeaderMode, runtimememory.ModeManual)
	manualRR := httptest.NewRecorder()
	s.proxyOpenCode(manualRR, manualReq)
	if strings.Contains(gotBody, "Knowns Guidance") {
		t.Fatalf("manual mode should not inject without opt-in, got %s", gotBody)
	}
	if manualRR.Header().Get(runtimememory.HeaderStatus) != runtimememory.StatusCandidate {
		t.Fatalf("manual status header = %q, want %q", manualRR.Header().Get(runtimememory.HeaderStatus), runtimememory.StatusCandidate)
	}

	debugReq := httptest.NewRequest(http.MethodPost, "/api/opencode/session/abc/prompt_async", strings.NewReader(body))
	debugReq.Header.Set("Content-Type", "application/json")
	debugReq.Header.Set(runtimememory.HeaderMode, runtimememory.ModeDebug)
	debugRR := httptest.NewRecorder()
	s.proxyOpenCode(debugRR, debugReq)
	if strings.Contains(gotBody, "Knowns Guidance") {
		t.Fatalf("debug mode should not inject, got %s", gotBody)
	}
	if debugRR.Header().Get(runtimememory.HeaderStatus) != runtimememory.StatusCandidate {
		t.Fatalf("debug status header = %q, want %q", debugRR.Header().Get(runtimememory.HeaderStatus), runtimememory.StatusCandidate)
	}
	if debugRR.Header().Get(runtimememory.HeaderPack) == "" {
		t.Fatal("expected debug pack header")
	}

	manualInjectReq := httptest.NewRequest(http.MethodPost, "/api/opencode/session/abc/prompt_async", strings.NewReader(body))
	manualInjectReq.Header.Set("Content-Type", "application/json")
	manualInjectReq.Header.Set(runtimememory.HeaderMode, runtimememory.ModeManual)
	manualInjectReq.Header.Set(runtimememory.HeaderInject, "true")
	manualInjectRR := httptest.NewRecorder()
	s.proxyOpenCode(manualInjectRR, manualInjectReq)
	if !strings.Contains(gotBody, "Knowns Guidance") || !strings.Contains(gotBody, "memory({ action:") {
		t.Fatalf("manual mode with inject should add lightweight memory guidance, got %s", gotBody)
	}
	if manualInjectRR.Header().Get(runtimememory.HeaderStatus) != runtimememory.StatusInjected {
		t.Fatalf("manual inject status header = %q, want %q", manualInjectRR.Header().Get(runtimememory.HeaderStatus), runtimememory.StatusInjected)
	}
}

func TestProxyOpenCodeAutoCapturesStableMemoryPreference(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	project.Settings.RuntimeMemory = &models.RuntimeMemorySettings{Mode: runtimememory.ModeAuto}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save config: %v", err)
	}

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	cfg := opencode.DefaultConfig()
	serverURL := target.URL
	cfg.Host = serverURL[len("http://"):strings.LastIndex(serverURL, ":")]
	cfg.Port, err = strconv.Atoi(serverURL[strings.LastIndex(serverURL, ":")+1:])
	if err != nil {
		t.Fatalf("parse port: %v", err)
	}

	s := &Server{store: store, projectRoot: projectRoot, runtimeOpenCode: &cfg, opencodeProxy: buildOpenCodeProxy(cfg), runtimeStatus: opencode.RuntimeStatus{Configured: true, Mode: opencode.RuntimeModeManaged, State: opencode.RuntimeStateReady, Ready: true}}
	req := httptest.NewRequest(http.MethodPost, "/api/opencode/session/abc/prompt_async", strings.NewReader(`{"parts":[{"type":"text","text":"toi muon AI tu luu memory, khong doi toi nhac moi them"}]}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	s.proxyOpenCode(rr, req)

	entries, err := store.Memory.List(models.MemoryLayerGlobal)
	if err != nil {
		t.Fatalf("list global memories: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("global memories = %d, want 1", len(entries))
	}
	if !strings.Contains(entries[0].Content, "proactively save durable memory") {
		t.Fatalf("unexpected global memory content: %q", entries[0].Content)
	}
}
