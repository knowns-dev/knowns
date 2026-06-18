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
	"github.com/howznguyen/knowns/internal/memoryreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestMemoryRoutesReviewInboxGroupingAndActions(t *testing.T) {
	store := setupMemoryRouteStore(t)
	router := chi.NewRouter()
	sse := &fakeBroadcaster{}
	(&MemoryRoutes{store: store, sse: sse}).Register(router)

	currentDecision := createMemoryRouteDecision(t, store, &models.DecisionEntry{
		ID:      "20260618-1024-use-qdrant-as-default-vector-db",
		Title:   "Use Qdrant as default vector DB",
		Status:  models.DecisionStatusAccepted,
		Sources: []string{"@doc/specs/vector"},
	})
	supersededDecision := createMemoryRouteDecision(t, store, &models.DecisionEntry{
		ID:           "20260401-0900-use-chroma-as-default-vector-db",
		Title:        "Use Chroma as default vector DB",
		Status:       models.DecisionStatusSuperseded,
		SupersededBy: []string{currentDecision.ID},
		Sources:      []string{"@doc/specs/vector"},
	})

	active := createMemoryRouteMemory(t, store, &models.MemoryEntry{
		ID:       "active1",
		Title:    "Default vector database",
		Status:   models.MemoryStatusActive,
		Content:  "Use Qdrant as the default vector database.",
		Sources:  []string{models.DecisionRef(currentDecision.ID)},
		Category: "decision",
	})
	proposed := createMemoryRouteMemory(t, store, &models.MemoryEntry{
		ID:       "proposed1",
		Title:    "Default vector database proposal",
		Status:   models.MemoryStatusProposed,
		Content:  "Use Qdrant as the default vector database.",
		Sources:  []string{"@doc/specs/vector"},
		Category: "decision",
	})
	stale := createMemoryRouteMemory(t, store, &models.MemoryEntry{
		ID:           "stale1",
		Title:        "Stale TTL",
		Status:       models.MemoryStatusActive,
		Content:      "Old operational note.",
		Sources:      []string{"@doc/specs/vector"},
		LastVerified: time.Now().UTC().Add(-72 * time.Hour),
		TTLDays:      1,
	})
	missingSource := createMemoryRouteMemory(t, store, &models.MemoryEntry{
		ID:      "missing-source1",
		Title:   "Needs source",
		Status:  models.MemoryStatusActive,
		Content: "No source yet.",
	})
	brokenSource := createMemoryRouteMemory(t, store, &models.MemoryEntry{
		ID:      "source-missing1",
		Title:   "Broken source",
		Status:  models.MemoryStatusActive,
		Content: "Source no longer exists.",
		Sources: []string{"@doc/missing"},
	})
	supersededSource := createMemoryRouteMemory(t, store, &models.MemoryEntry{
		ID:      "source-superseded1",
		Title:   "Superseded source",
		Status:  models.MemoryStatusActive,
		Content: "Historical vector database note.",
		Sources: []string{models.DecisionRef(supersededDecision.ID)},
	})

	req := httptest.NewRequest("GET", "/memories/review", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /memories/review status = %d, want 200: %s", w.Code, w.Body.String())
	}
	var inbox memoryReviewInboxResponse
	if err := json.Unmarshal(w.Body.Bytes(), &inbox); err != nil {
		t.Fatalf("decode inbox: %v\n%s", err, w.Body.String())
	}
	assertReviewReason(t, inbox, proposed.ID, memoryReviewReasonProposed)
	assertReviewReason(t, inbox, proposed.ID, memoryReviewReasonDuplicateReview)
	assertReviewReason(t, inbox, stale.ID, memoryReviewReasonStaleTTL)
	assertReviewReason(t, inbox, missingSource.ID, memoryReviewReasonMissingSource)
	assertReviewReason(t, inbox, brokenSource.ID, memoryReviewReasonSourceMissing)
	assertReviewReason(t, inbox, supersededSource.ID, memoryReviewReasonSourceDecisionSuperseded)
	if inbox.Counts[memoryReviewReasonDuplicateReview] != 1 {
		t.Fatalf("duplicate count = %d, want 1", inbox.Counts[memoryReviewReasonDuplicateReview])
	}

	actionBody, _ := json.Marshal(map[string]any{
		"action":      "repair_source",
		"source":      models.DecisionRef(supersededDecision.ID),
		"replacement": models.DecisionRef(currentDecision.ID),
	})
	req = httptest.NewRequest("POST", "/memories/"+supersededSource.ID+"/action", bytes.NewReader(actionBody))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("repair action status = %d, want 200: %s", w.Code, w.Body.String())
	}
	repaired, err := store.Memory.Get(supersededSource.ID)
	if err != nil {
		t.Fatalf("get repaired memory: %v", err)
	}
	if len(repaired.Sources) != 1 || repaired.Sources[0] != models.DecisionRef(currentDecision.ID) {
		t.Fatalf("repaired sources = %#v", repaired.Sources)
	}

	verifyBody, _ := json.Marshal(map[string]any{"action": "verify", "ids": []string{active.ID, stale.ID}})
	req = httptest.NewRequest("POST", "/memories/bulk", bytes.NewReader(verifyBody))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("bulk verify status = %d, want 200: %s", w.Code, w.Body.String())
	}
	verified, err := store.Memory.Get(stale.ID)
	if err != nil {
		t.Fatalf("get verified stale memory: %v", err)
	}
	if verified.LastVerified.IsZero() || verified.Status != models.MemoryStatusActive {
		t.Fatalf("verified memory = %+v", verified)
	}

	mixedRejectBody, _ := json.Marshal(map[string]any{"action": "reject_proposed", "ids": []string{proposed.ID, active.ID}})
	req = httptest.NewRequest("POST", "/memories/bulk", bytes.NewReader(mixedRejectBody))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("mixed reject_proposed status = %d, want 400", w.Code)
	}
	stillProposed, err := store.Memory.Get(proposed.ID)
	if err != nil {
		t.Fatalf("get proposed after failed mixed reject: %v", err)
	}
	if stillProposed.Status != models.MemoryStatusProposed {
		t.Fatalf("failed mixed reject mutated proposed status to %q", stillProposed.Status)
	}

	badBulkBody, _ := json.Marshal(map[string]any{"action": "merge_existing", "ids": []string{proposed.ID}})
	req = httptest.NewRequest("POST", "/memories/bulk", bytes.NewReader(badBulkBody))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bulk merge status = %d, want 400", w.Code)
	}
}

