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

func TestImportRoutesRejectUnsafeNameBeforeFilesystemWrite(t *testing.T) {
	root := t.TempDir()
	store := storage.NewStore(filepath.Join(root, ".knowns"))
	if err := store.Init("imports-security-test"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	router := chi.NewRouter()
	(&ImportRoutes{store: store}).Register(router)

	for _, body := range []string{
		`{"source":"local","name":"../escape"}`,
		`{"source":"local","name":"nested/name"}`,
		`{"source":"local","name":"..\\escape"}`,
		`{"source":"local","name":"."}`,
		`{"source":"local","name":".."}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/imports", bytes.NewBufferString(body))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("POST %s status = %d, want 400: %s", body, w.Code, w.Body.String())
		}
	}

	if _, err := os.Stat(filepath.Join(root, ".knowns", "escape")); !os.IsNotExist(err) {
		t.Fatalf("unsafe import created escaped path: %v", err)
	}
}

func TestImportRoutesAcceptSingleSegmentName(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("imports-security-test"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	router := chi.NewRouter()
	(&ImportRoutes{store: store}).Register(router)

	req := httptest.NewRequest(http.MethodPost, "/imports", bytes.NewBufferString(`{"source":"local","name":"shared-docs"}`))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, want 201: %s", w.Code, w.Body.String())
	}
	if info, err := os.Stat(filepath.Join(store.Root, "imports", "shared-docs")); err != nil || !info.IsDir() {
		t.Fatalf("valid import directory missing: info=%v err=%v", info, err)
	}
}
