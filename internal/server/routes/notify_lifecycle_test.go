package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestNotifyTaskBroadcastIncludesDerivedLifecycleState(t *testing.T) {
	now := time.Now().UTC()
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Tasks.Create(&models.Task{
		ID:        "notify1",
		Title:     "notify task",
		Status:    "done",
		Priority:  "medium",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}

	broadcaster := &fakeBroadcaster{}
	router := chi.NewRouter()
	(&NotifyRoutes{store: store, sse: broadcaster}).Register(router)

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/notify/task/notify1", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("notify status=%d body=%s", w.Code, w.Body.String())
	}
	if len(broadcaster.events) != 1 {
		t.Fatalf("events=%d want 1", len(broadcaster.events))
	}
	if broadcaster.events[0].Type != "tasks:updated" {
		t.Fatalf("event type=%q want tasks:updated", broadcaster.events[0].Type)
	}

	payload, ok := broadcaster.events[0].Data.(map[string]interface{})
	if !ok {
		t.Fatalf("payload type %T", broadcaster.events[0].Data)
	}
	encoded, err := json.Marshal(payload["task"])
	if err != nil {
		t.Fatalf("marshal task payload: %v", err)
	}
	var task struct {
		ID             string                    `json:"id"`
		LifecycleState models.TaskLifecycleState `json:"lifecycleState"`
	}
	if err := json.Unmarshal(encoded, &task); err != nil {
		t.Fatalf("decode task payload %s: %v", string(encoded), err)
	}
	if task.ID != "notify1" || task.LifecycleState != models.TaskLifecycleDone {
		t.Fatalf("task payload id=%q lifecycleState=%q", task.ID, task.LifecycleState)
	}
}
