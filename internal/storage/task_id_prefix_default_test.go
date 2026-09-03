package storage

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
)

func setupPrefixStore(t *testing.T, projectName string) *Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init(projectName); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return store
}

func createTaskWithGeneratedID(t *testing.T, store *Store, title string) *models.Task {
	t.Helper()
	task := &models.Task{Title: title, Status: "todo", Priority: "medium"}
	if err := store.CreateTaskWithHistory(context.Background(), task, models.TaskVersion{}); err != nil {
		t.Fatalf("create %q: %v", title, err)
	}
	return task
}

// TestGeneratedTaskIDsCarryADerivedPrefix covers the case that used to produce
// a bare ID: a project that never configured defaultTaskIdPrefix. The prefix
// now comes from the project name, so a task file names the project it belongs
// to instead of being six anonymous characters.
func TestGeneratedTaskIDsCarryADerivedPrefix(t *testing.T) {
	store := setupPrefixStore(t, "Knowns")
	task := createTaskWithGeneratedID(t, store, "First task")

	if !strings.HasPrefix(task.ID, "KN-") {
		t.Errorf("generated ID = %q, want a KN- prefix derived from the project name", task.ID)
	}
	if _, err := store.Tasks.Get(task.ID); err != nil {
		t.Errorf("the generated task must be readable back: %v", err)
	}
}

// TestConfiguredPrefixWinsOverDerivation keeps derivation as a fallback rather
// than an override.
func TestConfiguredPrefixWinsOverDerivation(t *testing.T) {
	store := setupPrefixStore(t, "Knowns")
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	project.Settings.DefaultTaskIDPrefix = "OPS"
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save: %v", err)
	}

	task := createTaskWithGeneratedID(t, store, "Configured")
	if !strings.HasPrefix(task.ID, "OPS-") {
		t.Errorf("generated ID = %q, want the configured OPS- prefix", task.ID)
	}
}

// TestExistingUnprefixedIDsAreLeftAlone is the promise made when prefixes
// became automatic. An ID is an identity: rewriting one breaks every
// @task-<id> reference already pointing at it, so old tasks keep their names.
func TestExistingUnprefixedIDsAreLeftAlone(t *testing.T) {
	store := setupPrefixStore(t, "Knowns")

	legacy := &models.Task{ID: "abc123", Title: "Written before prefixes", Status: "todo", Priority: "medium"}
	if err := store.Tasks.Create(legacy); err != nil {
		t.Fatalf("Create legacy: %v", err)
	}

	createTaskWithGeneratedID(t, store, "Written after prefixes")

	loaded, err := store.Tasks.Get("abc123")
	if err != nil {
		t.Fatalf("legacy task must still resolve by its original ID: %v", err)
	}
	if loaded.ID != "abc123" {
		t.Errorf("legacy ID = %q, want it untouched", loaded.ID)
	}
}
