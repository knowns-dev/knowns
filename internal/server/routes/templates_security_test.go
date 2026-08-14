package routes

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestTemplatePreviewRejectsTraversalAndAllowsTemplateFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	base := t.TempDir()
	store := storage.NewStore(filepath.Join(base, ".knowns"))
	if err := store.Init("template-preview-security"); err != nil {
		t.Fatal(err)
	}
	if err := store.Templates.Create("safe", "safe template"); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(store.Root, "templates", "secret.txt")
	if err := os.WriteFile(secret, []byte("do-not-read"), 0644); err != nil {
		t.Fatal(err)
	}

	router := chi.NewRouter()
	(&TemplateRoutes{store: store}).Register(router)

	unsafe := httptest.NewRequest(http.MethodPost, "/templates/preview", bytes.NewBufferString(`{"name":"safe","templateFile":"../secret.txt"}`))
	unsafe.Header.Set("Content-Type", "application/json")
	unsafeW := httptest.NewRecorder()
	router.ServeHTTP(unsafeW, unsafe)
	if unsafeW.Code != http.StatusBadRequest {
		t.Fatalf("unsafe preview status = %d, want 400: %s", unsafeW.Code, unsafeW.Body.String())
	}
	if bytes.Contains(unsafeW.Body.Bytes(), []byte("do-not-read")) {
		t.Fatal("unsafe preview returned file content")
	}

	safe := httptest.NewRequest(http.MethodPost, "/templates/preview", bytes.NewBufferString(`{"name":"safe","variables":{"name":"Widget"},"templateFile":"main.hbs"}`))
	safe.Header.Set("Content-Type", "application/json")
	safeW := httptest.NewRecorder()
	router.ServeHTTP(safeW, safe)
	if safeW.Code != http.StatusOK {
		t.Fatalf("safe preview status = %d, want 200: %s", safeW.Code, safeW.Body.String())
	}
}
