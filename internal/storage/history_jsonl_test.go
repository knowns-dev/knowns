package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestHistoryStoreDeltaCheckpointReplayAndMetadataPage(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	ctx := context.Background()
	if err := history.Append(ctx, models.HistoryRecord{
		EntityType: "task", EntityID: "abc123", Checkpoint: true,
		CheckpointPayload: map[string]any{"title": "first", "status": "todo"},
		NewHash:           taskCanonicalHash(map[string]any{"title": "first", "status": "todo"}),
	}); err != nil {
		t.Fatalf("checkpoint append: %v", err)
	}
	if err := history.Append(ctx, models.HistoryRecord{
		EntityType: "task", EntityID: "abc123", BaseHash: taskCanonicalHash(map[string]any{"title": "first", "status": "todo"}), NewHash: taskCanonicalHash(map[string]any{"title": "first", "status": "done"}),
		TaskChanges: []models.TaskChange{{Field: "status", OldValue: "todo", NewValue: "done"}},
	}); err != nil {
		t.Fatalf("delta append: %v", err)
	}
	result, err := history.Read(ctx, "task", "abc123")
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	if len(result.Records) != 2 || !result.Records[0].Checkpoint || result.Records[1].CheckpointPayload != nil {
		t.Fatalf("records = %#v, want checkpoint then delta-only", result.Records)
	}
	replayed, err := taskHistoryFromRecords("abc123", result.Records)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if got := replayed.Versions[1].Snapshot["status"]; got != "done" {
		t.Fatalf("replayed status = %v", got)
	}
	page, more, err := history.ListMetadata(ctx, "task", "abc123", 0, 1)
	if err != nil {
		t.Fatalf("metadata page: %v", err)
	}
	if len(page) != 1 || !more || page[0].CheckpointPayload != nil || page[0].TaskChanges != nil {
		t.Fatalf("metadata = %#v more=%v", page, more)
	}
}

func TestTaskHistoryReplayPreservesZeroValueDeltas(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	taskID := "zero-values"
	initial := map[string]any{
		"title":       "Task",
		"status":      "todo",
		"priority":    "medium",
		"archived":    true,
		"timeSpent":   42,
		"description": "optional",
	}
	initialHash := taskCanonicalHash(initial)
	history := store.Versions.historyStore()
	if err := history.Append(context.Background(), models.HistoryRecord{
		EntityType: "task", EntityID: taskID, Checkpoint: true,
		CheckpointPayload: initial, NewHash: initialHash,
	}); err != nil {
		t.Fatalf("checkpoint append: %v", err)
	}

	changes := []models.TaskChange{
		{Field: "archived", OldValue: true, NewValue: nil},
		{Field: "timeSpent", OldValue: 42, NewValue: nil},
		{Field: "description", OldValue: "optional", NewValue: nil},
	}
	expected := applyTaskChangesToMap(cloneMap(initial), changes)
	if err := history.Append(context.Background(), models.HistoryRecord{
		EntityType: "task", EntityID: taskID, BaseHash: initialHash,
		NewHash: taskCanonicalHash(expected), TaskChanges: changes,
	}); err != nil {
		t.Fatalf("zero-value delta append: %v", err)
	}

	replayed, err := store.Versions.GetHistory(taskID)
	if err != nil {
		t.Fatalf("GetHistory replay: %v", err)
	}
	if len(replayed.Versions) != 2 {
		t.Fatalf("replayed versions = %d, want 2", len(replayed.Versions))
	}
	snapshot := replayed.Versions[1].Snapshot
	if archived, ok := snapshot["archived"].(bool); !ok || archived {
		t.Fatalf("replayed archived = %#v, want false", snapshot["archived"])
	}
	// After JSON round-trip, numbers become float64
	if spent, ok := snapshot["timeSpent"].(float64); !ok || spent != 0 {
		t.Fatalf("replayed timeSpent = %#v, want 0", snapshot["timeSpent"])
	}
	if _, ok := snapshot["description"]; ok {
		t.Fatalf("replayed optional description = %#v, want cleared", snapshot["description"])
	}
	if replayed.Versions[1].NewHash != taskCanonicalHash(snapshot) {
		t.Fatalf("replayed NewHash = %q, reconstructed snapshot hash = %q", replayed.Versions[1].NewHash, taskCanonicalHash(snapshot))
	}
}

