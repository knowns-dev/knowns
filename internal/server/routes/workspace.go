package routes

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/storage"
)

// WorkspaceRoutes handles /api/workspaces endpoints for multi-project management.
type WorkspaceRoutes struct {
	manager  *storage.Manager
	sse      Broadcaster
	onSwitch func(projectPath string) // called after a successful workspace switch
}

// Register wires workspace routes onto r.
func (wr *WorkspaceRoutes) Register(r chi.Router) {
	r.Get("/workspaces", wr.list)
	r.Get("/workspaces/browse", wr.browse)
	r.Post("/workspaces/switch", wr.switchWorkspace)
	r.Post("/workspaces/scan", wr.scan)
	r.Post("/workspaces/auto-scan", wr.autoScan)
	r.Delete("/workspaces/{id}", wr.remove)
}

// DirEntry describes a single directory entry for the browser tree.
type DirEntry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsProject   bool   `json:"isProject"`
	HasChildren bool   `json:"hasChildren"`
}

// browse lists immediate subdirectories of the given path for the folder tree.
//
// GET /api/workspaces/browse?path=/some/dir
func (wr *WorkspaceRoutes) browse(w http.ResponseWriter, r *http.Request) {
	dir := r.URL.Query().Get("path")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			respondError(w, http.StatusInternalServerError, "cannot determine home directory")
			return
		}
		dir = home
	}

	absDir, err := filepath.Abs(dir)
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid path")
		return
	}

	entries, err := os.ReadDir(absDir)
	if err != nil {
		respondError(w, http.StatusBadRequest, "cannot read directory: "+err.Error())
		return
	}

	var result []DirEntry
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		fullPath := filepath.Join(absDir, e.Name())

		// Skip /private (macOS symlink target)
		resolved, err := filepath.EvalSymlinks(fullPath)
		if err != nil {
			resolved = fullPath
		}
		if strings.HasPrefix(resolved, "/private") {
			continue
		}

		isProject := false
		knDir := filepath.Join(fullPath, ".knowns")
		if info, err := os.Stat(knDir); err == nil && info.IsDir() {
			if _, cfgErr := os.Stat(filepath.Join(knDir, "config.json")); cfgErr == nil {
				isProject = true
			}
		}

		hasChildren := false
		if sub, err := os.ReadDir(fullPath); err == nil {
			for _, s := range sub {
				if s.IsDir() && !strings.HasPrefix(s.Name(), ".") {
					hasChildren = true
					break
				}
			}
		}

		result = append(result, DirEntry{
			Name:        e.Name(),
			Path:        fullPath,
			IsProject:   isProject,
			HasChildren: hasChildren,
		})
	}

	if result == nil {
		result = []DirEntry{}
	}
	respondJSON(w, http.StatusOK, result)
}


//
// GET /api/workspaces
func (wr *WorkspaceRoutes) list(w http.ResponseWriter, r *http.Request) {
	reg := wr.manager.GetRegistry()
	if reg == nil {
		respondJSON(w, http.StatusOK, []interface{}{})
		return
	}
	projects := reg.Projects
	if projects == nil {
		respondJSON(w, http.StatusOK, []struct{}{})
		return
	}
	// Filter out entries that no longer have a valid .knowns/config.json
	valid := projects[:0]
	for _, p := range projects {
		cfgPath := filepath.Join(p.Path, ".knowns", "config.json")
		if _, err := os.Stat(cfgPath); err == nil {
			valid = append(valid, p)
		}
	}
	if valid == nil {
		respondJSON(w, http.StatusOK, []struct{}{})
		return
	}
	respondJSON(w, http.StatusOK, valid)
}