func TestMemoryRoutesCreateReviewOverrideAndResolve(t *testing.T) {
	store := setupMemoryRouteStore(t)
	router := chi.NewRouter()
	(&MemoryRoutes{store: store}).Register(router)

	active := createMemoryRouteMemory(t, store, &models.MemoryEntry{
		ID:       "active1",
		Title:    "Default vector database",
		Status:   models.MemoryStatusActive,
		Content:  "Use Qdrant as the default vector database.",
		Sources:  []string{"@doc/specs/vector"},
		Category: "decision",
	})

	duplicateBody, _ := json.Marshal(map[string]any{
		"title":    "Default vector database",
		"content":  "Use Qdrant as the default vector database.",
		"category": "decision",
		"sources":  []string{"@doc/specs/vector"},
	})
	req := httptest.NewRequest("POST", "/memories", bytes.NewReader(duplicateBody))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate create status = %d, want 409: %s", w.Code, w.Body.String())
	}
	var review memoryreview.Result
	if err := json.Unmarshal(w.Body.Bytes(), &review); err != nil {
		t.Fatalf("decode review: %v", err)
	}
	if review.Status != memoryreview.ResultReviewRequired || len(review.Matches) != 1 || review.Matches[0].ID != active.ID {
		t.Fatalf("review = %+v", review)
	}

	overrideBody, _ := json.Marshal(map[string]any{
		"title":      "Default vector database",
		"content":    "Use Qdrant as the default vector database.",
		"category":   "decision",
		"sources":    []string{"@doc/specs/vector"},
		"skipReview": true,
	})
	req = httptest.NewRequest("POST", "/memories", bytes.NewReader(overrideBody))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("override create status = %d, want 201: %s", w.Code, w.Body.String())
	}
	var created models.MemoryEntry
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created: %v", err)
	}
	if created.Status != models.MemoryStatusProposed || created.Metadata["reviewOverride"] != "create_anyway" {
		t.Fatalf("created override memory = %+v", created)
	}

	resolveBody, _ := json.Marshal(map[string]any{
		"resolution": "update_existing",
		"targetId":   active.ID,
		"title":      "Default vector database updated",
		"content":    "Use Qdrant as the default vector database for local semantic search.",
		"sources":    []string{"@doc/specs/vector"},
	})
	req = httptest.NewRequest("POST", "/memories/review/resolve", bytes.NewReader(resolveBody))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d, want 200: %s", w.Code, w.Body.String())
	}
	updated, err := store.Memory.Get(active.ID)
	if err != nil {
		t.Fatalf("get updated active: %v", err)
	}
	if updated.Title != "Default vector database updated" || updated.LastVerified.IsZero() {
		t.Fatalf("updated active = %+v", updated)
	}
}

func assertReviewReason(t *testing.T, inbox memoryReviewInboxResponse, id, reason string) {
	t.Helper()
	for _, item := range inbox.Items {
		if item.Memory == nil || item.Memory.ID != id {
			continue
		}
		for _, itemReason := range item.Reasons {
			if itemReason == reason {
				return
			}
		}
		t.Fatalf("memory %s reasons = %#v, want %s", id, item.Reasons, reason)
	}
	t.Fatalf("memory %s not found in review inbox", id)
}

func createMemoryRouteDecision(t *testing.T, store *storage.Store, decision *models.DecisionEntry) *models.DecisionEntry {
	t.Helper()
	if err := store.Decisions.Create(decision, storage.DecisionCreateOptions{}); err != nil {
		t.Fatalf("create decision %q: %v", decision.ID, err)
	}
	created, err := store.Decisions.Get(decision.ID)
	if err != nil {
		t.Fatalf("get decision %q: %v", decision.ID, err)
	}
	return created
}

func createMemoryRouteMemory(t *testing.T, store *storage.Store, entry *models.MemoryEntry) *models.MemoryEntry {
	t.Helper()
	if entry.Layer == "" {
		entry.Layer = models.MemoryLayerProject
	}
	if entry.CreatedAt.IsZero() {
		entry.CreatedAt = time.Now().UTC()
	}
	if entry.UpdatedAt.IsZero() {
		entry.UpdatedAt = entry.CreatedAt
	}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory %q: %v", entry.ID, err)
	}
	created, err := store.Memory.Get(entry.ID)
	if err != nil {
		t.Fatalf("get memory %q: %v", entry.ID, err)
	}
	return created
}

func setupMemoryRouteStore(t *testing.T) *storage.Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("memory-route-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return store
}