func TestHistoryStoreTailRecoveryAndFailClosedCorruption(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "doc", EntityID: "doc1", Checkpoint: true, CheckpointPayload: map[string]any{"path": "guide"}, NewHash: "h1"}); err != nil {
		t.Fatal(err)
	}
	path := history.EntityPath("doc", "doc1")
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(`{"entityType":"doc"`); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	result, err := history.Read(context.Background(), "doc", "doc1")
	if err != nil || len(result.Records) != 1 || !result.TailTruncated {
		t.Fatalf("tail result=%#v err=%v", result, err)
	}
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "doc", EntityID: "doc1", BaseHash: "h1", NewHash: "h2", DocChanges: []models.DocChange{{Field: "title", NewValue: "Guide"}}}); err != nil {
		t.Fatalf("append after tail recovery: %v", err)
	}
	if _, err := history.Read(context.Background(), "doc", "doc1"); err != nil {
		t.Fatalf("read recovered log: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(data), "\n")
	if len(lines) < 3 {
		t.Fatalf("expected two complete records: %q", data)
	}
	lines[0] = "not-json"
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := history.Read(context.Background(), "doc", "doc1"); !errors.Is(err, ErrHistoryCorrupt) {
		t.Fatalf("corruption err=%v", err)
	}
}

func TestHistoryStoreConcurrentEntityAppendAndInjectedFailure(t *testing.T) {
	failing := NewHistoryStore(filepath.Join(t.TempDir(), ".knowns"), HistoryStoreOptions{Append: func(*os.File, []byte) (int, error) { return 0, errors.New("injected append") }})
	err := failing.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "fail", Checkpoint: true, NewHash: "hash", CheckpointPayload: map[string]any{"title": "x"}})
	if err == nil || !strings.Contains(err.Error(), "injected append") {
		t.Fatalf("injected error=%v", err)
	}
	failedRead, readErr := failing.Read(context.Background(), "task", "fail")
	if readErr != nil || len(failedRead.Records) != 0 {
		t.Fatalf("failed append changed durable history: records=%#v err=%v", failedRead, readErr)
	}
	syncFail := NewHistoryStore(filepath.Join(t.TempDir(), ".knowns"), HistoryStoreOptions{Sync: func(*os.File) error { return errors.New("injected fsync") }})
	if err := syncFail.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "sync", Checkpoint: true, NewHash: "hash", CheckpointPayload: map[string]any{"title": "x"}}); err == nil || !strings.Contains(err.Error(), "injected fsync") {
		t.Fatalf("sync injection error=%v", err)
	}
	if result, err := syncFail.Read(context.Background(), "task", "sync"); err != nil || len(result.Records) != 0 {
		t.Fatalf("failed fsync changed history: %#v err=%v", result, err)
	}
	directoryFail := NewHistoryStore(filepath.Join(t.TempDir(), ".knowns"), HistoryStoreOptions{SyncDirectory: func(string) error { return errors.New("injected directory sync") }})
	if err := directoryFail.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "dir", Checkpoint: true, NewHash: "hash", CheckpointPayload: map[string]any{"title": "x"}}); err == nil || !strings.Contains(err.Error(), "injected directory sync") {
		t.Fatalf("directory injection error=%v", err)
	}
	if result, err := directoryFail.Read(context.Background(), "task", "dir"); err != nil || len(result.Records) != 0 {
		t.Fatalf("failed directory sync changed history: %#v err=%v", result, err)
	}
}

