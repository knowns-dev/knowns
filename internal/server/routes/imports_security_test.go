package routes

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestGitTokenInjectionRequiresExactConfiguredHTTPSHost(t *testing.T) {
	const token = "top-secret"
	trusted := injectTokenInURL("https://github.com/knowns-dev/knowns.git", token, "github.com")
	if !strings.Contains(trusted, token) {
		t.Fatalf("trusted host did not receive token: %s", trusted)
	}
	for _, source := range []string{
		"https://github.com.attacker.example/repo.git",
		"https://attacker.example/repo.git",
		"http://github.com/repo.git",
	} {
		if got := injectTokenInURL(source, token, "github.com"); got != source {
			t.Errorf("untrusted source changed: got %q want %q", got, source)
		}
	}
}

func TestGitURLDetectionDoesNotTreatLocalDotGitPathAsRemote(t *testing.T) {
	for _, source := range []string{"/tmp/private.git", `C:\private.git`, "file:///tmp/private.git", "--upload-pack=calc"} {
		if isGitURL(source) {
			t.Errorf("isGitURL(%q) = true, want false", source)
		}
	}
	for _, source := range []string{"https://github.com/knowns-dev/knowns.git", "git@github.com:knowns-dev/knowns.git"} {
		if !isGitURL(source) {
			t.Errorf("isGitURL(%q) = false, want true", source)
		}
	}
}

func TestGitEnvironmentTokenRequiresEnvironmentHost(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KNOWNS_GIT_TOKEN", "environment-secret")
	t.Setenv("KNOWNS_GIT_HOST", "")
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("git-credential-security"); err != nil {
		t.Fatal(err)
	}
	if err := store.Config.Set("git.host", "attacker.example"); err != nil {
		t.Fatal(err)
	}
	token, host := (&ImportRoutes{store: store}).gitCredential()
	if token != "" || host != "" {
		t.Fatalf("environment token paired with project host: token=%q host=%q", token, host)
	}
}

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
