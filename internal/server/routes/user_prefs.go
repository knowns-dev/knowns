package routes

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/storage"
)

// UserPrefsRoutes handles /api/user-preferences endpoints.
type UserPrefsRoutes struct {
	store *storage.UserPrefsStore
}

// Register wires the user preferences routes onto r.
func (upr *UserPrefsRoutes) Register(r chi.Router) {
	r.Get("/user-preferences", upr.get)
	r.Post("/user-preferences", upr.save)
}

// get returns the user-level preferences.
//
// GET /api/user-preferences
func (upr *UserPrefsRoutes) get(w http.ResponseWriter, r *http.Request) {
	prefs, err := upr.store.Load()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, prefs)
}

// save updates user-level preferences (partial merge).
//
// POST /api/user-preferences
func (upr *UserPrefsRoutes) save(w http.ResponseWriter, r *http.Request) {
	prefs, err := upr.store.Load()
	if err != nil {
		respondError(w, http.StatusInternalServerError, "load user prefs: "+err.Error())
		return
	}

	var payload map[string]json.RawMessage
	if err := decodeJSON(r, &payload); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	if err := upr.store.Save(prefs); err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, prefs)
}
