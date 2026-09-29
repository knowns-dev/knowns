package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/storesync"
)

// conflictFixture links a repository to a store, then makes another machine
// and this one change the same task so the runtime pauses the project.
type conflictFixture struct {
	t        *testing.T
	remote   string
	code     string
	clone    string
	other    string
	stateDir string
	svc      *storesync.Service
	clock    time.Time
}

func newConflictFixture(t *testing.T) *conflictFixture {
	t.Helper()
	remote, code := storeFixture(t)
	chdirForTest(t, code)
	if _, err := runStoreCommand(t, "link", remote); err != nil {
		t.Fatal(err)
	}
	home := os.Getenv("HOME")
	f := &conflictFixture{t: t, remote: remote, code: code, clone: filepath.Join(home, ".knowns", "stores", "team-knowledge"), stateDir: filepath.Join(home, "runtime-stores"), clock: time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)}
	prev := storeStateDir
	storeStateDir = func() string { return f.stateDir }
	t.Cleanup(func() { storeStateDir = prev })
	gitIn(t, f.clone, "config", "user.name", "Bob")
	gitIn(t, f.clone, "config", "user.email", "bob@example.com")
	f.svc = storesync.NewService(storesync.Config{
		RegistryPath: filepath.Join(home, ".knowns", "registry.json"),
		StateDir:     f.stateDir,
		Now:          func() time.Time { return f.clock },
	})

	f.write("shop-web/tasks/t.md", "title: shared\n")
	f.tick(0)
	f.tick(4 * time.Second)

	f.other = filepath.Join(t.TempDir(), "alice")
	gitIn(t, "", "clone", "--quiet", remote, f.other)
	gitIn(t, f.other, "config", "user.name", "Alice")
	gitIn(t, f.other, "config", "user.email", "alice@example.com")
	os.WriteFile(filepath.Join(f.other, "shop-web", "tasks", "t.md"), []byte("title: Alice's edit\n"), 0o644)
	gitIn(t, f.other, "commit", "--quiet", "-am", "alice")
	gitIn(t, f.other, "push", "--quiet")

	f.write("shop-web/tasks/t.md", "title: Bob's edit\n")
	f.tick(time.Second)
	state := f.tick(3 * time.Second)
	if len(state.Conflicts) != 1 {
		t.Fatalf("fixture expected a conflict, got %+v", state)
	}
	return f
}

func (f *conflictFixture) write(rel, content string) {
	path := filepath.Join(f.clone, filepath.FromSlash(rel))
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

func (f *conflictFixture) tick(d time.Duration) storesync.StoreState {
	f.clock = f.clock.Add(d)
	f.svc.Tick(context.Background())
	state, _ := f.svc.State("team-knowledge")
	return state
}

func (f *conflictFixture) remoteTask() string {
	return gitIn(f.t, f.clone, "--git-dir", f.remote, "show", "HEAD:shop-web/tasks/t.md")
}

func (f *conflictFixture) localTask() string {
	data, _ := os.ReadFile(filepath.Join(f.clone, "shop-web", "tasks", "t.md"))
	return string(data)
}

func TestStoreStatusDistinguishesHealthyConflictAndCredentialPauses(t *testing.T) {
	f := newConflictFixture(t)
	// A second store paused for credentials, written as the runtime would.
	home := os.Getenv("HOME")
	api := filepath.Join(home, "work", "shop-api")
	os.MkdirAll(api, 0o755)
	chdirForTest(t, api)
	other := filepath.Join(t.TempDir(), "remotes", "private.git")
	os.MkdirAll(other, 0o755)
	gitIn(t, other, "init", "--bare", "--quiet")
	if _, err := runStoreCommand(t, "link", other); err != nil {
		t.Fatal(err)
	}
	paused := storesync.StoreState{Store: "private", Paused: true, PauseCause: storesync.PauseCredentials, PauseMessage: `store "private" paused: push to ` + other + ` was refused for lack of a working credential`, PausedSince: time.Now().Add(-2 * time.Hour)}
	data, _ := json.Marshal(paused)
	os.WriteFile(filepath.Join(f.stateDir, "private.json"), data, 0o644)
	// A third, healthy repository in the conflicted store.
	docs := filepath.Join(home, "work", "shop-docs")
	os.MkdirAll(docs, 0o755)
	chdirForTest(t, docs)
	if _, err := runStoreCommand(t, "link", f.remote); err != nil {
		t.Fatal(err)
	}

	rows, err := collectStoreStatus(f.stateDir)
	if err != nil {
		t.Fatal(err)
	}
	byProject := map[string]storeProjectStatus{}
	for _, r := range rows {
		byProject[r.Project] = r
	}
	if r := byProject["shop-web"]; r.State != storeStatePausedConflict || !strings.Contains(r.Cause, "shop-web/tasks/t.md") || r.PausedSince.IsZero() {
		t.Fatalf("shop-web should be paused by its conflict: %+v", r)
	}
	if r := byProject["shop-api"]; r.State != storeStatePausedStore || !strings.Contains(r.Cause, "credential") || !strings.Contains(r.Cause, other) {
		t.Fatalf("shop-api should show its store paused for credentials: %+v", r)
	}
	if r := byProject["shop-docs"]; r.State != storeStateHealthy {
		t.Fatalf("shop-docs should be healthy: %+v", r)
	}

	out, err := runStoreCommand(t, "status")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"paused: conflict", "paused: store", "healthy", "credential", "knowns store resolve"} {
		if !strings.Contains(out, want) {
			t.Fatalf("status output missing %q:\n%s", want, out)
		}
	}
}

