package routes

import (
	"bytes"
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

func TestDocRoutesHistoryAndDiffExposeRetentionGapShape(t *testing.T) {
	store := setupDocRouteHistoryStore(t, "api-history")
	if _, err := store.Versions.ApplyDocHistoryRetention("api-history", storage.DocHistoryRetentionPolicy{
		MaxVersions: 1,
		Now:         time.Date(2026, 6, 26, 0, 0, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("apply retention: %v", err)
	}

	router := chi.NewRouter()
	(&DocRoutes{store: store, sse: &fakeBroadcaster{}}).Register(router)

	req := httptest.NewRequest(http.MethodGet, "/docs/api-history/history", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("history status = %d body=%s", w.Code, w.Body.String())
	}
	var history models.DocVersionHistory
	if err := json.Unmarshal(w.Body.Bytes(), &history); err != nil {
		t.Fatalf("unmarshal history: %v", err)
	}
	if len(history.RetentionGaps) != 1 || history.RetentionGaps[0].Reason != "max_versions" {
		t.Fatalf("history retention gaps = %#v", history.RetentionGaps)
	}
	if len(history.Versions) != 1 || !history.Versions[0].Checkpoint {
		t.Fatalf("retained versions = %#v, want checkpoint", history.Versions)
	}

	req = httptest.NewRequest(http.MethodGet, "/docs/api-history/history/v2/diff", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("diff status = %d body=%s", w.Code, w.Body.String())
	}
	var diff models.DocRevisionDiff
	if err := json.Unmarshal(w.Body.Bytes(), &diff); err != nil {
		t.Fatalf("unmarshal diff: %v", err)
	}
	if diff.RevisionID != "v2" || !diff.Checkpoint || len(diff.RetentionGaps) != 1 {
		t.Fatalf("diff = %#v, want retained checkpoint with gap", diff)
	}
	if diff.Version.AuditEventID != "" {
		t.Fatalf("diff audit event ID = %q, want missing audit link to remain optional", diff.Version.AuditEventID)
	}
}

func TestDocRoutesRestoreCreatesFollowUpRevision(t *testing.T) {
	store := setupDocRouteHistoryStore(t, "api-restore")
	broadcaster := &fakeBroadcaster{}
	router := chi.NewRouter()
	(&DocRoutes{store: store, sse: broadcaster}).Register(router)

	body, _ := json.Marshal(map[string]any{
		"revisionId": "v1",
		"mode":       "document",
	})
	req := httptest.NewRequest(http.MethodPost, "/docs/api-restore/restore", bytes.NewReader(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("restore status = %d body=%s", w.Code, w.Body.String())
	}

	var payload struct {
		Restored bool                     `json:"restored"`
		Doc      docResponse              `json:"doc"`
		History  models.DocVersionHistory `json:"history"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal restore: %v", err)
	}
	if !payload.Restored || payload.Doc.Content != "## One\nold one\n\n## Two\nsame two" {
		t.Fatalf("restore payload = restored %v content %q", payload.Restored, payload.Doc.Content)
	}
	if len(payload.History.Versions) != 3 || payload.History.Versions[2].Source != "webui" {
		t.Fatalf("restore history = %#v", payload.History.Versions)
	}
	if len(broadcaster.events) != 1 || broadcaster.events[0].Type != "docs:updated" {
		t.Fatalf("broadcasts = %#v, want docs:updated", broadcaster.events)
	}
}

func setupDocRouteHistoryStore(t *testing.T, path string) *storage.Store {
	t.Helper()
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-route-history-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	doc := &models.Doc{
		Path:      path,
		Title:     "API History",
		Content:   "## One\nold one\n\n## Two\nsame two",
		Tags:      []string{},
		CreatedAt: time.Date(2026, 6, 26, 0, 0, 0, 0, time.UTC),
		UpdatedAt: time.Date(2026, 6, 26, 0, 0, 0, 0, time.UTC),
	}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	if err := store.Versions.SaveDocRevisionWithOptions(nil, doc, storage.DocRevisionOptions{Actor: "webui", Source: "webui"}); err != nil {
		t.Fatalf("save initial revision: %v", err)
	}

	oldDoc := *doc
	doc.Content = "## One\nnew one\n\n## Two\nsame two"
	doc.UpdatedAt = doc.UpdatedAt.Add(time.Hour)
	if err := store.Docs.Update(doc); err != nil {
		t.Fatalf("update doc: %v", err)
	}
	if err := store.Versions.SaveDocRevisionWithOptions(&oldDoc, doc, storage.DocRevisionOptions{Section: "One", Actor: "webui", Source: "webui"}); err != nil {
		t.Fatalf("save update revision: %v", err)
	}
	return store
}
