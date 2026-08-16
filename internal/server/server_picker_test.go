package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/registry"
	"github.com/howznguyen/knowns/internal/storage"
)

// newPickerServer creates a Server in picker mode (nil store).
func newPickerServer(t *testing.T) *Server {
	t.Helper()
	s := &Server{
		store:      nil,
		sse:        NewSSEBroker(),
		shutdownCh: make(chan struct{}, 1),
	}
	reg := registry.NewRegistry()
	s.manager = storage.NewManager(nil, reg)
	s.router = s.buildRouter()
	return s
}

// newActiveServer creates a Server with a real project store.
func newActiveServer(t *testing.T) (*Server, string) {
	t.Helper()
	tmpDir := t.TempDir()
	projDir := filepath.Join(tmpDir, "my-project")
	os.MkdirAll(filepath.Join(projDir, ".knowns"), 0755)
	os.WriteFile(filepath.Join(projDir, ".knowns", "config.json"), []byte(`{"name":"my-project"}`), 0644)

	store := storage.NewStore(filepath.Join(projDir, ".knowns"))
	reg := registry.NewRegistry()
	s := &Server{
		store:       store,
		projectRoot: projDir,
		sse:         NewSSEBroker(),
		shutdownCh:  make(chan struct{}, 1),
	}
	s.manager = storage.NewManager(store, reg)
	s.router = s.buildRouter()
	return s, projDir
}

func TestStatusEndpoint_NoProject(t *testing.T) {
	t.Parallel()
	s := newPickerServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req.Host = "127.0.0.1:6420"
	rr := httptest.NewRecorder()
	s.router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/status status = %d, want 200", rr.Code)
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["active"] != false {
		t.Fatalf("active = %v, want false", resp["active"])
	}
}

func TestStatusEndpoint_ActiveProject(t *testing.T) {
	t.Parallel()
	s, projDir := newActiveServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req.Host = "127.0.0.1:6420"
	rr := httptest.NewRecorder()
	s.router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/status status = %d, want 200", rr.Code)
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["active"] != true {
		t.Fatalf("active = %v, want true", resp["active"])
	}
	if resp["projectName"] != "my-project" {
		t.Fatalf("projectName = %v, want my-project", resp["projectName"])
	}
	if resp["projectPath"] != projDir {
		t.Fatalf("projectPath = %v, want %s", resp["projectPath"], projDir)
	}
}

func TestProjectScopedRoutes_Return503_WhenNoStore(t *testing.T) {
	t.Parallel()
	s := newPickerServer(t)

	routes := []struct {
		method string
		path   string
	}{
		{"GET", "/api/tasks"},
		{"GET", "/api/docs"},
		{"GET", "/api/config"},
		{"GET", "/api/search?q=test"},
		{"GET", "/api/graph"},
		{"GET", "/api/memories"},
		{"GET", "/api/validate/sdd"},
		{"GET", "/api/time/status"},
	}

	for _, rt := range routes {
		req := httptest.NewRequest(rt.method, rt.path, nil)
		req.Host = "127.0.0.1:6420"
		rr := httptest.NewRecorder()
		s.router.ServeHTTP(rr, req)

		if rr.Code != http.StatusServiceUnavailable {
			t.Errorf("%s %s: status = %d, want 503", rt.method, rt.path, rr.Code)
		}
		if !strings.Contains(rr.Body.String(), "no active project") {
			t.Errorf("%s %s: body missing 'no active project': %s", rt.method, rt.path, rr.Body.String())
		}
	}
}

func TestWorkspaceRoutes_AvailableInPickerMode(t *testing.T) {
	t.Parallel()
	s := newPickerServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.Host = "127.0.0.1:6420"
	rr := httptest.NewRecorder()
	s.router.ServeHTTP(rr, req)

	// Should return 200 (empty list), not 503
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/workspaces in picker mode: status = %d, want 200", rr.Code)
	}
}

func TestWorkspaceSwitch_UpdatesActiveStore(t *testing.T) {
	t.Parallel()
	tmpDir := t.TempDir()

	// Start in picker mode (nil store)
	proj := filepath.Join(tmpDir, "proj-a")
	os.MkdirAll(filepath.Join(proj, ".knowns"), 0755)
	os.WriteFile(filepath.Join(proj, ".knowns", "config.json"), []byte(`{"name":"proj-a"}`), 0644)

	reg := registry.NewRegistry()
	p, _ := reg.Add(proj)

	s := &Server{
		store:      nil,
		sse:        NewSSEBroker(),
		shutdownCh: make(chan struct{}, 1),
	}
	s.manager = storage.NewManager(nil, reg)
	s.router = s.buildRouter()

	// Before switch: no active store
	if s.manager.GetStore() != nil {
		t.Fatal("expected nil store before switch")
	}

	// Switch to proj-a
	body := strings.NewReader(`{"id":"` + p.ID + `"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/workspaces/switch", body)
	req.Host = "127.0.0.1:6420"
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	s.router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("POST /api/workspaces/switch status = %d, want 200: %s", rr.Code, rr.Body.String())
	}

	// After switch: store should be active
	if s.manager.GetStore() == nil {
		t.Fatal("expected active store after switch")
	}
	if s.manager.GetStore().Root != filepath.Join(proj, ".knowns") {
		t.Fatalf("store root = %q, want %q", s.manager.GetStore().Root, filepath.Join(proj, ".knowns"))
	}
}
