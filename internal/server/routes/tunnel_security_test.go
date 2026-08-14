package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

type securityTestTunnel struct{ starts int }

func (t *securityTestTunnel) Start() (string, error) {
	t.starts++
	return "https://example.trycloudflare.com", nil
}
func (t *securityTestTunnel) Stop() error          { return nil }
func (t *securityTestTunnel) Status() TunnelStatus { return TunnelStatus{} }

func TestTunnelStartRequiresPasswordProtection(t *testing.T) {
	tunnel := &securityTestTunnel{}
	router := chi.NewRouter()
	SetupTunnelRoutes(router, tunnel, nil, func() bool { return false })
	req := httptest.NewRequest(http.MethodPost, "/start", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", w.Code, w.Body.String())
	}
	if tunnel.starts != 0 {
		t.Fatalf("tunnel started %d times without protection", tunnel.starts)
	}
}
