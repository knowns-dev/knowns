package routes

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestValidateExternalURL_BlocksSSRF(t *testing.T) {
	blockedURLs := []string{
		"http://127.0.0.1:8080/embeddings",
		"http://127.0.0.1/embeddings",
		"http://localhost:8080/embeddings",
		"http://169.254.169.254/latest/meta-data",
		"http://169.254.169.254:80/latest/meta-data",
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://10.0.0.1/embeddings",
		"http://10.255.255.255/embeddings",
		"http://192.168.1.1/embeddings",
		"http://172.16.0.1/embeddings",
		"http://172.31.255.255/embeddings",
		"file:///etc/passwd",
		"gopher://127.0.0.1:6379/_flushall",
		"ftp://127.0.0.1/",
	}

	for _, raw := range blockedURLs {
		if err := validateExternalURL(raw); err == nil {
			t.Errorf("validateExternalURL(%q) should have failed, but succeeded", raw)
		}
	}
}

func TestValidateGitSource_BlocksSSRFAndDangerousProtocols(t *testing.T) {
	blockedSources := []string{
		"ext::sh -c whoami",
		"fd::1",
		"file:///tmp/repo.git",
		"http://127.0.0.1:8080/repo.git",
		"http://169.254.169.254/repo.git",
		"http://metadata.google.internal/repo.git",
		"git@127.0.0.1:repo.git",
		"git@169.254.169.254:repo.git",
		"git@localhost:repo.git",
		"--upload-pack=calc",
	}

	for _, src := range blockedSources {
		if err := validateGitSource(src); err == nil {
			t.Errorf("validateGitSource(%q) should have failed, but succeeded", src)
		}
	}
}

func TestValidateGitSource_AllowsSafeRemoteURLs(t *testing.T) {
	allowedSources := []string{
		"https://github.com/knowns-dev/knowns.git",
		"git@github.com:knowns-dev/knowns.git",
	}

	for _, src := range allowedSources {
		if err := validateGitSource(src); err != nil {
			t.Errorf("validateGitSource(%q) failed unexpectedly: %v", src, err)
		}
	}
}

func TestEmbeddingModelRoutes_RejectsSSRF(t *testing.T) {
	r := chi.NewRouter()
	emr := &EmbeddingModelRoutes{}
	emr.Register(r)

	payload := `{"apiBase":"http://169.254.169.254/latest/meta-data","model":"text-embedding-ada-002"}`
	req := httptest.NewRequest(http.MethodPost, "/models/embeddings/test", bytes.NewBufferString(payload))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected HTTP 400 for SSRF attempt, got %d: %s", w.Code, w.Body.String())
	}
}