func TestHistoryStoreRejectsInvalidSemanticEnvelope(t *testing.T) {
	history := NewHistoryStore(filepath.Join(t.TempDir(), ".knowns"))
	invalid := []models.HistoryRecord{
		{EntityType: "task", EntityID: "invalid", NewHash: "hash"},
		{EntityType: "task", EntityID: "empty-hash", Checkpoint: true, CheckpointPayload: map[string]any{"title": "x"}},
		{EntityType: "task", EntityID: "first-delta", TaskChanges: []models.TaskChange{{Field: "title", NewValue: "x"}}, NewHash: "hash"},
	}
	for i, record := range invalid {
		if err := history.Append(context.Background(), record); !errors.Is(err, ErrHistoryCorrupt) {
			t.Fatalf("invalid envelope %d error=%v, want ErrHistoryCorrupt", i, err)
		}
	}
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "missing-base", Checkpoint: true, CheckpointPayload: map[string]any{"title": "x"}, NewHash: "h1"}); err != nil {
		t.Fatal(err)
	}
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "missing-base", TaskChanges: []models.TaskChange{{Field: "title", NewValue: "y"}}, NewHash: "h2"}); !errors.Is(err, ErrHistoryConflict) {
		t.Fatalf("missing base error=%v, want ErrHistoryConflict", err)
	}

	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "chain", Checkpoint: true, CheckpointPayload: map[string]any{"title": "x"}, NewHash: "h1"}); err != nil {
		t.Fatal(err)
	}
	path := history.EntityPath("task", "chain")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record models.HistoryRecord
	if err := json.Unmarshal(bytes.TrimSpace(data), &record); err != nil {
		t.Fatal(err)
	}
	record.EntityID = "other"
	record.RecordHash = historyRecordHash(record)
	encoded, _ := json.Marshal(record)
	if err := os.WriteFile(path, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := history.Read(context.Background(), "task", "chain"); !errors.Is(err, ErrHistoryCorrupt) {
		t.Fatalf("cross-entity read error=%v, want ErrHistoryCorrupt", err)
	}
	if _, _, err := history.ListMetadata(context.Background(), "task", "chain", 0, 10); !errors.Is(err, ErrHistoryCorrupt) {
		t.Fatalf("cross-entity metadata error=%v, want ErrHistoryCorrupt", err)
	}
}

func TestHistoryStoreSameBaseConflictAndSemanticTamper(t *testing.T) {
	history := NewHistoryStore(filepath.Join(t.TempDir(), ".knowns"))
	base := taskCanonicalHash(map[string]any{"title": "base"})
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "conflict", Checkpoint: true, NewHash: base, CheckpointPayload: map[string]any{"title": "base"}}); err != nil {
		t.Fatal(err)
	}
	var success atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "conflict", BaseHash: base, NewHash: taskCanonicalHash(map[string]any{"title": string(rune('x' + i))}), TaskChanges: []models.TaskChange{{Field: "title", NewValue: string(rune('x' + i))}}})
			if err == nil {
				success.Add(1)
			} else if !errors.Is(err, ErrHistoryConflict) {
				t.Errorf("same-base error=%v", err)
			}
		}(i)
	}
	wg.Wait()
	if success.Load() != 1 {
		t.Fatalf("same-base successes=%d want 1", success.Load())
	}
	if _, err := history.Read(context.Background(), "task", "conflict"); err != nil {
		t.Fatalf("conflict log invalid: %v", err)
	}

	result, err := history.Read(context.Background(), "task", "conflict")
	if err != nil {
		t.Fatal(err)
	}
	result.Records[1].NewHash = "tampered"
	result.Records[1].RecordHash = historyRecordHash(result.Records[1])
	if _, err := taskHistoryFromRecords("conflict", result.Records); !errors.Is(err, ErrHistoryCorrupt) {
		t.Fatalf("semantic tamper err=%v", err)
	}
}

