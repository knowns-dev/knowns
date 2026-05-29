package routes

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// AuthProvider is the interface the auth routes need from the server's AuthManager.
type AuthProvider interface {
	HasPassword() bool
	Login(password string) (string, bool)
	SetPassword(password string)
	RemovePassword()
	CreateSession() string
	ValidateSession(token string) bool
}

// AuthRoutes handles authentication endpoints.
type AuthRoutes struct {
	auth        AuthProvider
	broadcaster Broadcaster
}

func SetupAuthRoutes(r chi.Router, auth AuthProvider, broadcaster Broadcaster) {
	ar := &AuthRoutes{auth: auth, broadcaster: broadcaster}
	r.Get("/status", ar.getStatus)
	r.Post("/login", ar.login)
	r.Post("/password", ar.setPassword)
	r.Delete("/password", ar.removePassword)
}

func (ar *AuthRoutes) getStatus(w http.ResponseWriter, r *http.Request) {
	authenticated := false
	if ar.auth.HasPassword() {
		cookie, err := r.Cookie("knowns_session")
		if err == nil {
			authenticated = ar.auth.ValidateSession(cookie.Value)
		}
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"protected":     ar.auth.HasPassword(),
		"authenticated": authenticated,
	})
}

func (ar *AuthRoutes) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Password == "" {
		respondError(w, http.StatusBadRequest, "password is required")
		return
	}

	token, ok := ar.auth.Login(body.Password)
	if !ok {
		respondError(w, http.StatusUnauthorized, "invalid password")
		return
	}

	setSessionCookie(w, token)
	respondJSON(w, http.StatusOK, map[string]any{"success": true, "token": token})
}

func (ar *AuthRoutes) setPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.Password == "" {
		respondError(w, http.StatusBadRequest, "password cannot be empty")
		return
	}

	ar.auth.SetPassword(body.Password)
	token := ar.auth.CreateSession()
	setSessionCookie(w, token)

	if ar.broadcaster != nil {
		ar.broadcaster.Broadcast(SSEEvent{Type: "auth:status", Data: map[string]any{
			"protected": true,
		}})
	}

	respondJSON(w, http.StatusOK, map[string]any{"success": true, "protected": true, "token": token})
}

func (ar *AuthRoutes) removePassword(w http.ResponseWriter, r *http.Request) {
	if ar.auth.HasPassword() {
		cookie, err := r.Cookie("knowns_session")
		if err != nil || !ar.auth.ValidateSession(cookie.Value) {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
	}

	ar.auth.RemovePassword()
	clearSessionCookie(w)

	if ar.broadcaster != nil {
		ar.broadcaster.Broadcast(SSEEvent{Type: "auth:status", Data: map[string]any{
			"protected": false,
		}})
	}

	respondJSON(w, http.StatusOK, map[string]any{"success": true, "protected": false})
}

func setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "knowns_session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     "knowns_session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}