func TestStoreResolveKeepLocalPushesItAndResumes(t *testing.T) {
	f := newConflictFixture(t)
	listing, err := runStoreCommand(t, "resolve")
	if err != nil || !strings.Contains(listing, "shop-web/tasks/t.md") {
		t.Fatalf("resolve without arguments should list the conflict: %v\n%s", err, listing)
	}
	preview, err := runStoreCommand(t, "resolve", "shop-web")
	if err != nil || !strings.Contains(preview, "Alice's edit") || !strings.Contains(preview, "Bob's edit") {
		t.Fatalf("resolve <project> should show both versions: %v\n%s", err, preview)
	}
	if f.localTask() != "title: Bob's edit\n" {
		t.Fatal("previewing must not change anything")
	}

	if _, err := runStoreCommand(t, "resolve", "shop-web", "--keep", "local"); err != nil {
		t.Fatal(err)
	}
	state := f.tick(time.Second)
	state = f.tick(4 * time.Second)
	if len(state.Conflicts) != 0 {
		t.Fatalf("the conflict should be settled: %+v", state.Conflicts)
	}
	if got := f.remoteTask(); got != "title: Bob's edit\n" {
		t.Fatalf("keeping local should push the local version once sync resumes, remote has %q", got)
	}
}

func TestStoreResolveKeepRemoteRestoresIt(t *testing.T) {
	f := newConflictFixture(t)
	if _, err := runStoreCommand(t, "resolve", "shop-web", "tasks/t.md", "--keep", "remote"); err != nil {
		t.Fatal(err)
	}
	if f.localTask() != "title: Alice's edit\n" {
		t.Fatalf("keeping remote should restore it locally, got %q", f.localTask())
	}
	state := f.tick(5 * time.Second)
	if len(state.Conflicts) != 0 || f.remoteTask() != "title: Alice's edit\n" {
		t.Fatalf("remote choice should settle with the remote version kept: %+v", state)
	}
}

func TestStoreResolveKeepBothSavesTheRemoteVersion(t *testing.T) {
	f := newConflictFixture(t)
	out, err := runStoreCommand(t, "resolve", "shop-web", "--keep", "both")
	if err != nil {
		t.Fatal(err)
	}
	if f.localTask() != "title: Bob's edit\n" {
		t.Fatal("keeping both leaves the local version in place")
	}
	saved, _ := filepath.Glob(filepath.Join(f.stateDir, "team-knowledge-kept", "*", "shop-web", "tasks", "t.md"))
	if len(saved) != 1 || !strings.Contains(out, saved[0]) {
		t.Fatalf("the remote version should be saved and its path printed; saved %v, output:\n%s", saved, out)
	}
	if data, _ := os.ReadFile(saved[0]); string(data) != "title: Alice's edit\n" {
		t.Fatalf("saved copy should be the remote version, got %q", data)
	}
}

func TestStoreResolveRejectsUnknownChoiceAndPath(t *testing.T) {
	newConflictFixture(t)
	if _, err := runStoreCommand(t, "resolve", "shop-web", "--keep", "theirs"); err == nil {
		t.Fatal("an unknown --keep value must be rejected")
	}
	if _, err := runStoreCommand(t, "resolve", "shop-web", "tasks/other.md", "--keep", "local"); err == nil {
		t.Fatal("a path that is not in conflict must be rejected")
	}
}
