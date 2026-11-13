package storesync

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/registry"
	"github.com/howznguyen/knowns/internal/testutil"
)

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
}

// isolateGit keeps the developer's Git configuration (credential helpers,
// identities) out of the test.
func isolateGit(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	testutil.SetHome(t, home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	return home
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
	return string(out)
}

// machine is one computer: its own registry, stores directory and code repos.
type machine struct {
	t        *testing.T
	root     string
	registry string
	clock    time.Time
	svc      *Service
}

func newMachine(t *testing.T, name string) *machine {
	t.Helper()
	root := filepath.Join(t.TempDir(), name)
	m := &machine{t: t, root: root, registry: filepath.Join(root, "registry.json"), clock: time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)}
	m.svc = NewService(Config{
		RegistryPath:  m.registry,
		StateDir:      filepath.Join(root, "runtime", "stores"),
		Debounce:      3 * time.Second,
		FetchInterval: 30 * time.Second,
		Now:           func() time.Time { return m.clock },
	})
	return m
}

func (m *machine) clone() string { return filepath.Join(m.root, "stores", "team") }

// link clones the remote (once) and links a code repository to a project
// folder, the way `knowns store link` does.
func (m *machine) link(remote, project string) string {
	m.t.Helper()
	if _, err := os.Stat(m.clone()); err != nil {
		os.MkdirAll(filepath.Dir(m.clone()), 0o755)
		git(m.t, "", "clone", "--quiet", remote, m.clone())
		git(m.t, m.clone(), "config", "user.name", m.t.Name()+"-"+filepath.Base(m.root))
		git(m.t, m.clone(), "config", "user.email", filepath.Base(m.root)+"@example.com")
	}
	folder := filepath.Join(m.clone(), project)
	os.MkdirAll(folder, 0o755)
	if _, err := os.Stat(filepath.Join(folder, "config.json")); err != nil {
		os.WriteFile(filepath.Join(folder, "config.json"), []byte(`{"name":"`+project+`"}`+"\n"), 0o644)
	}
	code := filepath.Join(m.root, "work", project)
	os.MkdirAll(code, 0o755)
	reg := registry.NewRegistryWithPath(m.registry)
	reg.Load()
	if _, err := reg.AddStoreLinked(code, registry.StoreMapping{Name: "team", Project: project, Remote: remote}); err != nil {
		m.t.Fatal(err)
	}
	return folder
}

func (m *machine) write(project, rel, content string) {
	m.t.Helper()
	path := filepath.Join(m.clone(), project, rel)
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		m.t.Fatal(err)
	}
}

// tickAfter advances the machine clock and runs one sync pass.
func (m *machine) tickAfter(d time.Duration) StoreState {
	m.t.Helper()
	m.clock = m.clock.Add(d)
	m.svc.Tick(context.Background())
	state, _ := m.svc.State("team")
	return state
}

func bareRemote(t *testing.T) string {
	t.Helper()
	remote := filepath.Join(t.TempDir(), "team.git")
	os.MkdirAll(remote, 0o755)
	git(t, remote, "init", "--bare", "--quiet")
	return remote
}

func remoteHas(t *testing.T, remote, path string) bool {
	t.Helper()
	cmd := exec.Command("git", "--git-dir", remote, "log", "--all", "--format=%H", "--", path)
	out, err := cmd.Output()
	return err == nil && strings.TrimSpace(string(out)) != ""
}

// publish makes machine a push its current tree so another machine can clone
// a non-empty store.
func publish(t *testing.T, a *machine) {
	t.Helper()
	a.tickAfter(0)
	state := a.tickAfter(4 * time.Second)
	if state.LastPush.IsZero() {
		t.Fatalf("initial push did not happen: %+v", state)
	}
}

func TestLocalChangeReachesAnotherMachineWithinOneMinute(t *testing.T) {
	requireGit(t)
	isolateGit(t)
	remote := bareRemote(t)
	a := newMachine(t, "a")
	a.link(remote, "shop-web")
	publish(t, a)
	b := newMachine(t, "b")
	b.link(remote, "shop-web")
	b.tickAfter(0)

	start := a.clock
	a.write("shop-web", "tasks/t1.md", "# Task from A\n")
	a.tickAfter(time.Second) // change noticed, debounce starts
	if s := a.tickAfter(3 * time.Second); s.LastPush.IsZero() || !remoteHas(t, remote, "shop-web/tasks/t1.md") {
		t.Fatalf("A should commit after the debounce and push: %+v", s)
	}

	b.clock = a.clock
	var elapsed time.Duration
	for elapsed = 0; elapsed <= 60*time.Second; elapsed += 5 * time.Second {
		b.tickAfter(5 * time.Second)
		if _, err := os.Stat(filepath.Join(b.clone(), "shop-web", "tasks", "t1.md")); err == nil {
			break
		}
	}
	if total := b.clock.Sub(start); total > 60*time.Second {
		t.Fatalf("task took %s of sync time to reach B, want within 60s", total)
	}
	if _, err := os.Stat(filepath.Join(b.clone(), "shop-web", "tasks", "t1.md")); err != nil {
		t.Fatal("task never reached machine B")
	}
}

