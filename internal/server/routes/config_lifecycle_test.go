package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

type configLifecycleEnvelope struct {
	Config struct {
		TaskLifecycle models.TaskLifecycleSettings `json:"taskLifecycle"`
		Capabilities  struct {
			TaskHardDelete bool `json:"taskHardDelete"`
		} `json:"capabilities"`
	} `json:"config"`
}

func TestConfigLifecyclePOSTPreservesLegacyProjectResponse(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	router := configLifecycleRouter(store, true)
	request := httptest.NewRequest(http.MethodPost, "/api/config", strings.NewReader(`{
		"name":"legacy-post","defaultPriority":"high",
		"taskLifecycle":{"autoArchive":false}
	}`))
	request.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, request)
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("POST status=%d content-type=%q body=%s", w.Code, w.Header().Get("Content-Type"), w.Body.String())
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 4 || raw["name"] == nil || raw["id"] == nil || raw["createdAt"] == nil || raw["settings"] == nil {
		t.Fatalf("legacy POST top-level shape = %v", raw)
	}
	if raw["config"] != nil || raw["capabilities"] != nil || raw["taskLifecycle"] != nil {
		t.Fatalf("legacy POST gained envelope fields: %v", raw)
	}
	var project models.Project
	if err := json.Unmarshal(w.Body.Bytes(), &project); err != nil {
		t.Fatal(err)
	}
	if project.Name != "legacy-post" || project.Settings.DefaultPriority != "high" || project.Settings.TaskLifecycle == nil || project.Settings.TaskLifecycle.AutoArchive {
		t.Fatalf("legacy POST project = %#v", project)
	}
}

func TestConfigLifecyclePATCHReturnsEffectiveEnvelope(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	router := configLifecycleRouter(store, true)
	request := httptest.NewRequest(http.MethodPatch, "/api/config", strings.NewReader(`{"taskLifecycle":{"autoArchive":false}}`))
	request.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, request)
	if w.Code != http.StatusOK {
		t.Fatalf("PATCH status=%d body=%s", w.Code, w.Body.String())
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 1 || raw["config"] == nil || raw["name"] != nil || raw["settings"] != nil {
		t.Fatalf("PATCH envelope shape = %v", raw)
	}
	var response configLifecycleEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Config.TaskLifecycle.AutoArchive || response.Config.TaskLifecycle.ArchiveAfter != "30d" || !response.Config.Capabilities.TaskHardDelete {
		t.Fatalf("PATCH effective envelope = %#v", response)
	}
}

func TestConfigLifecycleGETReturnsEffectiveDefaultsAndTrustedCapability(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatal(err)
	}
	project.Settings.TaskLifecycle = nil
	if err := store.Config.Save(project); err != nil {
		t.Fatal(err)
	}

	denied := configLifecycleRouter(store, false)
	response := callConfigLifecycle(t, denied, http.MethodGet, "/api/config?capabilities.taskHardDelete=true", nil, http.StatusOK)
	assertDefaultLifecycleSettings(t, response.Config.TaskLifecycle)
	if response.Config.Capabilities.TaskHardDelete {
		t.Fatal("request query elevated trusted hard-delete capability")
	}

	spoof := callConfigLifecycle(t, denied, http.MethodPatch, "/api/config", []byte(`{"capabilities":{"taskHardDelete":true}}`), http.StatusOK)
	if spoof.Config.Capabilities.TaskHardDelete {
		t.Fatal("PATCH payload elevated trusted hard-delete capability")
	}
	reloaded, err := store.Config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Settings.TaskLifecycle != nil {
		t.Fatalf("unrelated PATCH materialized legacy lifecycle settings: %#v", reloaded.Settings.TaskLifecycle)
	}

	allowed := configLifecycleRouter(store, true)
	response = callConfigLifecycle(t, allowed, http.MethodGet, "/api/config", nil, http.StatusOK)
	if !response.Config.Capabilities.TaskHardDelete {
		t.Fatal("trusted server capability was not exposed")
	}
}

