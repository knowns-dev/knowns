package storage

import (
	"context"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func newPrefixTestStore(t *testing.T, name, defaultPrefix string) *Store {
	t.Helper()
	store := NewStore(t.TempDir())
	if err := store.Init(name); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if defaultPrefix != "" {
		project, err := store.Config.Load()
		if err != nil {
			t.Fatalf("Load config: %v", err)
		}
		project.Settings.DefaultTaskIDPrefix = defaultPrefix
		if err := store.Config.Save(project); err != nil {
			t.Fatalf("Save config: %v", err)
		}
	}
	return store
}

// The "derived fallback" row used to be a "legacy fallback" asserting a bare
// six-character ID for an unconfigured project. Generation now always produces
// PREFIX-XXXXXX, deriving the prefix from the project name when nothing is
// configured. IDs already written without a prefix are untouched and still
// resolve; see TestExistingUnprefixedIDsAreLeftAlone.
func TestCreateTaskWithHistoryUsesCustomDefaultAndDerivedIDFormats(t *testing.T) {
	tests := []struct {
		name          string
		defaultPrefix string
		customPrefix  string
		pattern       string
	}{
		{name: "derived fallback", pattern: `^CTIT-[0-9A-HJKMNP-TV-Z]{6}$`},
		{name: "project default", defaultPrefix: "KN", pattern: `^KN-[0-9A-HJKMNP-TV-Z]{6}$`},
		{name: "custom override", defaultPrefix: "KN", customPrefix: "fr", pattern: `^FR-[0-9A-HJKMNP-TV-Z]{6}$`},
		// A custom prefix equal to the default must still be honored explicitly.
		{name: "custom equals default", defaultPrefix: "KN", customPrefix: "KN", pattern: `^KN-[0-9A-HJKMNP-TV-Z]{6}$`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newPrefixTestStore(t, "create-task-id-test", tt.defaultPrefix)
			task := &models.Task{Title: "Task ID format", Status: "todo", Priority: "medium"}
			if err := store.CreateTaskWithHistoryPrefixed(context.Background(), task, models.TaskVersion{}, tt.customPrefix); err != nil {
				t.Fatalf("CreateTaskWithHistoryPrefixed: %v", err)
			}
			if !regexp.MustCompile(tt.pattern).MatchString(task.ID) {
				t.Fatalf("task ID = %q, want pattern %s", task.ID, tt.pattern)
			}
			if _, err := store.Tasks.Get(task.ID); err != nil {
				t.Fatalf("Get created task %q: %v", task.ID, err)
			}
		})
	}
}

// A one-off prefix must not be written back into project settings.
func TestCustomPrefixDoesNotMutateProjectDefault(t *testing.T) {
	store := newPrefixTestStore(t, "prefix-isolation", "KN")
	task := &models.Task{Title: "One-off prefix", Status: "todo", Priority: "medium"}
	if err := store.CreateTaskWithHistoryPrefixed(context.Background(), task, models.TaskVersion{}, "LAB"); err != nil {
		t.Fatalf("CreateTaskWithHistoryPrefixed: %v", err)
	}
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load config: %v", err)
	}
	if project.Settings.DefaultTaskIDPrefix != "KN" {
		t.Fatalf("custom prefix mutated project default to %q, want KN", project.Settings.DefaultTaskIDPrefix)
	}
}

func TestCreateTaskWithHistoryRejectsInvalidPrefix(t *testing.T) {
	store := newPrefixTestStore(t, "prefix-invalid", "")
	task := &models.Task{Title: "Invalid prefix", Status: "todo", Priority: "medium"}
	if err := store.CreateTaskWithHistoryPrefixed(context.Background(), task, models.TaskVersion{}, "1bad"); err == nil {
		t.Fatal("CreateTaskWithHistoryPrefixed with invalid prefix succeeded, want error")
	}
	if task.ID != "" {
		t.Fatalf("rejected create assigned an ID %q", task.ID)
	}
	tasks, err := store.Tasks.ListActive()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("rejected create wrote %d tasks, want 0", len(tasks))
	}
}

// A caller-supplied ID must be preserved so import and migration paths keep
// working after prefixes are enabled.
func TestCreateTaskWithHistoryPreservesExplicitID(t *testing.T) {
	store := newPrefixTestStore(t, "prefix-explicit-id", "KN")
	task := &models.Task{ID: "legacy1", Title: "Imported", Status: "todo", Priority: "medium"}
	if err := store.CreateTaskWithHistoryPrefixed(context.Background(), task, models.TaskVersion{}, "LAB"); err != nil {
		t.Fatalf("CreateTaskWithHistoryPrefixed: %v", err)
	}
	if task.ID != "legacy1" {
		t.Fatalf("explicit task ID changed to %q, want legacy1", task.ID)
	}
}

