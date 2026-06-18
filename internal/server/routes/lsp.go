// Package routes provides LSP language hot-add REST endpoints.
package routes

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// LSPRoutes handles /api/lsp/languages endpoints.
type LSPRoutes struct {
	lspMgr *lsp.Manager
	store  *storage.Store
	mgr    *storage.Manager
	sse    Broadcaster
}

func (lr *LSPRoutes) getStore() *storage.Store {
	if lr.mgr != nil {
		return lr.mgr.GetStore()
	}
	return lr.store
}

// Register wires the LSP language routes onto r at /languages prefix.
func (lr *LSPRoutes) Register(r chi.Router) {
	r.Get("/languages", lr.list)
	r.Post("/languages", lr.add)
	r.Put("/languages/{lang}", lr.toggle)
	r.Delete("/languages/{lang}", lr.remove)
	r.Post("/languages/{lang}/restart", lr.restart)
	r.Patch("/languages/{lang}/config", lr.patchConfig)
	r.Post("/languages/{lang}/install", lr.install)
	r.Post("/languages/{lang}/cleanup", lr.cleanup)
	r.Get("/languages/{lang}/logs", lr.logs)
	r.Post("/languages/{lang}/trace", lr.trace)
}

// SetupLSPRoutes creates LSPRoutes and registers them on r.
func SetupLSPRoutes(r chi.Router, lspMgr *lsp.Manager, store *storage.Store, mgr *storage.Manager, broadcaster Broadcaster) {
	lr := &LSPRoutes{lspMgr: lspMgr, store: store, mgr: mgr, sse: broadcaster}
	lr.Register(r)
}

// list returns all available LSP adapters with install/running status.
//
// GET /api/lsp/languages
func (lr *LSPRoutes) list(w http.ResponseWriter, r *http.Request) {
	if lr.lspMgr == nil {
		respondJSON(w, http.StatusOK, map[string][]lsp.LanguageInfo{"languages": nil})
		return
	}
	respondJSON(w, http.StatusOK, map[string][]lsp.LanguageInfo{
		"languages": lr.lspMgr.AvailableLanguages(),
	})
}

// addLanguageRequest is the body for POST /api/lsp/languages.
type addLanguageRequest struct {
	Language string `json:"language"`
}

// add registers a new language in the project config and starts its LSP server.
//
// POST /api/lsp/languages
func (lr *LSPRoutes) add(w http.ResponseWriter, r *http.Request) {
	if lr.lspMgr == nil {
		respondError(w, http.StatusServiceUnavailable, "LSP manager not available")
		return
	}

	var req addLanguageRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	langID := req.Language
	if langID == "" {
		respondError(w, http.StatusBadRequest, "language is required")
		return
	}

	// Verify adapter exists.
	adapters := lr.lspMgr.AvailableLanguages()
	var found bool
	for _, a := range adapters {
		if a.ID == langID {
			found = true
			break
		}
	}
	if !found {
		respondError(w, http.StatusBadRequest, "unknown language: "+langID)
		return
	}

	// Update project config: add language with enabled=true.
	store := lr.getStore()
	project, err := store.Config.Load()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "load config: "+err.Error())
		return
	}
	if project.Settings.LSP == nil {
		project.Settings.LSP = &models.LSPSettings{Languages: map[string]models.LSPLanguageSettings{}}
	}
	if project.Settings.LSP.Languages == nil {
		project.Settings.LSP.Languages = map[string]models.LSPLanguageSettings{}
	}
	enabled := true
	project.Settings.LSP.Languages[langID] = models.LSPLanguageSettings{Enabled: &enabled}
	if err := store.Config.Save(project); err != nil {
		respondError(w, http.StatusInternalServerError, "save config: "+err.Error())
		return
	}
	lr.refreshManagerConfig(project)

	// Start LSP server (best effort — config is persisted regardless).
	var status string
	if err := lr.lspMgr.StartLanguage(r.Context(), langID); err != nil {
		status = "not_installed"
	} else {
		status = "running"
	}

	broadcastLSPEvent(lr.sse, langID, status, "added")
	respondJSON(w, http.StatusOK, map[string]string{
		"language": langID,
		"status":   status,
		"action":   "added",
	})
}