// switchWorkspace swaps the active store to a different project.
//
// POST /api/workspaces/switch
// Body: {"id": "project-id"} OR {"path": "/absolute/project/path"}
func (wr *WorkspaceRoutes) switchWorkspace(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID   string `json:"id"`
		Path string `json:"path"`
	}
	if err := decodeJSON(r, &body); err != nil || (body.ID == "" && body.Path == "") {
		respondError(w, http.StatusBadRequest, "id or path is required")
		return
	}

	reg := wr.manager.GetRegistry()
	if reg == nil {
		respondError(w, http.StatusInternalServerError, "registry not available")
		return
	}

	// Resolve project path — either from ID lookup or directly from path field.
	projectPath := body.Path
	if projectPath == "" {
		for _, p := range reg.Projects {
			if p.ID == body.ID {
				projectPath = p.Path
				break
			}
		}
		if projectPath == "" {
			respondError(w, http.StatusNotFound, "project not found")
			return
		}
	}

	// Switch the active store (also registers the project if new).
	if _, err := wr.manager.Switch(projectPath); err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if wr.onSwitch != nil {
		go wr.onSwitch(projectPath)
	}

	// Broadcast SSE refresh event so UI reloads all data.
	wr.sse.Broadcast(SSEEvent{
		Type: "refresh",
		Data: map[string]string{"reason": "workspace-switch"},
	})

	// Return the active project info.
	for _, p := range reg.Projects {
		if p.Path == projectPath {
			respondJSON(w, http.StatusOK, p)
			return
		}
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "switched", "path": projectPath})
}

// scan discovers new projects in the given directories.
//
// POST /api/workspaces/scan
// Body: {"dirs": ["/path/to/parent1", "/path/to/parent2"]}
func (wr *WorkspaceRoutes) scan(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Dirs []string `json:"dirs"`
	}
	if err := decodeJSON(r, &body); err != nil || len(body.Dirs) == 0 {
		respondError(w, http.StatusBadRequest, "dirs array is required")
		return
	}

	reg := wr.manager.GetRegistry()
	if reg == nil {
		respondError(w, http.StatusInternalServerError, "registry not available")
		return
	}

	added, err := reg.Scan(body.Dirs)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if added == nil {
		respondJSON(w, http.StatusOK, []struct{}{})
		return
	}
	respondJSON(w, http.StatusOK, added)
}

// autoScan discovers projects in common directories automatically.
// Scans home directory and well-known project directories at depth 1.
//
// POST /api/workspaces/auto-scan
func (wr *WorkspaceRoutes) autoScan(w http.ResponseWriter, r *http.Request) {
	reg := wr.manager.GetRegistry()
	if reg == nil {
		respondError(w, http.StatusInternalServerError, "registry not available")
		return
	}

	home, err := os.UserHomeDir()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "cannot determine home directory")
		return
	}

	// Common project directories to scan
	candidates := []string{
		home,
		filepath.Join(home, "Projects"),
		filepath.Join(home, "projects"),
		filepath.Join(home, "Developer"),
		filepath.Join(home, "developer"),
		filepath.Join(home, "Documents"),
		filepath.Join(home, "Code"),
		filepath.Join(home, "code"),
		filepath.Join(home, "repos"),
		filepath.Join(home, "Repos"),
		filepath.Join(home, "workspace"),
		filepath.Join(home, "Workspace"),
		filepath.Join(home, "src"),
		filepath.Join(home, "go", "src"),
		filepath.Join(home, "dev"),
		filepath.Join(home, "Dev"),
	}

	// Filter to only existing directories, excluding /private (macOS symlink target)
	var dirs []string
	for _, d := range candidates {
		info, err := os.Stat(d)
		if err != nil || !info.IsDir() {
			continue
		}
		resolved, err := filepath.EvalSymlinks(d)
		if err != nil {
			resolved = d
		}
		if strings.HasPrefix(resolved, "/private") {
			continue
		}
		dirs = append(dirs, d)
	}

	added, err := reg.Scan(dirs)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if added == nil {
		respondJSON(w, http.StatusOK, []struct{}{})
		return
	}
	respondJSON(w, http.StatusOK, added)
}

// remove deletes a project from the registry.
//
// DELETE /api/workspaces/{id}
func (wr *WorkspaceRoutes) remove(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		respondError(w, http.StatusBadRequest, "id is required")
		return
	}

	reg := wr.manager.GetRegistry()
	if reg == nil {
		respondError(w, http.StatusInternalServerError, "registry not available")
		return
	}

	if err := reg.Remove(id); err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