func TestConfigLifecyclePATCHMergesPersistsAndDistinguishesZeroFromDisabled(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatal(err)
	}
	purgeAfter := "90d"
	project.Settings.TaskLifecycle = &models.TaskLifecycleSettings{
		ExcludeDoneFromDefaultRetrieval: false,
		AutoArchive:                     true,
		ArchiveAfter:                    "7d",
		PurgeAfter:                      &purgeAfter,
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatal(err)
	}
	router := configLifecycleRouter(store, false)

	response := callConfigLifecycle(t, router, http.MethodPatch, "/api/config", []byte(`{
		"settings":{"taskLifecycle":{"autoArchive":false,"archiveAfter":"0s","purgeAfter":null}}
	}`), http.StatusOK)
	settings := response.Config.TaskLifecycle
	if settings.ExcludeDoneFromDefaultRetrieval || settings.AutoArchive || settings.ArchiveAfter != "0s" || settings.PurgeAfter != nil {
		t.Fatalf("merged lifecycle settings = %#v", settings)
	}
	assertStoredLifecycleSettings(t, store, settings)

	response = callConfigLifecycle(t, router, http.MethodPatch, "/api/config", []byte(`{
		"taskLifecycle":{"autoArchive":true,"purgeAfter":"0s"}
	}`), http.StatusOK)
	settings = response.Config.TaskLifecycle
	if !settings.AutoArchive || settings.ArchiveAfter != "0s" || settings.PurgeAfter == nil || *settings.PurgeAfter != "0s" {
		t.Fatalf("zero-duration enabled lifecycle settings = %#v", settings)
	}
	if settings.ExcludeDoneFromDefaultRetrieval {
		t.Fatal("partial update reset omitted excludeDoneFromDefaultRetrieval")
	}
	assertStoredLifecycleSettings(t, store, settings)
}

func TestConfigLifecyclePATCHRejectsInvalidFieldsWithoutPersistence(t *testing.T) {
	store := newTaskLifecycleRouteStore(t)
	router := configLifecycleRouter(store, false)
	configPath := filepath.Join(store.Root, "config.json")

	tests := []struct {
		name    string
		body    string
		wantErr string
	}{
		{name: "invalid duration", body: `{"taskLifecycle":{"archiveAfter":"-1d"}}`, wantErr: "settings.taskLifecycle.archiveAfter"},
		{name: "invalid type", body: `{"taskLifecycle":{"autoArchive":"yes"}}`, wantErr: "settings.taskLifecycle.autoArchive"},
		{name: "null required field", body: `{"taskLifecycle":{"archiveAfter":null}}`, wantErr: "settings.taskLifecycle.archiveAfter"},
		{name: "unknown field", body: `{"taskLifecycle":{"archiveSoon":true}}`, wantErr: "settings.taskLifecycle.archiveSoon"},
		{name: "null block", body: `{"taskLifecycle":null}`, wantErr: "settings.taskLifecycle"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before, err := os.ReadFile(configPath)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPatch, "/api/config", strings.NewReader(tt.body))
			request.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, request)
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), tt.wantErr) {
				t.Fatalf("PATCH status=%d body=%s, want field %q", w.Code, w.Body.String(), tt.wantErr)
			}
			after, err := os.ReadFile(configPath)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(after, before) {
				t.Fatalf("invalid PATCH mutated config\nbefore=%s\nafter=%s", before, after)
			}
		})
	}
}

func configLifecycleRouter(store *storage.Store, hardDelete bool) http.Handler {
	api := chi.NewRouter()
	SetupRoutesWithCapabilities(api, store, &fakeBroadcaster{}, filepath.Dir(store.Root), nil, TaskRouteCapabilities{HardDelete: hardDelete})
	router := chi.NewRouter()
	router.Mount("/api", api)
	return router
}

func callConfigLifecycle(t *testing.T, router http.Handler, method, path string, body []byte, wantStatus int) configLifecycleEnvelope {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, request)
	if w.Code != wantStatus {
		t.Fatalf("%s %s status=%d body=%s", method, path, w.Code, w.Body.String())
	}
	var response configLifecycleEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode config response %s: %v", w.Body.String(), err)
	}
	return response
}

func assertDefaultLifecycleSettings(t *testing.T, settings models.TaskLifecycleSettings) {
	t.Helper()
	defaults := models.DefaultTaskLifecycleSettings()
	if settings.ExcludeDoneFromDefaultRetrieval != defaults.ExcludeDoneFromDefaultRetrieval ||
		settings.AutoArchive != defaults.AutoArchive || settings.ArchiveAfter != defaults.ArchiveAfter || settings.PurgeAfter != nil {
		t.Fatalf("effective lifecycle defaults = %#v, want %#v", settings, defaults)
	}
}

func assertStoredLifecycleSettings(t *testing.T, store *storage.Store, want models.TaskLifecycleSettings) {
	t.Helper()
	project, err := store.Config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if project.Settings.TaskLifecycle == nil {
		t.Fatal("explicit lifecycle update was not persisted")
	}
	got := project.Settings.EffectiveTaskLifecycle()
	if got.ExcludeDoneFromDefaultRetrieval != want.ExcludeDoneFromDefaultRetrieval || got.AutoArchive != want.AutoArchive || got.ArchiveAfter != want.ArchiveAfter {
		t.Fatalf("stored lifecycle settings = %#v, want %#v", got, want)
	}
	if (got.PurgeAfter == nil) != (want.PurgeAfter == nil) || (got.PurgeAfter != nil && *got.PurgeAfter != *want.PurgeAfter) {
		t.Fatalf("stored purgeAfter = %v, want %v", got.PurgeAfter, want.PurgeAfter)
	}
}
