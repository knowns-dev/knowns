package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

// AuthManager handles in-memory password protection and session management.
type AuthManager struct {
	mu       sync.RWMutex
	password string
	sessions map[string]time.Time
}

func NewAuthManager(initialPassword string) *AuthManager {
	return &AuthManager{
		password: initialPassword,
		sessions: make(map[string]time.Time),
	}
}

func (am *AuthManager) SetPassword(password string) {
	am.mu.Lock()
	defer am.mu.Unlock()
	am.password = password
	am.sessions = make(map[string]time.Time)
}

func (am *AuthManager) RemovePassword() {
	am.mu.Lock()
	defer am.mu.Unlock()
	am.password = ""
	am.sessions = make(map[string]time.Time)
}

func (am *AuthManager) HasPassword() bool {
	if am == nil {
		return false
	}
	am.mu.RLock()
	defer am.mu.RUnlock()
	return am.password != ""
}

func (am *AuthManager) Login(password string) (string, bool) {
	am.mu.Lock()
	defer am.mu.Unlock()
	if am.password == "" {
		return "", false
	}
	if subtle.ConstantTimeCompare([]byte(password), []byte(am.password)) != 1 {
		return "", false
	}
	token := generateToken()
	am.sessions[token] = time.Now()
	return token, true
}

func (am *AuthManager) CreateSession() string {
	am.mu.Lock()
	defer am.mu.Unlock()
	token := generateToken()
	am.sessions[token] = time.Now()
	return token
}

func (am *AuthManager) ValidateSession(token string) bool {
	am.mu.RLock()
	defer am.mu.RUnlock()
	_, ok := am.sessions[token]
	return ok
}

func (am *AuthManager) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if am == nil || !am.HasPassword() {
			next.ServeHTTP(w, r)
			return
		}

		path := r.URL.Path

		// Auth endpoints always accessible
		if path == "/api/auth/login" || path == "/api/auth/status" {
			next.ServeHTTP(w, r)
			return
		}

		// Allow setting password when none exists (first-time setup)
		if path == "/api/auth/password" && r.Method == "POST" && !am.HasPassword() {
			next.ServeHTTP(w, r)
			return
		}

		// Non-API requests (static UI assets, HTML pages) bypass auth
		// so the frontend LoginGate can handle the auth flow
		if !strings.HasPrefix(path, "/api/") && !strings.HasPrefix(path, "/ws/") {
			next.ServeHTTP(w, r)
			return
		}

		// Check cookie
		cookie, err := r.Cookie("knowns_session")
		if err == nil && am.ValidateSession(cookie.Value) {
			next.ServeHTTP(w, r)
			return
		}

		// Check query param token (for EventSource which can't send cookies cross-origin)
		if token := r.URL.Query().Get("token"); token != "" && am.ValidateSession(token) {
			next.ServeHTTP(w, r)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]any{
			"error":         "unauthorized",
			"loginRequired": true,
		})
	})
}

func generateToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}