func TestHistoryStoreInvalidSectionAndLazyMetadata(t *testing.T) {
	var decoded atomic.Int32
	history := NewHistoryStore(filepath.Join(t.TempDir(), ".knowns"), HistoryStoreOptions{PayloadDecode: func() { decoded.Add(1) }})
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "doc", EntityID: "lazy", Checkpoint: true, NewHash: hashSnapshot(map[string]any{"path": "lazy", "content": "# One\nold"}), CheckpointPayload: map[string]any{"path": "lazy", "content": "# One\nold"}}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := history.ListMetadata(context.Background(), "doc", "lazy", 0, 10); err != nil {
		t.Fatal(err)
	}
	if decoded.Load() != 0 {
		t.Fatalf("metadata decoded payloads=%d", decoded.Load())
	}
	if _, err := history.ReadRecord(context.Background(), "doc", "lazy", 1); err != nil {
		t.Fatal(err)
	}
	if decoded.Load() == 0 {
		t.Fatal("detail read did not decode payload")
	}

	invalid := models.HistoryRecord{EntityType: "doc", EntityID: "bad-section", Checkpoint: true, CheckpointPayload: map[string]any{"path": "bad-section", "content": "# One\nold"}, NewHash: hashSnapshot(map[string]any{"path": "bad-section", "content": "# One\nold"})}
	if err := history.Append(context.Background(), invalid); err != nil {
		t.Fatal(err)
	}
	result, err := history.Read(context.Background(), "doc", "bad-section")
	if err != nil {
		t.Fatal(err)
	}
	result.Records = append(result.Records, models.HistoryRecord{SchemaVersion: 1, EntityType: "doc", EntityID: "bad-section", Revision: 2, BaseHash: result.Records[0].NewHash, NewHash: result.Records[0].NewHash, ChangedScopes: []models.DocChangeScope{{Type: "section", Field: "content", Section: "Missing"}}, DocChanges: []models.DocChange{{Field: "content", NewValue: "# Missing\nnew"}}})
	if _, err := docHistoryFromRecords("bad-section", result.Records); !errors.Is(err, ErrHistoryCorrupt) {
		t.Fatalf("invalid section err=%v", err)
	}
	if _, err := history.Read(context.Background(), "../escape", "id"); err == nil {
		t.Fatal("invalid entity type accepted")
	}
}

func TestHistoryStoreReadRecordWindowDoesNotDecodeUnrelatedPayloads(t *testing.T) {
	var decoded atomic.Int32
	history := NewHistoryStore(filepath.Join(t.TempDir(), ".knowns"), HistoryStoreOptions{PayloadDecode: func() { decoded.Add(1) }})
	ctx := context.Background()
	state := map[string]any{"title": "one"}
	hash := taskCanonicalHash(state)
	if err := history.Append(ctx, models.HistoryRecord{EntityType: "task", EntityID: "window", Checkpoint: true, CheckpointPayload: state, NewHash: hash}); err != nil {
		t.Fatal(err)
	}
	for i := 2; i <= 4; i++ {
		next := map[string]any{"title": string(rune('a' + i))}
		nextHash := taskCanonicalHash(next)
		if err := history.Append(ctx, models.HistoryRecord{EntityType: "task", EntityID: "window", BaseHash: hash, NewHash: nextHash, TaskChanges: []models.TaskChange{{Field: "title", OldValue: state["title"], NewValue: next["title"]}}}); err != nil {
			t.Fatal(err)
		}
		state, hash = next, nextHash
	}
	decoded.Store(0)
	record, err := history.ReadRecord(ctx, "task", "window", 2)
	if err != nil {
		t.Fatal(err)
	}
	if record.Revision != 2 || decoded.Load() != 2 {
		t.Fatalf("detail revision=%d payloadDecodes=%d, want revision 2 and exactly checkpoint+target", record.Revision, decoded.Load())
	}
	if _, _, err := history.ListMetadata(ctx, "task", "window", 0, 2); err != nil {
		t.Fatal(err)
	}
	if decoded.Load() != 2 {
		t.Fatalf("metadata decoded unrelated payloads: %d", decoded.Load())
	}

	checkpointState := map[string]any{"title": "checkpoint"}
	checkpointHash := taskCanonicalHash(checkpointState)
	if err := history.Append(ctx, models.HistoryRecord{EntityType: "task", EntityID: "window", Checkpoint: true, BaseHash: hash, NewHash: checkpointHash, CheckpointPayload: checkpointState}); err != nil {
		t.Fatal(err)
	}
	finalState := map[string]any{"title": "final"}
	finalHash := taskCanonicalHash(finalState)
	if err := history.Append(ctx, models.HistoryRecord{EntityType: "task", EntityID: "window", BaseHash: checkpointHash, NewHash: finalHash, TaskChanges: []models.TaskChange{{Field: "title", OldValue: checkpointState["title"], NewValue: finalState["title"]}}}); err != nil {
		t.Fatal(err)
	}
	decoded.Store(0)
	if _, err := history.ReadRecord(ctx, "task", "window", 6); err != nil {
		t.Fatal(err)
	}
	if decoded.Load() != 2 {
		t.Fatalf("detail decoded %d payloads, want nearest checkpoint plus target only", decoded.Load())
	}
}

