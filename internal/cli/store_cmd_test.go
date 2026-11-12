package cli

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/registry"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/testutil"
)

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
		"GIT_CONFIG_NOSYSTEM=1",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

// storeFixture isolates HOME, creates a bare repository to act as the store
// remote, and a clean code repository with one commit. It returns the remote
// path and the code repository path.
func storeFixture(t *testing.T) (string, string) {
	t.Helper()
	requireGit(t)
	home := t.TempDir()
	testutil.SetHome(t, home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))

	remote := filepath.Join(home, "remotes", "team-knowledge.git")
	if err := os.MkdirAll(remote, 0o755); err != nil {
		t.Fatal(err)
	}
	gitIn(t, remote, "init", "--bare", "--quiet")

	code := filepath.Join(home, "work", "shop-web")
	if err := os.MkdirAll(code, 0o755); err != nil {
		t.Fatal(err)
	}
	gitIn(t, code, "init", "--quiet")
	os.WriteFile(filepath.Join(code, "main.go"), []byte("package main\n"), 0o644)
	gitIn(t, code, "add", "main.go")
	gitIn(t, code, "commit", "--quiet", "-m", "init")
	return remote, code
}

func runStoreCommand(t *testing.T, args ...string) (string, error) {
	t.Helper()
	t.Cleanup(func() {
		rootCmd.SetArgs(nil)
		_ = storeLinkCmd.Flags().Set("as", "")
		_ = storeLinkCmd.Flags().Set("store", "")
		_ = storeLinkCmd.Flags().Set("migrate", "false")
		_ = storeResolveCmd.Flags().Set("keep", "")
		_ = storeResolveCmd.Flags().Set("store", "")
	})
	var callErr error
	rootCmd.SetArgs(append([]string{"store"}, args...))
	out := captureStdout(t, func() { callErr = rootCmd.ExecuteContext(context.Background()) })
	return out, callErr
}