func TestCommitsQueueOfflineAndPushOnReconnect(t *testing.T) {
	requireGit(t)
	isolateGit(t)
	remote := bareRemote(t)
	a := newMachine(t, "a")
	a.link(remote, "shop-web")
	publish(t, a)

	offline := remote + ".offline"
	if err := os.Rename(remote, offline); err != nil {
		t.Fatal(err)
	}
	a.write("shop-web", "tasks/t2.md", "# Written offline\n")
	a.tickAfter(time.Second)
	state := a.tickAfter(4 * time.Second)
	if state.LastCommit.IsZero() || state.QueuedCommits != 1 || state.Paused {
		t.Fatalf("offline: expected one queued commit and no pause, got %+v", state)
	}
	if state.LastError == "" {
		t.Fatal("offline push failure should be recorded for status")
	}

	if err := os.Rename(offline, remote); err != nil {
		t.Fatal(err)
	}
	state = a.tickAfter(31 * time.Second)
	if state.QueuedCommits != 0 || !remoteHas(t, remote, "shop-web/tasks/t2.md") {
		t.Fatalf("after reconnect the queued commit should reach the remote: %+v", state)
	}
}

func TestMissingCredentialPausesTheStoreWithoutPrompting(t *testing.T) {
	requireGit(t)
	isolateGit(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", `Basic realm="knowledge"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	remote := srv.URL + "/team/knowledge.git"

	m := newMachine(t, "a")
	os.MkdirAll(m.clone(), 0o755)
	git(t, m.clone(), "init", "--quiet")
	git(t, m.clone(), "remote", "add", "origin", remote)
	git(t, m.clone(), "config", "user.name", "a")
	git(t, m.clone(), "config", "user.email", "a@example.com")
	m.link(remote, "shop-web")

	started := time.Now()
	state := m.tickAfter(0)
	if time.Since(started) > 30*time.Second {
		t.Fatalf("a refused credential must fail fast, took %s", time.Since(started))
	}
	if !state.Paused || state.PauseCause != PauseCredentials {
		t.Fatalf("store should pause for credentials: %+v", state)
	}
	if !strings.Contains(state.PauseMessage, remote) {
		t.Fatalf("pause message must name the remote: %q", state.PauseMessage)
	}
	persisted, err := LoadState(filepath.Join(m.root, "runtime", "stores"), "team")
	if err != nil || !persisted.Paused {
		t.Fatalf("pause must be persisted for store status: %+v, %v", persisted, err)
	}
}

func TestOneFetchUpdatesEveryProjectInTheStore(t *testing.T) {
	requireGit(t)
	isolateGit(t)
	remote := bareRemote(t)
	a := newMachine(t, "a")
	projects := []string{"shop-web", "shop-api", "shop-app"}
	for _, p := range projects {
		a.link(remote, p)
	}
	publish(t, a)
	b := newMachine(t, "b")
	for _, p := range projects {
		b.link(remote, p)
	}
	b.tickAfter(0)

	for _, p := range projects {
		a.write(p, "docs/note.md", "# from A "+p+"\n")
	}
	a.tickAfter(time.Second)
	a.tickAfter(3 * time.Second)

	if found := discoverStores(b.registry); len(found) != 1 || len(found[0].Projects) != 3 {
		t.Fatalf("three projects in one store must be one store to fetch, got %+v", found)
	}
	b.tickAfter(31 * time.Second) // exactly one fetch is due
	for _, p := range projects {
		if _, err := os.Stat(filepath.Join(b.clone(), p, "docs", "note.md")); err != nil {
			t.Fatalf("%s not updated by the single fetch: %v", p, err)
		}
	}
}

func TestDebounceWaitsForChangesToSettle(t *testing.T) {
	requireGit(t)
	isolateGit(t)
	remote := bareRemote(t)
	a := newMachine(t, "a")
	a.link(remote, "shop-web")
	publish(t, a)

	a.write("shop-web", "tasks/t3.md", "v1\n")
	a.tickAfter(time.Second)
	a.write("shop-web", "tasks/t3.md", "v2 longer\n")
	if s := a.tickAfter(2 * time.Second); remoteHas(t, remote, "shop-web/tasks/t3.md") {
		t.Fatalf("a file still changing must not be committed yet: %+v", s)
	}
	a.tickAfter(3 * time.Second)
	if !remoteHas(t, remote, "shop-web/tasks/t3.md") {
		t.Fatal("once quiet for the debounce, the change must be committed and pushed")
	}
}

func TestClassifyFailure(t *testing.T) {
	for msg, want := range map[string]FailureClass{
		"fatal: could not read Username for 'https://x': terminal prompts disabled": FailureCredential,
		"git@github.com: Permission denied (publickey).":                            FailureCredential,
		" ! [rejected]        HEAD -> main (fetch first)":                           FailureRejected,
		"fatal: unable to access 'https://x/': Could not resolve host: x":           FailureUnreachable,
		"fatal: '/tmp/gone.git' does not appear to be a git repository":             FailureUnreachable,
	} {
		if got := ClassifyFailure(msg); got != want {
			t.Fatalf("ClassifyFailure(%q) = %v, want %v", msg, got, want)
		}
	}
}

func TestCommitsWithoutAConfiguredGitIdentity(t *testing.T) {
	requireGit(t)
	isolateGit(t)
	remote := bareRemote(t)
	a := newMachine(t, "a")
	a.link(remote, "shop-web")
	git(t, a.clone(), "config", "--unset", "user.name")
	git(t, a.clone(), "config", "--unset", "user.email")

	a.tickAfter(0)
	state := a.tickAfter(4 * time.Second)
	if state.LastCommit.IsZero() || state.LastPush.IsZero() {
		t.Fatalf("sync must not stall on a missing Git identity: %+v", state)
	}
}

func execGit(gitDir string, args ...string) *exec.Cmd {
	return exec.Command("git", append([]string{"--git-dir", gitDir}, args...)...)
}
