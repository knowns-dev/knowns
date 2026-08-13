package routes

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/storage"
)

// ImportRoutes handles /api/imports endpoints.
type ImportRoutes struct {
	store *storage.Store
	mgr   *storage.Manager
	sse   Broadcaster
}

func (ir *ImportRoutes) getStore() *storage.Store {
	if ir.mgr != nil {
		return ir.mgr.GetStore()
	}
	return ir.store
}

// Register wires the import routes onto r.
func (ir *ImportRoutes) Register(r chi.Router) {
	r.Get("/imports", ir.list)
	r.Post("/imports", ir.add)
	r.Get("/imports/{name}", ir.get)
	r.Delete("/imports/{name}", ir.remove)
	r.Post("/imports/sync", ir.sync)
	r.Post("/imports/{name}/sync", ir.syncOne)
	r.Post("/imports/sync-all", ir.syncAll)
}

// ImportEntry describes a single registered import.
type ImportEntry struct {
	Name       string   `json:"name"`
	Source     string   `json:"source,omitempty"`
	Type       string   `json:"type,omitempty"`
	Ref        string   `json:"ref,omitempty"`
	Link       bool     `json:"link"`
	AutoSync   bool     `json:"autoSync"`
	LastSync   string   `json:"lastSync,omitempty"`
	ImportedAt string   `json:"importedAt,omitempty"`
	FileCount  int      `json:"fileCount"`
	Files      []string `json:"files,omitempty"`
}

// importsDir returns the path to .knowns/imports/.
func (ir *ImportRoutes) importsDir() string {
	return filepath.Join(ir.getStore().Root, "imports")
}