func TestStoreLinkLeavesCodeRepositoryUntouchedAndResolvesThroughStore(t *testing.T) {
	remote, code := storeFixture(t)
	chdirForTest(t, code)
	exclude, _ := os.ReadFile(filepath.Join(code, ".git", "info", "exclude"))

	out, err := runStoreCommand(t, "link", remote)
	if err != nil {
		t.Fatalf("store link: %v\n%s", err, out)
	}

	if status := gitIn(t, code, "status", "--porcelain", "--ignored"); strings.TrimSpace(status) != "" {
		t.Fatalf("code repository changed after store link:\n%s", status)
	}
	if _, err := os.Stat(filepath.Join(code, ".knowns")); !os.IsNotExist(err) {
		t.Fatalf("store link must not create .knowns/ in the code repository")
	}
	if after, _ := os.ReadFile(filepath.Join(code, ".git", "info", "exclude")); string(after) != string(exclude) {
		t.Fatalf(".git/info/exclude changed:\nbefore %q\nafter  %q", exclude, after)
	}

	home := os.Getenv("HOME")
	folder := filepath.Join(home, ".knowns", "stores", "team-knowledge", "shop-web")
	if _, err := os.Stat(filepath.Join(folder, "config.json")); err != nil {
		t.Fatalf("project folder not initialized in the store: %v", err)
	}
	loc, err := storage.LocateProject(code)
	if err != nil || loc.Store == nil || loc.Store.Remote != remote {
		t.Fatalf("project does not resolve through the store: %+v, %v", loc, err)
	}

	// Knowledge written through the resolved store lands in the store.
	store, err := getStoreErr()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.Tasks.Create(&models.Task{ID: "t1", Title: "Linked", Status: "todo", Priority: "medium", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if matches, _ := filepath.Glob(filepath.Join(folder, "tasks", "*.md")); len(matches) != 1 {
		t.Fatalf("task should be written in the store folder, found %v", matches)
	}
	if status := gitIn(t, code, "status", "--porcelain", "--ignored"); strings.TrimSpace(status) != "" {
		t.Fatalf("writing knowledge touched the code repository:\n%s", status)
	}
}

func TestStoreLinkAdoptsExistingFolderAndHonoursAs(t *testing.T) {
	remote, code := storeFixture(t)
	chdirForTest(t, code)
	if _, err := runStoreCommand(t, "link", remote, "--as", "web"); err != nil {
		t.Fatal(err)
	}
	home := os.Getenv("HOME")
	folder := filepath.Join(home, ".knowns", "stores", "team-knowledge", "web")
	os.WriteFile(filepath.Join(folder, "marker"), []byte("keep"), 0o644)

	// A second repository linking to the same folder adopts it.
	other := filepath.Join(home, "work", "shop-web-2")
	os.MkdirAll(other, 0o755)
	chdirForTest(t, other)
	out, err := runStoreCommand(t, "link", remote, "--as", "web")
	if err != nil {
		t.Fatalf("second link: %v", err)
	}
	if !strings.Contains(out, "Adopted") {
		t.Fatalf("expected the folder to be adopted, output %q", out)
	}
	if data, _ := os.ReadFile(filepath.Join(folder, "marker")); string(data) != "keep" {
		t.Fatal("adopting must not reinitialize the folder")
	}
}

func TestStoreUnlinkKeepsCloneAndRepository(t *testing.T) {
	remote, code := storeFixture(t)
	chdirForTest(t, code)
	if _, err := runStoreCommand(t, "link", remote); err != nil {
		t.Fatal(err)
	}
	if _, err := runStoreCommand(t, "unlink"); err != nil {
		t.Fatalf("store unlink: %v", err)
	}

	home := os.Getenv("HOME")
	if _, err := os.Stat(filepath.Join(home, ".knowns", "stores", "team-knowledge", "shop-web", "config.json")); err != nil {
		t.Fatalf("unlink must leave the store clone intact: %v", err)
	}
	if status := gitIn(t, code, "status", "--porcelain", "--ignored"); strings.TrimSpace(status) != "" {
		t.Fatalf("unlink changed the code repository:\n%s", status)
	}
	reg := registry.NewRegistryWithPath(filepath.Join(home, ".knowns", "registry.json"))
	reg.Load()
	if p := reg.FindStoreLinked(code); p != nil {
		t.Fatalf("mapping still present after unlink: %+v", p)
	}
	if _, err := storage.LocateProject(code); err == nil {
		t.Fatal("after unlink the repository has no project")
	}
}

func TestStoreLinkFailsFastOnUnreachableRemoteWithoutPrompting(t *testing.T) {
	_, code := storeFixture(t)
	chdirForTest(t, code)
	missing := filepath.Join(os.Getenv("HOME"), "remotes", "does-not-exist.git")

	start := time.Now()
	_, err := runStoreCommand(t, "link", missing)
	if err == nil {
		t.Fatal("expected an error for an unreachable remote")
	}
	if !strings.Contains(err.Error(), missing) {
		t.Fatalf("error must name the remote, got %q", err)
	}
	if time.Since(start) > 30*time.Second {
		t.Fatalf("store link took %s; it must fail fast", time.Since(start))
	}
	if _, statErr := os.Stat(filepath.Join(os.Getenv("HOME"), ".knowns", "stores", "does-not-exist")); !os.IsNotExist(statErr) {
		t.Fatal("a failed clone must not leave a partial store directory")
	}
	if status := gitIn(t, code, "status", "--porcelain", "--ignored"); strings.TrimSpace(status) != "" {
		t.Fatalf("failed link changed the code repository:\n%s", status)
	}
}

func TestStoreLinkRefusesCloneOfAnotherRemote(t *testing.T) {
	remote, code := storeFixture(t)
	chdirForTest(t, code)
	if _, err := runStoreCommand(t, "link", remote); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(os.Getenv("HOME"), "remotes", "elsewhere", "team-knowledge.git")
	os.MkdirAll(other, 0o755)
	gitIn(t, other, "init", "--bare", "--quiet")

	_, err := runStoreCommand(t, "link", other)
	if err == nil || !strings.Contains(err.Error(), "--store") {
		t.Fatalf("linking a different remote under the same store name must fail and suggest --store, got %v", err)
	}
}

func TestStoreNameFromRemote(t *testing.T) {
	for remote, want := range map[string]string{
		"git@github.com:knowns-dev/knowns-tasks.git": "knowns-tasks",
		"https://gitlab.com/team/knowledge":          "knowledge",
		"https://gitlab.com/team/knowledge/":         "knowledge",
		"/srv/git/team.git":                          "team",
		`C:\srv\git\team.git`:                        "team",
		`C:\srv\git\team\`:                           "team",
	} {
		if got := storeNameFromRemote(remote); got != want {
			t.Fatalf("storeNameFromRemote(%q) = %q, want %q", remote, got, want)
		}
	}
}

func TestStoreCloneExposesOnlyShareableKnowledgeToGit(t *testing.T) {
	remote, code := storeFixture(t)
	chdirForTest(t, code)
	if _, err := runStoreCommand(t, "link", remote); err != nil {
		t.Fatal(err)
	}
	home := os.Getenv("HOME")
	clone := filepath.Join(home, ".knowns", "stores", "team-knowledge")

	store, err := getStoreErr()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.Tasks.Create(&models.Task{ID: "t1", Title: "Shared", Status: "todo", Priority: "medium", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := store.Time.Start("t1", "Shared"); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(store.Root, ".server-port"), []byte("3001"), 0o644)
	os.MkdirAll(filepath.Join(store.Root, "history", "state"), 0o755)
	os.WriteFile(filepath.Join(store.Root, "history", "state", "manifest.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(store.Root, ".search", "index.db"), []byte("x"), 0o644)
	global := &models.MemoryEntry{Title: "Personal", Content: "mine only", Layer: models.MemoryLayerGlobal, Category: "preference"}
	if err := store.Memory.Create(global); err != nil {
		t.Fatalf("global memory: %v", err)
	}

	visible := gitIn(t, clone, "status", "--porcelain", "--untracked-files=all")
	for _, banned := range []string{".search", "history/", "time.json", "time-entries.json", "workspaces.json", "chats.json", ".server-port"} {
		if strings.Contains(visible, banned) {
			t.Fatalf("git sees machine-local %q in the store clone:\n%s", banned, visible)
		}
	}
	if !strings.Contains(visible, "shop-web/tasks/") || !strings.Contains(visible, "shop-web/config.json") {
		t.Fatalf("shareable knowledge should be visible to git:\n%s", visible)
	}
	_ = filepath.WalkDir(clone, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if data, _ := os.ReadFile(path); strings.Contains(string(data), "mine only") {
			t.Fatalf("global memory content reached the store clone at %s", path)
		}
		return nil
	})
	if matches, _ := filepath.Glob(filepath.Join(home, ".knowns", "memory", "*")); len(matches) == 0 {
		t.Fatal("global memory should be written under ~/.knowns/memory")
	}
}
