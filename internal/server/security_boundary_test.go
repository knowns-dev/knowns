package server

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestServeRejectsUnprotectedNonLoopbackListener(t *testing.T) {
	listener, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Skipf("all-interface listener unavailable: %v", err)
	}
	defer listener.Close()
	s := &Server{auth: NewAuthManager("")}
	if err := s.StartWithListener(listener); err == nil {
		t.Fatal("unprotected non-loopback listener was accepted")
	}
}

func TestTrustedOriginMiddlewareRejectsCrossSiteLoopbackRequest(t *testing.T) {
	handler := trustedOriginMiddleware(func() bool { return false })(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	for _, tc := range []struct {
		name   string
		host   string
		origin string
		want   int
	}{
		{name: "same local host", host: "127.0.0.1:6420", origin: "http://127.0.0.1:5173", want: http.StatusNoContent},
		{name: "localhost alias", host: "localhost:6420", origin: "http://127.0.0.1:5173", want: http.StatusNoContent},
		{name: "DNS rebinding host", host: "attacker.example:6420", origin: "", want: http.StatusForbidden},
		{name: "cross site", host: "127.0.0.1:6420", origin: "https://attacker.example", want: http.StatusForbidden},
		{name: "invalid origin", host: "127.0.0.1:6420", origin: "null", want: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "http://"+tc.host+"/api/config", nil)
			req.Host = tc.host
			req.Header.Set("Origin", tc.origin)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d", w.Code, tc.want)
			}
		})
	}

	protectedPublic := trustedOriginMiddleware(func() bool { return true })(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "https://example.trycloudflare.com/api/config", nil)
	req.Host = "example.trycloudflare.com"
	req.Header.Set("Origin", "https://example.trycloudflare.com")
	w := httptest.NewRecorder()
	protectedPublic.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("password-protected public origin status = %d, want %d", w.Code, http.StatusNoContent)
	}
}
