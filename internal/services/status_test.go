package services

import (
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestSortServiceStatusesRunningFirst(t *testing.T) {
	statuses := []ServiceStatus{
		{Name: "Zeta", Status: "stopped"},
		{Name: "TypeScript", Status: "running"},
		{Name: "Alpha", Status: "disabled"},
		{Name: "Go", Status: "running"},
		{Name: "Beta", Status: "error"},
	}

	sortServiceStatuses(statuses)

	got := make([]string, 0, len(statuses))
	for _, service := range statuses {
		got = append(got, service.Status+":"+service.Name)
	}
	want := []string{
		"running:Go",
		"running:TypeScript",
		"disabled:Alpha",
		"error:Beta",
		"stopped:Zeta",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ordered statuses = %v, want %v", got, want)
	}
}

func TestDetectEmbeddingReportsRuntimeDisabled(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KNOWNS_SEMANTIC_RUNTIME_DISABLED", "1")
	search.DefaultSemanticRuntime().Close()
	t.Cleanup(search.DefaultSemanticRuntime().Close)
	store := newStatusSemanticStore(t)
	saveStatusEmbeddingSettings(t)

	service := detectEmbedding(store)[0]
	if service.Status != "disabled" {
		t.Fatalf("status = %q, want disabled", service.Status)
	}
	if service.Details["runtime_enabled"] != "false" {
		t.Fatalf("runtime_enabled = %q, want false", service.Details["runtime_enabled"])
	}
	if service.Details["runtime_disabled_by"] != "KNOWNS_SEMANTIC_RUNTIME_DISABLED" {
		t.Fatalf("runtime_disabled_by = %q", service.Details["runtime_disabled_by"])
	}
}

func TestDetectEmbeddingReportsUnloadedRuntimeWithoutAPIProbe(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	search.DefaultSemanticRuntime().Close()
	t.Cleanup(search.DefaultSemanticRuntime().Close)
	store := newStatusSemanticStore(t)
	saveStatusEmbeddingSettings(t)

	service := detectEmbedding(store)[0]
	if service.Status != "stopped" {
		t.Fatalf("status = %q, want stopped", service.Status)
	}
	if service.Details["runtime_loaded"] != "false" {
		t.Fatalf("runtime_loaded = %q, want false", service.Details["runtime_loaded"])
	}
	if service.Details["provider"] != "api" {
		t.Fatalf("provider = %q, want api", service.Details["provider"])
	}
	if service.Details["model"] != "text-embedding-test" {
		t.Fatalf("model = %q, want configured API model", service.Details["model"])
	}
	if service.Details["note"] == "" {
		t.Fatalf("expected unloaded runtime note")
	}
}

func TestDetectEmbeddingReportsLoadedRuntimeConsumers(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	search.DefaultSemanticRuntime().Close()
	t.Cleanup(search.DefaultSemanticRuntime().Close)
	store := newStatusSemanticStore(t)
	saveStatusEmbeddingSettings(t)

	session, err := search.InitSemanticRuntimeSession(store)
	if err != nil {
		t.Fatalf("open semantic runtime session: %v", err)
	}
	defer session.Close()

	service := detectEmbedding(store)[0]
	if service.Status != "running" {
		t.Fatalf("status = %q, want running", service.Status)
	}
	if service.Details["runtime_loaded"] != "true" {
		t.Fatalf("runtime_loaded = %q, want true", service.Details["runtime_loaded"])
	}
	if service.Details["active_sessions"] != "1" {
		t.Fatalf("active_sessions = %q, want 1", service.Details["active_sessions"])
	}
	if service.Details["consumers"] == "" {
		t.Fatalf("expected consumers detail")
	}
}

func TestDetectEmbeddingReportsSemanticJobDegradedState(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	runtimequeue.SetTestBypass(true)
	t.Cleanup(func() { runtimequeue.SetTestBypass(false) })
	search.DefaultSemanticRuntime().Close()
	t.Cleanup(search.DefaultSemanticRuntime().Close)
	store := newStatusSemanticStore(t)
	saveStatusEmbeddingSettings(t)

	job, err := runtimequeue.Enqueue(store.Root, runtimequeue.JobIndexTask, "task-123")
	if err != nil {
		t.Fatalf("enqueue job: %v", err)
	}
	if err := runtimequeue.CompleteJob(store.Root, job, errors.New("semantic provider unavailable")); err != nil {
		t.Fatalf("complete failed job: %v", err)
	}

	service := detectEmbedding(store)[0]
	if service.Status != "error" {
		t.Fatalf("status = %q, want error", service.Status)
	}
	if service.Details["degraded"] != "true" {
		t.Fatalf("degraded = %q, want true", service.Details["degraded"])
	}
	if service.Details["last_error"] != "semantic provider unavailable" {
		t.Fatalf("last_error = %q", service.Details["last_error"])
	}
}

func TestDetectEmbeddingIgnoresRecoveredSemanticJobFailures(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	runtimequeue.SetTestBypass(true)
	t.Cleanup(func() { runtimequeue.SetTestBypass(false) })
	search.DefaultSemanticRuntime().Close()
	t.Cleanup(search.DefaultSemanticRuntime().Close)
	store := newStatusSemanticStore(t)
	saveStatusEmbeddingSettings(t)

	failedJob, err := runtimequeue.Enqueue(store.Root, runtimequeue.JobSemanticSearch, "failed-search")
	if err != nil {
		t.Fatalf("enqueue failed semantic job: %v", err)
	}
	if err := runtimequeue.CompleteJob(store.Root, failedJob, errors.New("semantic index unavailable")); err != nil {
		t.Fatalf("complete failed semantic job: %v", err)
	}

	recoveredJob, err := runtimequeue.Enqueue(store.Root, runtimequeue.JobSemanticSearch, "recovered-search")
	if err != nil {
		t.Fatalf("enqueue recovered semantic job: %v", err)
	}
	if err := runtimequeue.CompleteJob(store.Root, recoveredJob, nil); err != nil {
		t.Fatalf("complete recovered semantic job: %v", err)
	}

	service := detectEmbedding(store)[0]
	if service.Status != "stopped" {
		t.Fatalf("status = %q, want stopped after latest semantic job recovered", service.Status)
	}
	if service.Details["recent_failed_jobs"] != "1" {
		t.Fatalf("recent_failed_jobs = %q, want 1", service.Details["recent_failed_jobs"])
	}
	if service.Details["degraded"] != "" {
		t.Fatalf("degraded = %q, want empty after recovery", service.Details["degraded"])
	}
	if service.Details["last_error"] != "" {
		t.Fatalf("last_error = %q, want empty after recovery", service.Details["last_error"])
	}
}

func newStatusSemanticStore(t *testing.T) *storage.Store {
	t.Helper()
	root := filepath.Join(t.TempDir(), ".knowns")
	store := storage.NewStore(root)
	project := &models.Project{
		Name: "status-test",
		ID:   "status-test",
		Settings: models.ProjectSettings{
			SemanticSearch: &models.SemanticSearchSettings{
				Enabled:    true,
				Provider:   "api",
				Model:      "api-model",
				Dimensions: 384,
			},
		},
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save project config: %v", err)
	}
	return store
}

func saveStatusEmbeddingSettings(t *testing.T) {
	t.Helper()
	settings := &storage.EmbeddingSettings{
		Providers: map[string]storage.EmbeddingProvider{
			"test-provider": {
				Name:      "test-provider",
				APIBase:   "http://127.0.0.1:1/v1",
				APIKey:    "secret-for-status-test",
				Timeout:   1,
				BatchSize: 2,
			},
		},
		Models: map[string]storage.EmbeddingModel{
			"api-model": {
				Provider:   "test-provider",
				Model:      "text-embedding-test",
				Dimensions: 384,
			},
		},
	}
	if err := storage.NewEmbeddingSettingsStore().Save(settings); err != nil {
		t.Fatalf("save embedding settings: %v", err)
	}
}
