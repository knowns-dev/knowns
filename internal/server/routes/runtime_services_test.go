package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestRuntimeServicesUsesInjectedLSPRuntimeSnapshot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Config.Save(&models.Project{Name: "runtime-services-test", ID: "runtime-services-test"}); err != nil {
		t.Fatalf("save project config: %v", err)
	}

	handler := &RuntimeServicesRoutes{
		store: store,
		lspStatuses: func(context.Context, *storage.Store) []lsp.LanguageRuntimeStatus {
			return []lsp.LanguageRuntimeStatus{{
				ID:             "go",
				Name:           "Go",
				Enabled:        true,
				Detected:       true,
				Status:         lsp.RuntimeRunningRunning,
				InstallState:   lsp.RuntimeInstallInstalled,
				RunningState:   lsp.RuntimeRunningRunning,
				ReadinessState: lsp.RuntimeReadinessReady,
				Owner:          "daemon",
				DaemonState:    "running",
				DaemonPID:      4242,
			}}
		},
	}
	router := chi.NewRouter()
	handler.Register(router)

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/runtime/services", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	var payload struct {
		Services []struct {
			Name    string            `json:"name"`
			Type    string            `json:"type"`
			Status  string            `json:"status"`
			Details map[string]string `json:"details"`
		} `json:"services"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	for _, service := range payload.Services {
		if service.Type != "lsp" || service.Name != "LSP (go)" {
			continue
		}
		if service.Status != "running" {
			t.Fatalf("LSP status = %q, want running", service.Status)
		}
		if service.Details["owner"] != "daemon" {
			t.Fatalf("LSP owner = %q, want daemon", service.Details["owner"])
		}
		if service.Details["daemon_pid"] != "4242" {
			t.Fatalf("LSP daemon_pid = %q, want 4242", service.Details["daemon_pid"])
		}
		return
	}
	t.Fatalf("daemon-owned Go LSP service missing from response: %+v", payload.Services)
}