func TestHistoryStoreReadRecordWindowIgnoresUnterminatedValidJSONTail(t *testing.T) {
	history := NewHistoryStore(filepath.Join(t.TempDir(), ".knowns"))
	ctx := context.Background()
	first := map[string]any{"title": "one"}
	firstHash := taskCanonicalHash(first)
	if err := history.Append(ctx, models.HistoryRecord{EntityType: "task", EntityID: "tail-detail", Checkpoint: true, NewHash: firstHash, CheckpointPayload: first}); err != nil {
		t.Fatal(err)
	}
	second := map[string]any{"title": "two"}
	if err := history.Append(ctx, models.HistoryRecord{EntityType: "task", EntityID: "tail-detail", BaseHash: firstHash, NewHash: taskCanonicalHash(second), TaskChanges: []models.TaskChange{{Field: "title", OldValue: "one", NewValue: "two"}}}); err != nil {
		t.Fatal(err)
	}
	path := history.EntityPath("task", "tail-detail")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 || data[len(data)-1] != '\n' {
		t.Fatal("fixture history does not end in newline")
	}
	if err := os.WriteFile(path, data[:len(data)-1], 0o600); err != nil {
		t.Fatal(err)
	}
	metadata, more, err := history.ListMetadata(ctx, "task", "tail-detail", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(metadata) != 1 || more {
		t.Fatalf("metadata=%d more=%t, want one durable revision", len(metadata), more)
	}
	if _, err := history.ReadRecord(ctx, "task", "tail-detail", 2); err == nil {
		t.Fatal("unterminated tail became addressable as revision detail")
	}
}

func TestHistoryStoreTaskSnapshotRoundTrip(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	task := &models.Task{ID: "full01", Title: "Full", Status: "todo", Priority: "medium", Labels: []string{"x"}}
	err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: task.ID, Checkpoint: true, NewHash: hashSnapshot(TaskToSnapshot(task)), CheckpointPayload: TaskToSnapshot(task)})
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := history.Read(context.Background(), "task", task.ID); err != nil {
		t.Fatalf("read: %v", err)
	}
}

func TestHistoryStoreFullTaskLifecycleSnapshotRoundTrip(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	completed := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	order := 20
	task := &models.Task{ID: "full01", Title: "Full", Description: "Implements @doc/guides/lifecycle.", Status: "done", Priority: "high", Assignee: "owner", Labels: []string{"one", "two"}, Spec: "specs/lifecycle", Fulfills: []string{"AC1"}, Order: &order, CreatedAt: completed, UpdatedAt: completed, CompletedAt: &completed, TimeSpent: 42, AcceptanceCriteria: []models.AcceptanceCriterion{{Text: "kept", Completed: true}}, ImplementationPlan: "Plan with @decision/keep01", ImplementationNotes: "Notes with @memory/keep02"}
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: task.ID, Checkpoint: true, NewHash: hashSnapshot(TaskToSnapshot(task)), CheckpointPayload: TaskToSnapshot(task)}); err != nil {
		t.Fatal(err)
	}
	if _, err := history.Read(context.Background(), "task", task.ID); err != nil {
		t.Fatalf("read full: %v", err)
	}
}

func TestHistoryStoreSequenceGapFailsClosed(t *testing.T) {
	history := NewHistoryStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "gap", Checkpoint: true, CheckpointPayload: map[string]any{"title": "x"}, NewHash: "h1"}); err != nil {
		t.Fatal(err)
	}
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "gap", BaseHash: "h1", NewHash: "h2", TaskChanges: []models.TaskChange{{Field: "title", NewValue: "y"}}}); err != nil {
		t.Fatal(err)
	}
	path := history.EntityPath("task", "gap")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	var second models.HistoryRecord
	if err := json.Unmarshal([]byte(lines[1]), &second); err != nil {
		t.Fatal(err)
	}
	second.Revision = 3
	second.RecordHash = historyRecordHash(second)
	encoded, _ := json.Marshal(second)
	if err := os.WriteFile(path, []byte(lines[0]+"\n"+string(encoded)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := history.Read(context.Background(), "task", "gap"); !errors.Is(err, ErrHistoryCorrupt) {
		t.Fatalf("gap err=%v", err)
	}
}