func validateImportName(name string) error {
	if name == "" || name == "." || name == ".." ||
		filepath.IsAbs(name) || filepath.VolumeName(name) != "" ||
		strings.ContainsAny(name, `/\`) || strings.ContainsRune(name, '\x00') ||
		filepath.Base(name) != name {
		return fmt.Errorf("invalid import name %q: must be a single path segment", name)
	}
	return nil
}

// collectFiles recursively collects relative file paths under dir.
func collectFiles(dir string) []string {
	var files []string
	_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(dir, path)
		files = append(files, filepath.ToSlash(rel))
		return nil
	})
	if files == nil {
		files = []string{}
	}
	return files
}

// buildEntry creates an ImportEntry for the given import directory name.
func (ir *ImportRoutes) buildEntry(name string, includeFiles bool) ImportEntry {
	entry := ImportEntry{Name: name, Type: "local"}
	importDir := filepath.Join(ir.importsDir(), name)

	// Read persisted metadata if available.
	if meta, ok := readImportMeta(importDir); ok {
		entry.Source = meta.Source
		if meta.Type != "" {
			entry.Type = meta.Type
		}
		entry.Ref = meta.Ref
		entry.LastSync = meta.LastSync
		entry.ImportedAt = meta.ImportedAt
	}

	files := collectFiles(importDir)
	// Exclude _import.json from the file list.
	var filtered []string
	for _, f := range files {
		if f != importMetaFile {
			filtered = append(filtered, f)
		}
	}
	if filtered == nil {
		filtered = []string{}
	}
	entry.FileCount = len(filtered)
	if includeFiles {
		entry.Files = filtered
	}
	return entry
}

// list returns all registered imports by scanning .knowns/imports/.
//
// GET /api/imports
func (ir *ImportRoutes) list(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(ir.importsDir())
	if os.IsNotExist(err) {
		respondJSON(w, http.StatusOK, map[string]interface{}{
			"imports": []ImportEntry{},
			"count":   0,
		})
		return
	}
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	var imports []ImportEntry
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			imports = append(imports, ir.buildEntry(e.Name(), false))
		}
	}
	if imports == nil {
		imports = []ImportEntry{}
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"imports": imports,
		"count":   len(imports),
	})
}

// get returns details of a single import by name.
//
// GET /api/imports/{name}
func (ir *ImportRoutes) get(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if err := validateImportName(name); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	importDir := filepath.Join(ir.importsDir(), name)

	if _, err := os.Stat(importDir); os.IsNotExist(err) {
		respondError(w, http.StatusNotFound, "import not found: "+name)
		return
	}

	entry := ir.buildEntry(name, true)
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"import": entry,
	})
}

// addImportRequest is the body for POST /api/imports.
type addImportRequest struct {
	Source string `json:"source"`
	Name   string `json:"name"`
	Type   string `json:"type"`
	Ref    string `json:"ref"`
	Link   bool   `json:"link"`
	DryRun bool   `json:"dryRun"`
}

// nameFromSource extracts a short name from a git URL or path.
// e.g. "https://github.com/user/my-repo" → "my-repo"
func nameFromSource(source string) string {
	// Strip trailing slashes and .git suffix.
	s := strings.TrimRight(source, "/")
	s = strings.TrimSuffix(s, ".git")
	// Take the last path segment.
	if idx := strings.LastIndex(s, "/"); idx >= 0 {
		s = s[idx+1:]
	}
	if s == "" {
		return "import"
	}
	return s
}

// importChange describes one file-level change during an import.
type importChange struct {
	Path   string `json:"path"`
	Action string `json:"action"` // "add", "update", "skip"
}

// importMeta is persisted as _import.json inside each import directory.
type importMeta struct {
	Source         string `json:"source"`
	Type           string `json:"type"`
	Ref            string `json:"ref,omitempty"`
	LastSync       string `json:"lastSync,omitempty"`
	ImportedAt     string `json:"importedAt,omitempty"`
	LastCommitHash string `json:"lastCommitHash,omitempty"`
}

const importMetaFile = "_import.json"

// isGitURL returns true if source looks like a git repository URL.
func isGitURL(source string) bool {
	s := strings.ToLower(source)
	if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") || strings.HasPrefix(s, "git@") {
		return true
	}
	if strings.HasSuffix(s, ".git") {
		return true
	}
	return false
}

// writeImportMeta persists import metadata into the import directory.
func writeImportMeta(importDir string, meta importMeta) error {
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(importDir, importMetaFile), data, 0644)
}

// readImportMeta reads import metadata from the import directory.
func readImportMeta(importDir string) (importMeta, bool) {
	data, err := os.ReadFile(filepath.Join(importDir, importMetaFile))
	if err != nil {
		return importMeta{}, false
	}
	var meta importMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return importMeta{}, false
	}
	return meta, true
}

// injectGitToken injects a git token into an HTTPS clone URL.
// Priority: KNOWNS_GIT_TOKEN env > git.token config > KNOWNS_GITHUB_TOKEN env > github.token config.
func (ir *ImportRoutes) injectGitToken(source string) string {
	token := os.Getenv("KNOWNS_GIT_TOKEN")
	if token == "" {
		if v, err := ir.getStore().Config.Get("git.token"); err == nil {
			if s, ok := v.(string); ok && s != "" {
				token = s
			}
		}
	}
	// Fallback to GitHub-specific for backward compatibility.
	if token == "" {
		token = os.Getenv("KNOWNS_GITHUB_TOKEN")
	}
	if token == "" {
		if v, err := ir.getStore().Config.Get("github.token"); err == nil {
			if s, ok := v.(string); ok && s != "" {
				token = s
			}
		}
	}
	if token != "" {
		return injectTokenInURL(source, token)
	}
	return source
}

// injectTokenInURL rewrites https://host/... to https://user:token@host/...
// Uses the appropriate token username based on the git host.
func injectTokenInURL(source, token string) string {
	for _, prefix := range []string{"https://", "http://"} {
		if strings.HasPrefix(source, prefix) {
			rest := strings.TrimPrefix(source, prefix)
			if strings.Contains(strings.SplitN(rest, "/", 2)[0], "@") {
				return source
			}
			user := tokenUsernameForHost(rest)
			return prefix + user + ":" + token + "@" + rest
		}
	}
	return source
}

// tokenUsernameForHost returns the appropriate token username for a git host.
func tokenUsernameForHost(hostAndPath string) string {
	host := strings.ToLower(strings.SplitN(hostAndPath, "/", 2)[0])
	host = strings.SplitN(host, ":", 2)[0] // strip port
	switch {
	case strings.Contains(host, "gitlab"):
		return "oauth2"
	case strings.Contains(host, "bitbucket"):
		return "x-token-auth"
	default:
		// GitHub and most other git servers accept this.
		return "x-access-token"
	}
}

// isAuthError checks if a git stderr message indicates an authentication failure.
func isAuthError(stderr string) bool {
	s := strings.ToLower(stderr)
	return strings.Contains(s, "authentication failed") ||
		strings.Contains(s, "could not read username") ||
		strings.Contains(s, "terminal prompts disabled") ||
		strings.Contains(s, "403") ||
		strings.Contains(s, "401")
}

// gitLsRemoteHead returns the commit hash for the remote HEAD (or a specific ref).
// Returns empty string on any error.
func (ir *ImportRoutes) gitLsRemoteHead(source, ref string) string {
	url := ir.injectGitToken(source)
	target := "HEAD"
	if ref != "" {
		target = ref
	}
	cmd := exec.Command("git", "ls-remote", url, target)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	line := strings.TrimSpace(string(out))
	if idx := strings.IndexByte(line, '\t'); idx > 0 {
		return line[:idx]
	}
	return ""
}

// gitCloneImport clones a git repo, copies .knowns/docs/ and .knowns/templates/
// into .knowns/imports/{name}/, and returns the list of changes.
// If cachedHash matches the remote HEAD, returns nil changes and upToDate=true.
func (ir *ImportRoutes) gitCloneImport(source, name, ref, cachedHash string, dryRun bool) ([]importChange, []string, string, bool, error) {
	if err := validateImportName(name); err != nil {
		return nil, nil, "", false, err
	}
	// Check remote commit hash before cloning.
	remoteHash := ir.gitLsRemoteHead(source, ref)
	if remoteHash != "" && remoteHash == cachedHash && !dryRun {
		return []importChange{}, nil, remoteHash, true, nil
	}

	tmpDir, err := os.MkdirTemp("", "knowns-import-*")
	if err != nil {
		return nil, nil, remoteHash, false, err
	}
	defer os.RemoveAll(tmpDir)

	// Shallow clone.
	cloneURL := ir.injectGitToken(source)
	args := []string{"clone", "--depth", "1"}
	if ref != "" {
		args = append(args, "--branch", ref)
	}
	args = append(args, cloneURL, tmpDir)

	cmd := exec.Command("git", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if err := cmd.Run(); err != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if isAuthError(errMsg) {
			return nil, nil, "", false, fmt.Errorf("authentication failed for %s. "+
				"Set KNOWNS_GIT_TOKEN env var, run 'knowns config set git.token <token>', "+
				"or use an SSH URL (e.g. git@host:owner/repo.git) instead", source)
		}
		return nil, nil, "", false, fmt.Errorf("git clone failed: %s", errMsg)
	}

	// Check for .knowns/ directory.
	knownsDir := filepath.Join(tmpDir, ".knowns")
	if _, err := os.Stat(knownsDir); os.IsNotExist(err) {
		return nil, []string{"no .knowns directory found in " + source}, remoteHash, false, nil
	}

	// Collect files from docs/ and templates/ subdirectories.
	var changes []importChange
	var warnings []string
	destBase := filepath.Join(ir.importsDir(), name)

	for _, sub := range []string{"docs", "templates"} {
		srcDir := filepath.Join(knownsDir, sub)
		if _, err := os.Stat(srcDir); os.IsNotExist(err) {
			continue
		}

		err := filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			relPath, _ := filepath.Rel(knownsDir, path)
			relPath = filepath.ToSlash(relPath)
			// Nest docs under {name}/ so paths become "docs/{name}/readme.md".
			// This gives doc paths the import prefix automatically.
			if sub == "docs" {
				subRel := strings.TrimPrefix(relPath, "docs/")
				relPath = "docs/" + name + "/" + subRel
			}
			destPath := filepath.Join(destBase, relPath)

			srcData, err := os.ReadFile(path)
			if err != nil {
				warnings = append(warnings, "could not read "+relPath+": "+err.Error())
				return nil
			}

			action := "add"
			if destData, err := os.ReadFile(destPath); err == nil {
				if bytes.Equal(srcData, destData) {
					action = "skip"
				} else {
					action = "update"
				}
			}

			changes = append(changes, importChange{Path: relPath, Action: action})

			if !dryRun && action != "skip" {
				if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
					return err
				}
				if err := copyFile(path, destPath); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return nil, nil, "", false, err
		}
	}

	if changes == nil {
		changes = []importChange{}
	}

	// Write metadata if not dry-run.
	if !dryRun {
		if err := os.MkdirAll(destBase, 0755); err != nil {
			return nil, nil, "", false, err
		}
		now := time.Now().UTC().Format(time.RFC3339)
		// Read existing meta to preserve importedAt if this is a re-sync.
		existingMeta, _ := readImportMeta(destBase)
		importedAt := existingMeta.ImportedAt
		if importedAt == "" {
			importedAt = now
		}
		if err := writeImportMeta(destBase, importMeta{
			Source:         source,
			Type:           "git",
			Ref:            ref,
			LastSync:       now,
			ImportedAt:     importedAt,
			LastCommitHash: remoteHash,
		}); err != nil {
			warnings = append(warnings, "could not write import metadata: "+err.Error())
		}
	}

	return changes, warnings, remoteHash, false, nil
}

// copyFile copies src to dst.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}

// importResultJSON builds the standard ImportResult response map.
func importResultJSON(name, source, importType string, dryRun bool, changes []importChange, warnings []string) map[string]interface{} {
	added, updated, skipped := 0, 0, 0
	for _, c := range changes {
		switch c.Action {
		case "add":
			added++
		case "update":
			updated++
		case "skip":
			skipped++
		}
	}
	result := map[string]interface{}{
		"success": true,
		"dryRun":  dryRun,
		"import": map[string]interface{}{
			"name":   name,
			"source": source,
			"type":   importType,
		},
		"changes": changes,
		"summary": map[string]interface{}{
			"added":   added,
			"updated": updated,
			"skipped": skipped,
		},
	}
	if len(warnings) > 0 {
		result["warnings"] = warnings
	}
	return result
}

// add registers a new import source.
//
// POST /api/imports
func (ir *ImportRoutes) add(w http.ResponseWriter, r *http.Request) {
	var req addImportRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if req.Source == "" {
		respondError(w, http.StatusBadRequest, "source is required")
		return
	}

	name := req.Name
	if name == "" {
		name = nameFromSource(req.Source)
	}
	if err := validateImportName(name); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Git URL: clone and copy .knowns/docs + templates.
	if isGitURL(req.Source) {
		changes, warnings, _, _, err := ir.gitCloneImport(req.Source, name, req.Ref, "", req.DryRun)
		if err != nil {
			respondError(w, http.StatusInternalServerError, err.Error())
			return
		}
		respondJSON(w, http.StatusCreated, importResultJSON(name, req.Source, "git", req.DryRun, changes, warnings))
		return
	}

	// Non-git source: create empty import directory.
	destDir := filepath.Join(ir.importsDir(), name)
	if err := os.MkdirAll(destDir, 0755); err != nil {
		respondError(w, http.StatusInternalServerError, "create import dir: "+err.Error())
		return
	}

	importType := "local"
	if req.Type != "" {
		importType = req.Type
	}

	// Persist metadata.
	now := time.Now().UTC().Format(time.RFC3339)
	_ = writeImportMeta(destDir, importMeta{
		Source:     req.Source,
		Type:       importType,
		LastSync:   now,
		ImportedAt: now,
	})

	respondJSON(w, http.StatusCreated, importResultJSON(name, req.Source, importType, req.DryRun, []importChange{}, nil))
}

// remove deletes an import by name.
//
// DELETE /api/imports/{name}
func (ir *ImportRoutes) remove(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if err := validateImportName(name); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	destDir := filepath.Join(ir.importsDir(), name)
	if err := os.RemoveAll(destDir); err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success":      true,
		"filesDeleted": true,
	})
}

// sync is a stub for syncing remote import packages.
//
// POST /api/imports/sync
func (ir *ImportRoutes) sync(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, map[string]string{"status": "synced"})
}

// syncOne synchronises a single import by name.
//
// POST /api/imports/{name}/sync
func (ir *ImportRoutes) syncOne(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if err := validateImportName(name); err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	importDir := filepath.Join(ir.importsDir(), name)

	if _, err := os.Stat(importDir); os.IsNotExist(err) {
		respondError(w, http.StatusNotFound, "import not found: "+name)
		return
	}

	meta, ok := readImportMeta(importDir)
	if !ok || !isGitURL(meta.Source) {
		// No metadata or not a git import — nothing to sync.
		ir.sse.Broadcast(SSEEvent{Type: "imports:synced", Data: map[string]string{"name": name}})
		respondJSON(w, http.StatusOK, importResultJSON(name, meta.Source, meta.Type, false, []importChange{}, nil))
		return
	}

	changes, warnings, _, upToDate, err := ir.gitCloneImport(meta.Source, name, meta.Ref, meta.LastCommitHash, false)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "sync failed: "+err.Error())
		return
	}

	if upToDate {
		ir.sse.Broadcast(SSEEvent{Type: "imports:synced", Data: map[string]string{"name": name}})
		respondJSON(w, http.StatusOK, map[string]interface{}{
			"success":  true,
			"upToDate": true,
			"import":   map[string]string{"name": name, "source": meta.Source, "type": "git"},
		})
		return
	}

	ir.sse.Broadcast(SSEEvent{Type: "imports:synced", Data: map[string]string{"name": name}})
	respondJSON(w, http.StatusOK, importResultJSON(name, meta.Source, "git", false, changes, warnings))
}

// syncAll synchronises all registered imports.
//
// POST /api/imports/sync-all
func (ir *ImportRoutes) syncAll(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(ir.importsDir())
	if os.IsNotExist(err) {
		respondJSON(w, http.StatusOK, map[string]interface{}{
			"success": true,
			"dryRun":  false,
			"results": []interface{}{},
			"summary": map[string]interface{}{"total": 0, "successful": 0, "failed": 0},
		})
		return
	}
	if err != nil {
		respondError(w, http.StatusInternalServerError, "read imports: "+err.Error())
		return
	}

	type syncResult struct {
		Name    string                 `json:"name"`
		Source  string                 `json:"source"`
		Type    string                 `json:"type"`
		Success bool                   `json:"success"`
		Error   string                 `json:"error,omitempty"`
		Summary map[string]interface{} `json:"summary,omitempty"`
	}

	var results []syncResult
	successful, failed := 0, 0

	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		name := e.Name()
		importDir := filepath.Join(ir.importsDir(), name)
		meta, ok := readImportMeta(importDir)
		if !ok || !isGitURL(meta.Source) {
			// Not a git import — nothing to sync, count as success.
			results = append(results, syncResult{
				Name:    name,
				Source:  meta.Source,
				Type:    meta.Type,
				Success: true,
			})
			successful++
			continue
		}

		changes, warnings, _, upToDate, syncErr := ir.gitCloneImport(meta.Source, name, meta.Ref, meta.LastCommitHash, false)
		if syncErr != nil {
			results = append(results, syncResult{
				Name:    name,
				Source:  meta.Source,
				Type:    "git",
				Success: false,
				Error:   syncErr.Error(),
			})
			failed++
			continue
		}

		if upToDate {
			results = append(results, syncResult{
				Name:    name,
				Source:  meta.Source,
				Type:    "git",
				Success: true,
				Summary: map[string]interface{}{
					"upToDate": true,
				},
			})
			successful++
			continue
		}

		added, updated, skipped := 0, 0, 0
		for _, c := range changes {
			switch c.Action {
			case "add":
				added++
			case "update":
				updated++
			case "skip":
				skipped++
			}
		}

		sr := syncResult{
			Name:    name,
			Source:  meta.Source,
			Type:    "git",
			Success: true,
			Summary: map[string]interface{}{
				"added":   added,
				"updated": updated,
				"skipped": skipped,
			},
		}
		if len(warnings) > 0 {
			sr.Summary["warnings"] = warnings
		}
		results = append(results, sr)
		successful++

		ir.sse.Broadcast(SSEEvent{Type: "imports:synced", Data: map[string]string{"name": name}})
	}

	if results == nil {
		results = []syncResult{}
	}

	total := successful + failed
	ir.sse.Broadcast(SSEEvent{Type: "imports:sync-all", Data: map[string]interface{}{"total": total}})
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"dryRun":  false,
		"results": results,
		"summary": map[string]interface{}{
			"total":      total,
			"successful": successful,
			"failed":     failed,
		},
	})
}
