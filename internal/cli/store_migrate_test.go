package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// migrateFixture is a code repository that commits its .knowns/, with a task,
// a doc, a timer, local history and a personal setting.
func migrateFixture(t *testing.T) (remote, code string, taskID string) {
	t.Helper()
	remote, code = storeFixture(t)
	store := storage.NewStore(filepath.Join(code, ".knowns"))
	if err := store.Init("shop-web"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	task := &models.Task{ID: "mig-1", Title: "Carried over", Status: "todo", Priority: "medium", CreatedAt: now, UpdatedAt: now}
	if err := store.Tasks.Create(task); err != nil {
		t.Fatal(err)
	}
	if err := store.MutateDocWithHistory(context.Background(), nil, &models.Doc{Path: "arch/overview", Title: "Overview", Content: "# Overview"}, storage.DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := store.Time.Start("mig-1", "Carried over"); err != nil {
		t.Fatal(err)
	}
	if err := store.Config.Set("settings.defaultAssignee", "@bob"); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(store.Root, ".search"), 0o755)
	os.WriteFile(filepath.Join(store.Root, ".search", "index.db"), []byte("index"), 0o644)
	gitIn(t, code, "add", "-A")
	gitIn(t, code, "commit", "--quiet", "-m", "track knowledge in the repo")
	return remote, code, task.ID
}

func TestStoreLinkMigrateMovesKnowledgeWithoutTouchingTheRepository(t *testing.T) {
	remote, code, taskID := migrateFixture(t)
	chdirForTest(t, code)
	head := gitIn(t, code, "rev-parse", "HEAD")
	index := gitIn(t, code, "ls-files", "--stage")

	out, err := runStoreCommand(t, "link", remote, "--migrate")
	if err != nil {
		t.Fatalf("store link --migrate: %v\n%s", err, out)
	}

	if got := gitIn(t, code, "rev-parse", "HEAD"); got != head {
		t.Fatalf("HEAD moved: %s -> %s", head, got)
	}
	if got := gitIn(t, code, "ls-files", "--stage"); got != index {
		t.Fatal("the code repository's index changed")
	}
	if status := gitIn(t, code, "status", "--porcelain"); strings.TrimSpace(status) != "" {
		t.Fatalf("the code repository has changes after migrating:\n%s", status)
	}

	store, err := getStoreErr()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(store.Root, filepath.Join("stores", "team-knowledge", "shop-web")) {
		t.Fatalf("knowledge should now resolve to the store, got %s", store.Root)
	}
	if task, err := store.Tasks.Get(taskID); err != nil || task.Title != "Carried over" {
		t.Fatalf("task %s not readable with the same ID: %+v, %v", taskID, task, err)
	}
	if doc, err := store.Docs.Get("arch/overview"); err != nil || doc.Title != "Overview" {
		t.Fatalf("doc not readable at the same path: %+v, %v", doc, err)
	}

	for _, want := range []string{"1 task", "1 doc", ".search", "history", "time.json", "never synced", "left in place"} {
		if !strings.Contains(out, want) {
			t.Fatalf("migration report missing %q:\n%s", want, out)
		}
	}
	visible := gitIn(t, filepath.Dir(store.Root), "status", "--porcelain", "--untracked-files=all")
	for _, local := range []string{".search", "history/", "time.json"} {
		if strings.Contains(visible, local) {
			t.Fatalf("machine-local %s would sync from the store:\n%s", local, visible)
		}
	}

	var team map[string]any
	data, _ := os.ReadFile(filepath.Join(store.Root, "config.json"))
	json.Unmarshal(data, &team)
	if settings, _ := team["settings"].(map[string]any); settings["defaultAssignee"] != nil {
		t.Fatal("personal settings must leave the team config before it syncs")
	}
	if p, _ := store.Config.Load(); p == nil || p.Settings.DefaultAssignee != "@bob" {
		t.Fatalf("the personal setting must still apply after migrating: %+v", p)
	}
}

func TestStoreLinkMigrateRefusesAnOccupiedFolder(t *testing.T) {
	remote, code, _ := migrateFixture(t)
	// Someone else's repository already owns the shop-web folder.
	other := filepath.Join(os.Getenv("HOME"), "work", "elsewhere")
	os.MkdirAll(other, 0o755)
	chdirForTest(t, other)
	if _, err := runStoreCommand(t, "link", remote, "--as", "shop-web"); err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(os.Getenv("HOME"), ".knowns", "stores", "team-knowledge", "shop-web")
	before, _ := os.ReadFile(filepath.Join(folder, "config.json"))

	chdirForTest(t, code)
	_, err := runStoreCommand(t, "link", remote, "--migrate")
	if err == nil || !strings.Contains(err.Error(), "--as") {
		t.Fatalf("migrating into an occupied folder must fail and suggest --as, got %v", err)
	}
	if after, _ := os.ReadFile(filepath.Join(folder, "config.json")); string(after) != string(before) {
		t.Fatal("the occupied folder must be left untouched")
	}
}

func TestStoreLinkMigrateNeedsAnInRepoProject(t *testing.T) {
	remote, code := storeFixture(t)
	chdirForTest(t, code)
	if _, err := runStoreCommand(t, "link", remote, "--migrate"); err == nil {
		t.Fatal("--migrate without an in-repo .knowns/ must fail")
	}
}
