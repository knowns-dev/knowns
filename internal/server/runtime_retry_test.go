package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/howznguyen/knowns/internal/runtimequeue"
)

// seedDeadLetter enqueues a Qdrant reconcile job in root and drives it to
// dead-lettered through the same exported path the real scheduler uses
// (MarkJobStarted -> CompleteJob with an error), rather than reaching into
// runtimequeue's unexported state. It gives up after a generous bound so a
// regression in the retry-budget threshold fails loudly instead of hanging.
func seedDeadLetter(t *testing.T, root, entityID string) runtimequeue.Job {
	t.Helper()
	job, err := runtimequeue.EnqueueQdrantIntent(root, runtimequeue.QdrantIntent{
		EntityType: "task",
		EntityID:   entityID,
		Revision:   1,
		Operation:  "update",
		Generation: 1,
	})
	if err != nil {
		t.Fatalf("EnqueueQdrantIntent: %v", err)
	}
	for i := 0; i < 20; i++ {
		started, err := runtimequeue.MarkJobStarted(root, job.ID)
		if err != nil {
			t.Fatalf("MarkJobStarted: %v", err)
		}
		if err := runtimequeue.CompleteJob(root, started, errors.New("qdrant unreachable")); err != nil {
			t.Fatalf("CompleteJob: %v", err)
		}
		letters, err := runtimequeue.ListDeadLetters(root)
		if err != nil {
			t.Fatalf("ListDeadLetters: %v", err)
		}
		for _, letter := range letters {
			if letter.ID == job.ID {
				return letter
			}
		}
	}
	t.Fatalf("job %s never dead-lettered", job.ID)
	return runtimequeue.Job{}
}

func decodeRetryResults(t *testing.T, rec *httptest.ResponseRecorder) []runtimeRetryProjectResult {
	t.Helper()
	var body struct {
		Results []runtimeRetryProjectResult `json:"results"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, rec.Body.String())
	}
	return body.Results
}

// TestHandleRuntimeRetryScopeProjectReleasesDeadLetters pins the "project"
// scope: it must release every retained Qdrant dead letter in the named
// project via RetryDeadLetters and report the count back.
func TestHandleRuntimeRetryScopeProjectReleasesDeadLetters(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	root := "/fake/project/one"
	for i := 0; i < 3; i++ {
		seedDeadLetter(t, root, fmt.Sprintf("entity-%d", i))
	}

	s := &Server{}
	body, _ := json.Marshal(map[string]any{"scope": "project", "projectRoot": root})
	req := httptest.NewRequest(http.MethodPost, "/api/runtime/retry", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleRuntimeRetry(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	results := decodeRetryResults(t, rec)
	if len(results) != 1 || results[0].ProjectRoot != root || results[0].Released != 3 {
		t.Fatalf("results = %+v, want one result for %s with released=3", results, root)
	}

	remaining, err := runtimequeue.ListDeadLetters(root)
	if err != nil {
		t.Fatalf("ListDeadLetters: %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("remaining dead letters = %d, want 0 after release", len(remaining))
	}
}

// TestHandleRuntimeRetryScopeAllSweepsEveryRegisteredProject pins the "all"
// scope: it must enumerate every project the shared runtime knows about
// (the same registered-project scan handleRuntimePs uses) and release each
// project's dead letters independently, reporting a per-project count.
func TestHandleRuntimeRetryScopeAllSweepsEveryRegisteredProject(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	rootA := t.TempDir()
	rootB := t.TempDir()
	seedDeadLetter(t, rootA, "a-1")
	seedDeadLetter(t, rootA, "a-2")
	seedDeadLetter(t, rootB, "b-1")

	s := &Server{}
	body, _ := json.Marshal(map[string]any{"scope": "all"})
	req := httptest.NewRequest(http.MethodPost, "/api/runtime/retry", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleRuntimeRetry(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	results := decodeRetryResults(t, rec)
	released := map[string]int{}
	for _, result := range results {
		released[result.ProjectRoot] = result.Released
	}
	if released[rootA] != 2 || released[rootB] != 1 {
		t.Fatalf("released = %+v, want %s:2 %s:1", released, rootA, rootB)
	}
}

// TestHandleRuntimeRetryScopeJobsRefusesNonDeadLetter pins the "jobs" scope,
// including the case that matters most for the WebUI: one request naming
// jobs across two different projects, and a job that is not a releasable
// Qdrant dead letter being refused rather than silently skipped or crashing
// the whole request.
func TestHandleRuntimeRetryScopeJobsRefusesNonDeadLetter(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	rootA := t.TempDir()
	rootB := t.TempDir()
	jobA := seedDeadLetter(t, rootA, "cross-a")
	jobB := seedDeadLetter(t, rootB, "cross-b")
	generic, err := runtimequeue.Enqueue(rootA, runtimequeue.JobIndexDoc, "docs/example.md")
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	s := &Server{}
	body, _ := json.Marshal(map[string]any{
		"scope": "jobs",
		"jobs": []map[string]string{
			{"projectRoot": rootA, "jobId": jobA.ID},
			{"projectRoot": rootB, "jobId": jobB.ID},
			{"projectRoot": rootA, "jobId": generic.ID},
		},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/runtime/retry", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleRuntimeRetry(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	results := decodeRetryResults(t, rec)
	byRoot := make(map[string]runtimeRetryProjectResult, len(results))
	for _, result := range results {
		byRoot[result.ProjectRoot] = result
	}
	if byRoot[rootA].Released != 1 {
		t.Fatalf("rootA released = %d, want 1", byRoot[rootA].Released)
	}
	if len(byRoot[rootA].Refused) != 1 || byRoot[rootA].Refused[0].JobID != generic.ID {
		t.Fatalf("rootA refused = %+v, want one refusal for %s", byRoot[rootA].Refused, generic.ID)
	}
	if byRoot[rootB].Released != 1 {
		t.Fatalf("rootB released = %d, want 1", byRoot[rootB].Released)
	}

	remainingA, err := runtimequeue.ListDeadLetters(rootA)
	if err != nil {
		t.Fatalf("ListDeadLetters: %v", err)
	}
	if len(remainingA) != 0 {
		t.Fatalf("rootA remaining dead letters = %d, want 0", len(remainingA))
	}
}

// TestHandleRuntimeRetryRejectsUnknownScope pins the request-validation
// behavior: a missing or unrecognized scope, and a "jobs" scope with an
// empty list, are refused with 400 rather than silently doing nothing.
func TestHandleRuntimeRetryRejectsUnknownScope(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	s := &Server{}

	cases := []struct {
		name string
		body map[string]any
	}{
		{name: "missing scope", body: map[string]any{}},
		{name: "unknown scope", body: map[string]any{"scope": "bogus"}},
		{name: "project scope without projectRoot", body: map[string]any{"scope": "project"}},
		{name: "jobs scope without jobs", body: map[string]any{"scope": "jobs"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(tc.body)
			req := httptest.NewRequest(http.MethodPost, "/api/runtime/retry", bytes.NewReader(body))
			rec := httptest.NewRecorder()
			s.handleRuntimeRetry(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
			}
		})
	}
}
