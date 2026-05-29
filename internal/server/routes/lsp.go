// Package routes provides LSP language hot-add REST endpoints.
package routes

import (
	"net/http"

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
		"status":  status,
		"action":  "added",
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
		"status":  status,
		"action":  "toggled",
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

	// Stop LSP server (best effort).
	_ = lr.lspMgr.StopLanguage(langID)

	broadcastLSPEvent(lr.sse, langID, "removed", "removed")
	respondJSON(w, http.StatusOK, map[string]string{
		"language": langID,
		"status":  "removed",
		"action":  "removed",
	})
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