// toggleLanguageRequest is the body for PUT /api/lsp/languages/{lang}.
type toggleLanguageRequest struct {
	Enabled bool `json:"enabled"`
}

// toggle enables or disables an LSP language and starts/stops its server.
//
// PUT /api/lsp/languages/{lang}
func (lr *LSPRoutes) toggle(w http.ResponseWriter, r *http.Request) {
	if lr.lspMgr == nil {
		respondError(w, http.StatusServiceUnavailable, "LSP manager not available")
		return
	}

	langID := chi.URLParam(r, "lang")
	if langID == "" {
		respondError(w, http.StatusBadRequest, "language is required")
		return
	}

	var req toggleLanguageRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	// Update project config.
	store := lr.getStore()
	project, err := store.Config.Load()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "load config: "+err.Error())
		return
	}
	if project.Settings.LSP == nil || project.Settings.LSP.Languages == nil {
		respondError(w, http.StatusNotFound, "language not configured: "+langID)
		return
	}
	settings, ok := project.Settings.LSP.Languages[langID]
	if !ok {
		respondError(w, http.StatusNotFound, "language not configured: "+langID)
		return
	}
	settings.Enabled = &req.Enabled
	project.Settings.LSP.Languages[langID] = settings
	if err := store.Config.Save(project); err != nil {
		respondError(w, http.StatusInternalServerError, "save config: "+err.Error())
		return
	}
	lr.refreshManagerConfig(project)

	var status string
	if req.Enabled {
		if err := lr.lspMgr.StartLanguage(r.Context(), langID); err != nil {
			status = "not_installed"
		} else {
			status = "running"
		}
	} else {
		_ = lr.lspMgr.StopLanguage(langID)
		status = "stopped"
	}

	broadcastLSPEvent(lr.sse, langID, status, "toggled")
	respondJSON(w, http.StatusOK, map[string]string{
		"language": langID,
		"status":   status,
		"action":   "toggled",
	})
}

// remove deletes a language from config and stops its LSP server.
//
// DELETE /api/lsp/languages/{lang}
func (lr *LSPRoutes) remove(w http.ResponseWriter, r *http.Request) {
	if lr.lspMgr == nil {
		respondError(w, http.StatusServiceUnavailable, "LSP manager not available")
		return
	}

	langID := chi.URLParam(r, "lang")
	if langID == "" {
		respondError(w, http.StatusBadRequest, "language is required")
		return
	}

	// Update project config: remove language entry.
	store := lr.getStore()
	project, err := store.Config.Load()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "load config: "+err.Error())
		return
	}
	if project.Settings.LSP != nil && project.Settings.LSP.Languages != nil {
		delete(project.Settings.LSP.Languages, langID)
	}
	if err := store.Config.Save(project); err != nil {
		respondError(w, http.StatusInternalServerError, "save config: "+err.Error())
		return
	}
	lr.refreshManagerConfig(project)

	// Stop LSP server (best effort).
	_ = lr.lspMgr.StopLanguage(langID)

	broadcastLSPEvent(lr.sse, langID, "removed", "removed")
	respondJSON(w, http.StatusOK, map[string]string{
		"language": langID,
		"status":   "removed",
		"action":   "removed",
	})
}

// restart restarts a language server through the shared LSP manager.
//
// POST /api/lsp/languages/{lang}/restart
func (lr *LSPRoutes) restart(w http.ResponseWriter, r *http.Request) {
	if lr.lspMgr == nil {
		respondError(w, http.StatusServiceUnavailable, "LSP manager not available")
		return
	}
	langID := chi.URLParam(r, "lang")
	if langID == "" {
		respondError(w, http.StatusBadRequest, "language is required")
		return
	}
	if _, ok := lr.languageInfo(langID); !ok {
		respondError(w, http.StatusNotFound, "unknown language: "+langID)
		return
	}

	err := lr.lspMgr.RestartLanguage(r.Context(), langID)
	lr.respondLanguageAction(w, langID, "restarted", err, nil)
}

