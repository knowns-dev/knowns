package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/registry"
	"github.com/howznguyen/knowns/internal/storage"
)

// canonicalTempDir returns t.TempDir() spelled the way the OS itself reports
// it. The Windows runners hand tests a TMP path holding the 8.3 short name
// RUNNER~1, which is an alias rather than the directory's real name, so a test
// comparing against the raw value asserts against exactly the spelling
// CanonicalPath exists to collapse. EvalSymlinks reads the real name from the
// OS, independently of the code under test.
func canonicalTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return dir
	}
	return resolved
}

// fakeBroadcaster records broadcast calls for assertions.
type fakeBroadcaster struct {
	events []SSEEvent
}

func (fb *fakeBroadcaster) Broadcast(e SSEEvent) {
	fb.events = append(fb.events, e)
}

// setupWorkspaceTest creates a test environment with registry, manager, and router.
func setupWorkspaceTest(t *testing.T) (*chi.Mux, *fakeBroadcaster, *storage.Manager, string) {
	t.Helper()
	tmpDir := canonicalTempDir(t)

	// Create a fake project with .knowns/config.json
	projDir := filepath.Join(tmpDir, "test-project")
	os.MkdirAll(filepath.Join(projDir, ".knowns"), 0755)
	os.WriteFile(filepath.Join(projDir, ".knowns", "config.json"), []byte(`{"name":"test-project"}`), 0644)

	regFile := filepath.Join(tmpDir, "registry.json")
	reg := registry.NewRegistryWithPath(regFile)
	reg.Load()
	reg.Add(projDir)

	store := storage.NewStore(filepath.Join(projDir, ".knowns"))
	mgr := storage.NewManager(store, reg)
	sse := &fakeBroadcaster{}

	r := chi.NewRouter()
	wr := &WorkspaceRoutes{manager: mgr, sse: sse}
	wr.Register(r)

	return r, sse, mgr, tmpDir
}

func TestWorkspaceList(t *testing.T) {
	r, _, _, _ := setupWorkspaceTest(t)

	req := httptest.NewRequest("GET", "/workspaces", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("GET /workspaces status = %d, want 200", w.Code)
	}

	var projects []registry.Project
	if err := json.Unmarshal(w.Body.Bytes(), &projects); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(projects) != 1 {
		t.Fatalf("expected 1 project, got %d", len(projects))
	}
	if projects[0].Name != "test-project" {
		t.Fatalf("project name = %q, want %q", projects[0].Name, "test-project")
	}
}

func TestWorkspaceSwitch(t *testing.T) {
	r, sse, mgr, tmpDir := setupWorkspaceTest(t)

	// Create a second project
	proj2 := filepath.Join(tmpDir, "proj2")
	os.MkdirAll(filepath.Join(proj2, ".knowns"), 0755)
	os.WriteFile(filepath.Join(proj2, ".knowns", "config.json"), []byte(`{"name":"proj2"}`), 0644)
	reg := mgr.GetRegistry()
	p2, _ := reg.Add(proj2)

	body, _ := json.Marshal(map[string]string{"id": p2.ID})
	req := httptest.NewRequest("POST", "/workspaces/switch", bytes.NewReader(body))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("POST /workspaces/switch status = %d, want 200", w.Code)
	}

	// Verify store was switched
	if mgr.GetStore().Root != filepath.Join(proj2, ".knowns") {
		t.Fatalf("store root = %q, want %q", mgr.GetStore().Root, filepath.Join(proj2, ".knowns"))
	}

	// Verify SSE refresh event was broadcast
	if len(sse.events) != 1 {
		t.Fatalf("expected 1 SSE event, got %d", len(sse.events))
	}
	if sse.events[0].Type != "refresh" {
		t.Fatalf("SSE event type = %q, want %q", sse.events[0].Type, "refresh")
	}
}

func TestWorkspaceScan(t *testing.T) {
	r, _, _, tmpDir := setupWorkspaceTest(t)

	// Create a scan directory with 2 projects
	scanDir := filepath.Join(tmpDir, "scan-parent")
	os.MkdirAll(filepath.Join(scanDir, "repo-a", ".knowns"), 0755)
	os.WriteFile(filepath.Join(scanDir, "repo-a", ".knowns", "config.json"), []byte(`{"name":"repo-a"}`), 0644)
	os.MkdirAll(filepath.Join(scanDir, "repo-b", ".knowns"), 0755)
	os.WriteFile(filepath.Join(scanDir, "repo-b", ".knowns", "config.json"), []byte(`{"name":"repo-b"}`), 0644)

	body, _ := json.Marshal(map[string][]string{"dirs": {scanDir}})
	req := httptest.NewRequest("POST", "/workspaces/scan", bytes.NewReader(body))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("POST /workspaces/scan status = %d, want 200", w.Code)
	}

	var added []registry.Project
	if err := json.Unmarshal(w.Body.Bytes(), &added); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(added) != 2 {
		t.Fatalf("expected 2 discovered projects, got %d", len(added))
	}
}