// The version snapshot is built by callers before the ID exists, so an
// allocated ID must be reflected in the persisted history record.
func TestAllocatedIDIsRecordedInHistorySnapshot(t *testing.T) {
	store := newPrefixTestStore(t, "prefix-history", "KN")
	task := &models.Task{Title: "History snapshot", Status: "todo", Priority: "medium"}
	staleSnapshot := TaskToSnapshot(task) // captured while task.ID is still empty
	if err := store.CreateTaskWithHistoryPrefixed(context.Background(), task, models.TaskVersion{
		Snapshot: staleSnapshot,
	}, ""); err != nil {
		t.Fatalf("CreateTaskWithHistoryPrefixed: %v", err)
	}

	history, err := store.Versions.GetHistory(task.ID)
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	if history == nil || len(history.Versions) == 0 {
		t.Fatal("no history recorded for created task")
	}
	got, _ := history.Versions[0].Snapshot["id"].(string)
	if got != task.ID {
		t.Fatalf("history snapshot id = %q, want %q", got, task.ID)
	}
}

func TestAllocateTaskIDSkipsExistingAndReservedIDs(t *testing.T) {
	store := newPrefixTestStore(t, "prefix-collision", "")
	existing := &models.Task{ID: "KN-000001", Title: "Existing", Status: "todo", Priority: "medium"}
	if err := store.Tasks.Create(existing); err != nil {
		t.Fatalf("Create existing task: %v", err)
	}
	if err := store.Tasks.SaveTombstone(&models.TaskTombstone{
		ID:        "KN-000002",
		DeletedAt: time.Now().UTC(),
		Reason:    "test reservation",
	}); err != nil {
		t.Fatalf("SaveTombstone: %v", err)
	}

	// The first candidate is an existing Task and the second is tombstoned, so
	// allocation must retry through to the third.
	candidates := []string{"KN-000001", "KN-000002", "KN-000003"}
	index := 0
	var got string
	err := store.Tasks.withLifecycleLock(func() error {
		var err error
		got, err = store.Tasks.allocateTaskIDWith("KN", func() (string, error) {
			id := candidates[index]
			index++
			return id, nil
		})
		return err
	})
	if err != nil {
		t.Fatalf("allocateTaskIDWith: %v", err)
	}
	if got != "KN-000003" {
		t.Fatalf("allocated ID = %q, want KN-000003", got)
	}
}

func TestAllocateTaskIDFailsAfterExhaustingAttempts(t *testing.T) {
	store := newPrefixTestStore(t, "prefix-exhausted", "")
	taken := &models.Task{ID: "KN-AAAAAA", Title: "Taken", Status: "todo", Priority: "medium"}
	if err := store.Tasks.Create(taken); err != nil {
		t.Fatalf("Create task: %v", err)
	}

	attempts := 0
	err := store.Tasks.withLifecycleLock(func() error {
		_, err := store.Tasks.allocateTaskIDWith("KN", func() (string, error) {
			attempts++
			return "KN-AAAAAA", nil
		})
		return err
	})
	if err == nil {
		t.Fatal("allocateTaskIDWith succeeded on a permanently colliding ID, want error")
	}
	if attempts != maxTaskIDGenerationAttempts {
		t.Fatalf("generator called %d times, want %d", attempts, maxTaskIDGenerationAttempts)
	}
}

func TestCreateTaskAllocatesUniquePrefixedIDsConcurrently(t *testing.T) {
	store := newPrefixTestStore(t, "concurrent-task-id-test", "KN")

	const taskCount = 40
	ids := make(chan string, taskCount)
	errs := make(chan error, taskCount)
	var wg sync.WaitGroup
	for range taskCount {
		wg.Add(1)
		go func() {
			defer wg.Done()
			task := &models.Task{Title: "Concurrent Task", Status: "todo", Priority: "medium"}
			if err := store.CreateTaskWithHistory(context.Background(), task, models.TaskVersion{}); err != nil {
				errs <- err
				return
			}
			ids <- task.ID
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)

	for err := range errs {
		t.Errorf("CreateTaskWithHistory: %v", err)
	}
	seen := make(map[string]bool, taskCount)
	for id := range ids {
		if seen[id] {
			t.Errorf("duplicate generated task ID %q", id)
		}
		seen[id] = true
	}
	if len(seen) != taskCount {
		t.Fatalf("created %d unique task IDs, want %d", len(seen), taskCount)
	}
}