type patchLanguageConfigRequest struct {
	Backend     *string        `json:"backend,omitempty"`
	ProjectPath *string        `json:"projectPath,omitempty"`
	Version     *string        `json:"version,omitempty"`
	Binary      *string        `json:"binary,omitempty"`
	Settings    map[string]any `json:"settings,omitempty"`
	Apply       bool           `json:"apply,omitempty"`
}

// patchConfig updates persisted per-language LSP settings and optionally
// restarts the runtime with the new configuration.
//
// PATCH /api/lsp/languages/{lang}/config
func (lr *LSPRoutes) patchConfig(w http.ResponseWriter, r *http.Request) {
	if lr.lspMgr == nil {
		respondError(w, http.StatusServiceUnavailable, "LSP manager not available")
		return
	}
	langID := chi.URLParam(r, "lang")
	if langID == "" {
		respondError(w, http.StatusBadRequest, "language is required")
		return
	}
	if _, ok := lr.languageInfo(langID); !ok {
		respondError(w, http.StatusNotFound, "unknown language: "+langID)
		return
	}

	var req patchLanguageConfigRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	store := lr.getStore()
	project, err := store.Config.Load()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "load config: "+err.Error())
		return
	}
	if project.Settings.LSP == nil {
		project.Settings.LSP = &models.LSPSettings{Languages: map[string]models.LSPLanguageSettings{}}
	}
	if project.Settings.LSP.Languages == nil {
		project.Settings.LSP.Languages = map[string]models.LSPLanguageSettings{}
	}
	settings := project.Settings.LSP.Languages[langID]
	if req.Backend != nil {
		settings.Backend = *req.Backend
	}
	if req.ProjectPath != nil {
		settings.ProjectPath = *req.ProjectPath
	}
	if req.Version != nil {
		settings.Version = *req.Version
	}
	if req.Binary != nil {
		settings.Binary = *req.Binary
	}
	if req.Settings != nil {
		if settings.Settings == nil {
			settings.Settings = map[string]any{}
		}
		for key, value := range req.Settings {
			settings.Settings[key] = value
		}
	}
	project.Settings.LSP.Languages[langID] = settings

	if err := store.Config.Save(project); err != nil {
		respondError(w, http.StatusInternalServerError, "save config: "+err.Error())
		return
	}
	lr.refreshManagerConfig(project)

	var applyErr error
	if req.Apply {
		applyErr = lr.lspMgr.RestartLanguage(r.Context(), langID)
	}
	lr.respondLanguageAction(w, langID, "configured", applyErr, map[string]any{"applied": req.Apply})
}

// install triggers the manager's existing managed installer path.
//
// POST /api/lsp/languages/{lang}/install
func (lr *LSPRoutes) install(w http.ResponseWriter, r *http.Request) {
	if lr.lspMgr == nil {
		respondError(w, http.StatusServiceUnavailable, "LSP manager not available")
		return
	}
	langID := chi.URLParam(r, "lang")
	if langID == "" {
		respondError(w, http.StatusBadRequest, "language is required")
		return
	}
	if _, ok := lr.languageInfo(langID); !ok {
		respondError(w, http.StatusNotFound, "unknown language: "+langID)
		return
	}

	path, err := lr.lspMgr.InstallLanguage(r.Context(), langID)
	lr.respondLanguageAction(w, langID, "installed", err, map[string]any{"path": path})
}

// cleanup removes old managed runtime versions for a language.
//
// POST /api/lsp/languages/{lang}/cleanup
func (lr *LSPRoutes) cleanup(w http.ResponseWriter, r *http.Request) {
	if lr.lspMgr == nil {
		respondError(w, http.StatusServiceUnavailable, "LSP manager not available")
		return
	}
	langID := chi.URLParam(r, "lang")
	if langID == "" {
		respondError(w, http.StatusBadRequest, "language is required")
		return
	}
	if _, ok := lr.languageInfo(langID); !ok {
		respondError(w, http.StatusNotFound, "unknown language: "+langID)
		return
	}

	err := lr.lspMgr.CleanupLanguage(langID)
	lr.respondLanguageAction(w, langID, "cleaned", err, nil)
}

