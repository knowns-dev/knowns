package storage

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func newListAllStore(t *testing.T) *Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("listall-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return store
}

func createListAllTask(t *testing.T, store *Store, id, parent string) {
	t.Helper()
	if err := store.Tasks.Create(&models.Task{
		ID: id, Title: id, Status: "done", Priority: "medium", Parent: parent,
	}); err != nil {
		t.Fatalf("create %s: %v", id, err)
	}
}

func taskIDSet(tasks []*models.Task) map[string]*models.Task {
	out := make(map[string]*models.Task, len(tasks))
	for _, task := range tasks {
		out[task.ID] = task
	}
	return out
}

func TestListAllIncludesArchivedAndSkipsTombstoned(t *testing.T) {
	store := newListAllStore(t)
	createListAllTask(t, store, "keptone", "")
	createListAllTask(t, store, "arcone", "")
	createListAllTask(t, store, "tombone", "")
	for _, id := range []string{"arcone", "tombone"} {
		if err := store.Tasks.Archive(id); err != nil {
			t.Fatalf("archive %s: %v", id, err)
		}
	}
	if err := store.Tasks.SaveTombstone(&models.TaskTombstone{
		ID: "tombone", DeletedAt: time.Now().UTC(), Reason: "test",
	}); err != nil {
		t.Fatalf("save tombstone: %v", err)
	}

	active := taskIDSet(mustList(t, store.Tasks.ListActive))
	if _, ok := active["arcone"]; ok || len(active) != 1 {
		t.Fatalf("ListActive = %v, want only keptone", keys(active))
	}

	all := taskIDSet(mustList(t, store.Tasks.ListAll))
	if _, ok := all["keptone"]; !ok {
		t.Errorf("ListAll missing active task: %v", keys(all))
	}
	if _, ok := all["arcone"]; !ok {
		t.Errorf("ListAll missing archived task: %v", keys(all))
	}
	if _, ok := all["tombone"]; ok {
		t.Errorf("ListAll returned tombstoned task: %v", keys(all))
	}
}

func TestListAllLinksSubtasksAcrossArchiveBoundary(t *testing.T) {
	store := newListAllStore(t)
	createListAllTask(t, store, "parentx", "")
	createListAllTask(t, store, "childx", "parentx")
	if err := store.Tasks.Archive("childx"); err != nil {
		t.Fatalf("archive child: %v", err)
	}

	if parent := taskIDSet(mustList(t, store.Tasks.ListActive))["parentx"]; len(parent.Subtasks) != 0 {
		t.Fatalf("ListActive parent.Subtasks = %v, want empty", parent.Subtasks)
	}
	parent := taskIDSet(mustList(t, store.Tasks.ListAll))["parentx"]
	if len(parent.Subtasks) != 1 || parent.Subtasks[0] != "childx" {
		t.Fatalf("ListAll parent.Subtasks = %v, want [childx]", parent.Subtasks)
	}
}

// A doc that a task implements must keep resolving that task after it is
// archived; otherwise the doc's own links silently point at nothing.
func TestStructuralResolveKeepsArchivedImplementers(t *testing.T) {
	store := newTestStoreWithData(t)

	before, err := store.StructuralResolve("@doc/specs/auth{implements}", models.StructuralParams{Direction: "inbound"})
	if err != nil {
		t.Fatalf("resolve before archive: %v", err)
	}
	wanted := len(filterEdges(before.Edges, "implements"))
	if wanted == 0 {
		t.Fatalf("fixture produced no implements edges")
	}

	if err := store.Tasks.Archive("task02"); err != nil {
		t.Fatalf("archive task02: %v", err)
	}

	after, err := store.StructuralResolve("@doc/specs/auth{implements}", models.StructuralParams{Direction: "inbound"})
	if err != nil {
		t.Fatalf("resolve after archive: %v", err)
	}
	got := filterEdges(after.Edges, "implements")
	if len(got) != wanted {
		t.Fatalf("implements edges after archive = %d, want %d (archiving must not drop edges)", len(got), wanted)
	}
	for _, e := range got {
		if e.Target.ID == "task02" || e.Source.ID == "task02" {
			return
		}
	}
	t.Fatalf("archived task02 missing from edges: %+v", got)
}

func mustList(t *testing.T, fn func() ([]*models.Task, error)) []*models.Task {
	t.Helper()
	tasks, err := fn()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	return tasks
}

func keys(m map[string]*models.Task) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