func TestWorkspaceDelete(t *testing.T) {
	r, _, mgr, _ := setupWorkspaceTest(t)

	reg := mgr.GetRegistry()
	if len(reg.Projects) == 0 {
		t.Fatal("expected at least 1 project in registry")
	}
	id := reg.Projects[0].ID

	req := httptest.NewRequest("DELETE", "/workspaces/"+id, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("DELETE /workspaces/%s status = %d, want 204", id, w.Code)
	}

	// Verify removed
	if len(reg.Projects) != 0 {
		t.Fatalf("expected 0 projects after delete, got %d", len(reg.Projects))
	}
}

// caseInsensitiveFS reports whether dir lives on a filesystem that treats two
// spellings of one name as the same entry.
func caseInsensitiveFS(t *testing.T, dir string) bool {
	t.Helper()
	probe := filepath.Join(dir, "CaseProbe")
	if err := os.Mkdir(probe, 0755); err != nil {
		t.Fatalf("create probe dir: %v", err)
	}
	defer os.RemoveAll(probe)
	_, err := os.Stat(filepath.Join(dir, "caseprobe"))
	return err == nil
}

func TestScanCandidatesCollapsesCaseVariantDirectories(t *testing.T) {
	home := canonicalTempDir(t)
	if !caseInsensitiveFS(t, home) {
		t.Skip("filesystem is case-sensitive; the two spellings are different folders")
	}
	// Only one of the two spellings the candidate list carries exists on disk.
	projects := filepath.Join(home, "Projects")
	if err := os.Mkdir(projects, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	dirs := scanCandidates(home)

	seen := make(map[string]int)
	for _, d := range dirs {
		seen[d]++
		if seen[d] > 1 {
			t.Fatalf("candidate %q returned more than once", d)
		}
	}
	matches := 0
	for _, d := range dirs {
		if strings.EqualFold(filepath.Base(d), "projects") {
			matches++
			if d != projects {
				t.Fatalf("candidate = %q, want the on-disk spelling %q", d, projects)
			}
		}
	}
	if matches != 1 {
		t.Fatalf("projects directory appeared %d times, want 1", matches)
	}
}

func TestScanCandidatesKeepsDistinctCaseSensitiveDirectories(t *testing.T) {
	home := canonicalTempDir(t)
	if caseInsensitiveFS(t, home) {
		t.Skip("filesystem is case-insensitive; both spellings name one folder")
	}
	for _, name := range []string{"Projects", "projects"} {
		if err := os.Mkdir(filepath.Join(home, name), 0755); err != nil {
			t.Fatalf("mkdir %q: %v", name, err)
		}
	}

	dirs := scanCandidates(home)

	matches := 0
	for _, d := range dirs {
		if strings.EqualFold(filepath.Base(d), "projects") {
			matches++
		}
	}
	if matches != 2 {
		t.Fatalf("distinct projects directories appeared %d times, want 2", matches)
	}
}

func TestWorkspaceSwitchByCaseVariantPath(t *testing.T) {
	r, _, mgr, tmpDir := setupWorkspaceTest(t)
	if !caseInsensitiveFS(t, tmpDir) {
		t.Skip("filesystem is case-sensitive; the two spellings are different folders")
	}
	projDir := filepath.Join(tmpDir, "test-project")
	registered := mgr.GetRegistry().FindByPath(projDir)
	if registered == nil {
		t.Fatal("test project was not registered")
	}

	body, _ := json.Marshal(map[string]string{"path": strings.ToLower(projDir)})
	req := httptest.NewRequest("POST", "/workspaces/switch", bytes.NewReader(body))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("POST /workspaces/switch status = %d, want 200", w.Code)
	}

	var got registry.Project
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.ID != registered.ID {
		t.Fatalf("ID = %q, want the already registered %q", got.ID, registered.ID)
	}
	if len(mgr.GetRegistry().Projects) != 1 {
		t.Fatalf("expected 1 project after switching by another spelling, got %d",
			len(mgr.GetRegistry().Projects))
	}
}
