package routes

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestWorkspaceBrowse_RejectsUnauthorizedPath(t *testing.T) {
	r, _, _, tmpDir := setupWorkspaceTest(t)

	// Create an un-registered folder outside the project
	outsideDir := filepath.Join(tmpDir, "unauthorized-secret-folder")

	req := httptest.NewRequest("GET", "/workspaces/browse?path="+outsideDir, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	// Since tmpDir is neither home, cwd, nor a registered project root (only test-project is registered),
	// access to outsideDir must be denied.
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected HTTP 403 for unauthorized browse, got %d: %s", w.Code, w.Body.String())
	}
}

func TestWorkspaceBrowse_AllowsRegisteredProject(t *testing.T) {
	r, _, _, tmpDir := setupWorkspaceTest(t)

	projDir := filepath.Join(tmpDir, "test-project")
	req := httptest.NewRequest("GET", "/workspaces/browse?path="+projDir, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected HTTP 200 for registered project browse, got %d: %s", w.Code, w.Body.String())
	}
}
