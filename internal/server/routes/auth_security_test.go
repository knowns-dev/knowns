package routes

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

type securityTestAuth struct {
	password bool
	removed  bool
}

func (a *securityTestAuth) HasPassword() bool                 { return a.password }
func (a *securityTestAuth) Login(string) (string, bool)       { return "", false }
func (a *securityTestAuth) SetPassword(string)                { a.password = true }
func (a *securityTestAuth) CreateSession() string             { return "valid" }
func (a *securityTestAuth) ValidateSession(token string) bool { return token == "valid" }
func (a *securityTestAuth) RemovePassword()                   { a.password, a.removed = false, true }

func TestPasswordCannotBeRemovedWhilePublicProtectionIsRequired(t *testing.T) {
	auth := &securityTestAuth{password: true}
	router := chi.NewRouter()
	SetupAuthRoutes(router, auth, nil, func() bool { return false })
	req := httptest.NewRequest(http.MethodDelete, "/password", nil)
	req.AddCookie(&http.Cookie{Name: "knowns_session", Value: "valid"})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", w.Code, w.Body.String())
	}
	if auth.removed || !auth.password {
		t.Fatal("password protection was removed while a public tunnel required it")
	}
}