// logs returns a bounded runtime or trace log tail.
//
// GET /api/lsp/languages/{lang}/logs?kind=runtime|trace&tail=200
func (lr *LSPRoutes) logs(w http.ResponseWriter, r *http.Request) {
	if lr.lspMgr == nil {
		respondError(w, http.StatusServiceUnavailable, "LSP manager not available")
		return
	}
	langID := chi.URLParam(r, "lang")
	if langID == "" {
		respondError(w, http.StatusBadRequest, "language is required")
		return
	}
	kind := r.URL.Query().Get("kind")
	tail := 200
	if raw := r.URL.Query().Get("tail"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			respondError(w, http.StatusBadRequest, "tail must be a non-negative integer")
			return
		}
		tail = n
	}

	logTail, err := lr.lspMgr.TailLog(langID, kind, tail)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"language": logTail.LanguageID,
		"kind":     logTail.Kind,
		"logPath":  logTail.Path,
		"lines":    logTail.Lines,
		"content":  strings.Join(logTail.Lines, "\n"),
	})
}

type traceLanguageRequest struct {
	Enabled *bool `json:"enabled"`
}

// trace toggles JSON-RPC tracing for an existing or future language server.
//
// POST /api/lsp/languages/{lang}/trace
func (lr *LSPRoutes) trace(w http.ResponseWriter, r *http.Request) {
	if lr.lspMgr == nil {
		respondError(w, http.StatusServiceUnavailable, "LSP manager not available")
		return
	}
	langID := chi.URLParam(r, "lang")
	if langID == "" {
		respondError(w, http.StatusBadRequest, "language is required")
		return
	}
	if _, ok := lr.languageInfo(langID); !ok {
		respondError(w, http.StatusNotFound, "unknown language: "+langID)
		return
	}
	var req traceLanguageRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if req.Enabled == nil {
		respondError(w, http.StatusBadRequest, "enabled is required")
		return
	}

	path, err := lr.lspMgr.SetTrace(langID, *req.Enabled)
	lr.respondLanguageAction(w, langID, "trace", err, map[string]any{
		"enabled":   *req.Enabled,
		"tracePath": path,
	})
}

func (lr *LSPRoutes) refreshManagerConfig(project *models.Project) {
	if lr.lspMgr == nil {
		return
	}
	var defaults *storage.ProjectDefaults
	if settings, err := storage.NewEmbeddingSettingsStore().Load(); err == nil {
		defaults = settings.ProjectDefaults
	}
	lr.lspMgr.SetConfig(lsp.ConfigFromProjectWithDefaults(project, defaults))
}

func (lr *LSPRoutes) languageInfo(langID string) (lsp.LanguageInfo, bool) {
	if lr.lspMgr == nil {
		return lsp.LanguageInfo{}, false
	}
	for _, info := range lr.lspMgr.AvailableLanguages() {
		if info.ID == langID {
			return info, true
		}
	}
	return lsp.LanguageInfo{}, false
}

func (lr *LSPRoutes) respondLanguageAction(w http.ResponseWriter, langID, action string, actionErr error, fields map[string]any) {
	info, _ := lr.languageInfo(langID)
	status := info.Status
	if status == "" {
		status = "unknown"
	}
	if actionErr != nil && status == "unknown" {
		status = "error"
	}
	payload := map[string]any{
		"language":     langID,
		"status":       status,
		"action":       action,
		"info":         info,
		"languageInfo": info,
	}
	for key, value := range fields {
		payload[key] = value
	}
	if actionErr != nil {
		payload["error"] = actionErr.Error()
	}
	broadcastLSPEvent(lr.sse, langID, status, action)
	respondJSON(w, http.StatusOK, payload)
}

// lspLanguageEvent is the SSE payload for lsp:language events.
type lspLanguageEvent struct {
	Language string `json:"language"`
	Status   string `json:"status"`
	Action   string `json:"action"`
}

func broadcastLSPEvent(broadcaster Broadcaster, langID, status, action string) {
	if broadcaster == nil {
		return
	}
	broadcaster.Broadcast(SSEEvent{
		Type: "lsp:language",
		Data: lspLanguageEvent{Language: langID, Status: status, Action: action},
	})
}
