package storage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestRenderTaskQuotesBracketPrefixedTitle(t *testing.T) {
	task := &models.Task{
		ID:        "2c9t78",
		Title:     "[memory-decision-review-ui-01] Add Memory lifecycle metadata and validation",
		Status:    "todo",
		Priority:  "medium",
		CreatedAt: time.Date(2026, 6, 18, 3, 39, 0, 0, time.UTC),
		UpdatedAt: time.Date(2026, 6, 18, 3, 41, 54, 0, time.UTC),
	}

	rendered := RenderTask(task)
	if !strings.Contains(rendered, "title: \"[memory-decision-review-ui-01] Add Memory lifecycle metadata and validation\"\n") {
		t.Fatalf("expected bracket-prefixed title to be quoted, got:\n%s", rendered)
	}

	parsed, err := ParseTaskContent(rendered)
	if err != nil {
		t.Fatalf("ParseTaskContent(RenderTask(task)) failed: %v", err)
	}
	if parsed.Title != task.Title {
		t.Fatalf("parsed title = %q, want %q", parsed.Title, task.Title)
	}
}

func TestTaskLifecycleMetadataRoundTripAndArchiveState(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)
	if err := store.Init("lifecycle-test"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	createdAt := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	completedAt := createdAt.Add(2 * time.Hour)
	archivedAt := completedAt.Add(30 * 24 * time.Hour)
	task := &models.Task{
		ID:          "life01",
		Title:       "Lifecycle round trip",
		Status:      "done",
		Priority:    "medium",
		CreatedAt:   createdAt,
		UpdatedAt:   archivedAt,
		CompletedAt: &completedAt,
		ArchivedAt:  &archivedAt,
	}
	if err := store.Tasks.Create(task); err != nil {
		t.Fatalf("Create: %v", err)
	}

	loaded, err := store.Tasks.Get(task.ID)
	if err != nil {
		t.Fatalf("Get active Task: %v", err)
	}
	if loaded.CompletedAt == nil || !loaded.CompletedAt.Equal(completedAt) {
		t.Fatalf("CompletedAt = %v, want %v", loaded.CompletedAt, completedAt)
	}
	if loaded.ArchivedAt == nil || !loaded.ArchivedAt.Equal(archivedAt) {
		t.Fatalf("ArchivedAt = %v, want %v", loaded.ArchivedAt, archivedAt)
	}
	if got := loaded.LifecycleState(); got != models.TaskLifecycleDone {
		t.Fatalf("active-directory lifecycle = %q, want done", got)
	}

	if err := store.Tasks.Archive(task.ID); err != nil {
		t.Fatalf("Archive: %v", err)
	}
	loaded, err = store.Tasks.Get(task.ID)
	if err != nil {
		t.Fatalf("Get archived Task: %v", err)
	}
	if !loaded.Archived || loaded.LifecycleState() != models.TaskLifecycleArchived {
		t.Fatalf("archived Task state = archived:%v lifecycle:%q", loaded.Archived, loaded.LifecycleState())
	}
}

func TestTaskLifecycleLegacyFrontmatterRemainsReadable(t *testing.T) {
	content := `---
id: legacy
title: Legacy Task
status: done
priority: medium
labels: []
createdAt: '2026-07-01T10:00:00.000Z'
updatedAt: '2026-07-01T11:00:00.000Z'
timeSpent: 0
---
# Legacy Task

## Description

<!-- DESCRIPTION:BEGIN -->
legacy body
<!-- DESCRIPTION:END -->
`
	task, err := ParseTaskContent(content)
	if err != nil {
		t.Fatalf("ParseTaskContent legacy Task: %v", err)
	}
	if task.CompletedAt != nil || task.ArchivedAt != nil {
		t.Fatalf("legacy timestamps = completed:%v archived:%v, want nil", task.CompletedAt, task.ArchivedAt)
	}
	if task.LifecycleState() != models.TaskLifecycleDone {
		t.Fatalf("legacy lifecycle = %q, want done", task.LifecycleState())
	}
}

func TestTaskLifecycleEmptyTimestampsRemainBackwardCompatible(t *testing.T) {
	content := `---
id: legacy-empty
title: Legacy Empty Timestamps
status: done
priority: medium
labels: []
createdAt: '2026-07-01T10:00:00.000Z'
updatedAt: '2026-07-01T11:00:00.000Z'
completedAt: ''
archivedAt: ''
timeSpent: 0
---
# Legacy Empty Timestamps
`
	task, err := ParseTaskContent(content)
	if err != nil {
		t.Fatalf("ParseTaskContent empty lifecycle timestamps: %v", err)
	}
	if task.CompletedAt != nil || task.ArchivedAt != nil {
		t.Fatalf("empty timestamps = completed:%v archived:%v, want nil", task.CompletedAt, task.ArchivedAt)
	}
}

func TestTaskLifecycleInvalidTimestampReturnsFieldError(t *testing.T) {
	base := `---
id: invalid-time
title: Invalid Timestamp
status: done
priority: medium
labels: []
createdAt: '2026-07-01T10:00:00.000Z'
updatedAt: '2026-07-01T11:00:00.000Z'
%s: 'not-a-time'
timeSpent: 0
---
# Invalid Timestamp
`
	for _, field := range []string{"completedAt", "archivedAt"} {
		t.Run(field, func(t *testing.T) {
			_, err := ParseTaskContent(fmt.Sprintf(base, field))
			if err == nil || !strings.Contains(err.Error(), "parse "+field) {
				t.Fatalf("ParseTaskContent error = %v, want field-specific %s error", err, field)
			}
		})
	}
}

func TestTaskTombstoneRoundTripReservesIDWithoutContent(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)
	deletedAt := time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	tombstone := &models.TaskTombstone{
		ID:        "gone01",
		DeletedAt: deletedAt,
		Actor:     "test-user",
		Reason:    "retention request",
	}
	if err := store.Tasks.SaveTombstone(tombstone); err != nil {
		t.Fatalf("SaveTombstone: %v", err)
	}
	if err := store.Tasks.SaveTombstone(tombstone); err != nil {
		t.Fatalf("SaveTombstone identical retry: %v", err)
	}
	got, err := store.Tasks.GetTombstone(tombstone.ID)
	if err != nil {
		t.Fatalf("GetTombstone: %v", err)
	}
	if got.ID != tombstone.ID || !got.DeletedAt.Equal(deletedAt) || got.Actor != tombstone.Actor || got.Reason != tombstone.Reason {
		t.Fatalf("tombstone = %#v, want %#v", got, tombstone)
	}

	data, err := os.ReadFile(filepath.Join(root, "tombstones", "tasks", tombstone.ID+".json"))
	if err != nil {
		t.Fatalf("ReadFile tombstone: %v", err)
	}
	var persisted map[string]any
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatalf("Unmarshal tombstone file: %v", err)
	}
	if len(persisted) != 4 {
		t.Fatalf("tombstone fields = %#v, want only id/deletedAt/actor/reason", persisted)
	}
	for _, forbidden := range []string{"title", "description", "implementationPlan", "implementationNotes", "history"} {
		if _, exists := persisted[forbidden]; exists {
			t.Fatalf("tombstone retained forbidden field %q", forbidden)
		}
	}

	reserved, err := store.Tasks.IsIDReserved(tombstone.ID)
	if err != nil || !reserved {
		t.Fatalf("IsIDReserved = %v, %v; want true, nil", reserved, err)
	}
	if err := store.Tasks.Create(&models.Task{ID: tombstone.ID, Title: "Reused", Status: "todo", Priority: "medium"}); err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Fatalf("Create reserved ID error = %v, want reserved-ID rejection", err)
	}
	conflict := *tombstone
	conflict.Reason = "different audit reason"
	if err := store.Tasks.SaveTombstone(&conflict); err == nil || !strings.Contains(err.Error(), "different audit metadata") {
		t.Fatalf("SaveTombstone conflicting retry error = %v, want immutable-audit rejection", err)
	}
	got, err = store.Tasks.GetTombstone(tombstone.ID)
	if err != nil || got.Reason != tombstone.Reason {
		t.Fatalf("conflicting retry changed tombstone: got=%#v err=%v", got, err)
	}
}

func TestTaskTombstoneConcurrentWritersPreserveOneAuditRecord(t *testing.T) {
	store := NewStore(t.TempDir())
	deletedAt := time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	tombstones := []*models.TaskTombstone{
		{ID: "race01", DeletedAt: deletedAt, Actor: "actor-a", Reason: "reason-a"},
		{ID: "race01", DeletedAt: deletedAt, Actor: "actor-b", Reason: "reason-b"},
	}

	start := make(chan struct{})
	errs := make(chan error, len(tombstones))
	var wg sync.WaitGroup
	for _, tombstone := range tombstones {
		tombstone := tombstone
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errs <- store.Tasks.SaveTombstone(tombstone)
		}()
	}
	close(start)
	wg.Wait()
	close(errs)

	successes, conflicts := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			successes++
		case strings.Contains(err.Error(), "different audit metadata"):
			conflicts++
		default:
			t.Fatalf("SaveTombstone concurrent writer: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent results = successes:%d conflicts:%d, want 1/1", successes, conflicts)
	}
	got, err := store.Tasks.GetTombstone("race01")
	if err != nil {
		t.Fatalf("GetTombstone concurrent result: %v", err)
	}
	if !sameTaskTombstone(got, tombstones[0]) && !sameTaskTombstone(got, tombstones[1]) {
		t.Fatalf("persisted tombstone = %#v, want one complete input record", got)
	}
}
