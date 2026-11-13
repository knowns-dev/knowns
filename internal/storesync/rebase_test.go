package storesync

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func remoteFile(t *testing.T, remote, path string) string {
	t.Helper()
	cmd := execGit(remote, "show", "HEAD:"+path)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return string(out)
}

// twoMachines publishes projects from A and links them on B.
func twoMachines(t *testing.T, projects ...string) (string, *machine, *machine) {
	t.Helper()
	requireGit(t)
	isolateGit(t)
	remote := bareRemote(t)
	a := newMachine(t, "a")
	for _, p := range projects {
		a.link(remote, p)
	}
	publish(t, a)
	b := newMachine(t, "b")
	for _, p := range projects {
		b.link(remote, p)
	}
	b.tickAfter(0)
	b.clock = a.clock
	return remote, a, b
}

func TestRacingPushIsRebasedWithoutForce(t *testing.T) {
	remote, a, b := twoMachines(t, "shop-web")
	trace := filepath.Join(t.TempDir(), "git-trace.log")

	a.write("shop-web", "tasks/from-a.md", "# A\n")
	b.write("shop-web", "tasks/from-b.md", "# B\n")
	a.tickAfter(time.Second)
	a.tickAfter(3 * time.Second) // A wins the race

	t.Setenv("GIT_TRACE", trace)
	b.tickAfter(time.Second)
	state := b.tickAfter(3 * time.Second) // B commits, is rejected, rebases, pushes
	t.Setenv("GIT_TRACE", "")

	if state.QueuedCommits != 0 || state.Paused || len(state.Conflicts) != 0 {
		t.Fatalf("a non-conflicting race should settle without user action: %+v", state)
	}
	if remoteFile(t, remote, "shop-web/tasks/from-a.md") == "" || remoteFile(t, remote, "shop-web/tasks/from-b.md") == "" {
		t.Fatal("both machines' changes must be on the remote")
	}
	log, _ := os.ReadFile(trace)
	if !strings.Contains(string(log), "push") {
		t.Fatal("trace captured no push; the test is not observing the daemon")
	}
	for _, flag := range []string{"--force", "--force-with-lease", " -f "} {
		if strings.Contains(string(log), flag) {
			t.Fatalf("daemon invoked git with %q:\n%s", flag, log)
		}
	}
}

func TestThreeRejectionsPauseForPushContention(t *testing.T) {
	remote, _, b := twoMachines(t, "shop-web")
	// A third machine that always pushes first.
	c := filepath.Join(t.TempDir(), "c")
	git(t, "", "clone", "--quiet", remote, c)
	git(t, c, "config", "user.name", "c")
	git(t, c, "config", "user.email", "c@example.com")
	n := 0
	b.svc.beforePush = func() {
		n++
		git(t, c, "pull", "--quiet", "--rebase")
		os.WriteFile(filepath.Join(c, "shop-web", "race-"+strconv.Itoa(n)+".md"), []byte("c wins\n"), 0o644)
		git(t, c, "add", "-A")
		git(t, c, "commit", "--quiet", "-m", "c wins")
		git(t, c, "push", "--quiet")
	}

	b.write("shop-web", "tasks/from-b.md", "# B\n")
	b.tickAfter(time.Second)
	state := b.tickAfter(3 * time.Second)

	if n != maxPushAttempts {
		t.Fatalf("expected exactly %d push attempts, got %d", maxPushAttempts, n)
	}
	if !state.Paused || state.PauseCause != PausePushContention || !strings.Contains(state.PauseMessage, "rejected") {
		t.Fatalf("store should pause for push contention: %+v", state)
	}

	// Once the race stops, the next fetch interval pushes and resumes.
	b.svc.beforePush = nil
	state = b.tickAfter(31 * time.Second)
	if state.Paused || state.QueuedCommits != 0 || remoteFile(t, remote, "shop-web/tasks/from-b.md") == "" {
		t.Fatalf("contention pause should clear once a push succeeds: %+v", state)
	}
}

func TestConflictPausesOnlyThatProjectAndKeepsLocalContent(t *testing.T) {
	remote, a, b := twoMachines(t, "shop-web", "shop-api")
	a.write("shop-web", "tasks/t.md", "title: shared\n")
	a.tickAfter(time.Second)
	a.tickAfter(3 * time.Second)
	b.tickAfter(31 * time.Second) // B has the shared task

	a.write("shop-web", "tasks/t.md", "title: A's edit\n")
	a.tickAfter(time.Second)
	a.tickAfter(3 * time.Second)

	b.write("shop-web", "tasks/t.md", "title: B's edit\n")
	b.write("shop-api", "docs/b.md", "# B api note\n")
	b.tickAfter(time.Second)
	state := b.tickAfter(3 * time.Second)

	if len(state.Conflicts) != 1 || state.Conflicts[0].Project != "shop-web" || state.Conflicts[0].Paths[0] != "shop-web/tasks/t.md" {
		t.Fatalf("expected shop-web paused by a conflict on its task: %+v", state.Conflicts)
	}
	if got, _ := os.ReadFile(filepath.Join(b.clone(), "shop-web", "tasks", "t.md")); string(got) != "title: B's edit\n" {
		t.Fatalf("B's local content must be kept, got %q", got)
	}
	if got := remoteFile(t, remote, "shop-web/tasks/t.md"); got != "title: A's edit\n" {
		t.Fatalf("A's version must not be overwritten on the remote, got %q", got)
	}
	if remoteFile(t, remote, "shop-api/docs/b.md") == "" {
		t.Fatal("B's change to the other project must still be pushed")
	}
	copies, _ := filepath.Glob(filepath.Join(b.root, "runtime", "stores", "team-conflicts", "*", "shop-web", "tasks", "t.md"))
	if len(copies) != 1 {
		t.Fatalf("a copy of the local side should be saved, found %v", copies)
	}

	// The other project keeps syncing both ways while shop-web is paused.
	a.write("shop-api", "docs/a.md", "# A api note\n")
	a.tickAfter(time.Second)
	a.tickAfter(3 * time.Second)
	b.write("shop-api", "docs/b2.md", "# B again\n")
	b.tickAfter(31 * time.Second)
	state = b.tickAfter(4 * time.Second)
	if _, err := os.Stat(filepath.Join(b.clone(), "shop-api", "docs", "a.md")); err != nil {
		t.Fatal("shop-api must keep receiving changes while shop-web is paused")
	}
	if remoteFile(t, remote, "shop-api/docs/b2.md") == "" {
		t.Fatalf("shop-api must keep pushing while shop-web is paused: %+v", state)
	}
	if got, _ := os.ReadFile(filepath.Join(b.clone(), "shop-web", "tasks", "t.md")); string(got) != "title: B's edit\n" {
		t.Fatalf("the paused project's local content must survive later syncs, got %q", got)
	}
	if got := remoteFile(t, remote, "shop-web/tasks/t.md"); got != "title: A's edit\n" {
		t.Fatalf("the paused project's local content must not be pushed, remote has %q", got)
	}
}

func TestConflictPauseSurvivesARuntimeRestart(t *testing.T) {
	remote, a, b := twoMachines(t, "shop-web")
	a.write("shop-web", "tasks/t.md", "v0\n")
	a.tickAfter(time.Second)
	a.tickAfter(3 * time.Second)
	b.tickAfter(31 * time.Second)
	a.write("shop-web", "tasks/t.md", "A\n")
	a.tickAfter(time.Second)
	a.tickAfter(3 * time.Second)
	b.write("shop-web", "tasks/t.md", "B\n")
	b.tickAfter(time.Second)
	if s := b.tickAfter(3 * time.Second); len(s.Conflicts) != 1 {
		t.Fatalf("expected a conflict: %+v", s)
	}

	// Restart: a fresh service with the same registry and state directory.
	restarted := NewService(b.svc.cfg)
	b.svc = restarted
	b.tickAfter(time.Second)
	state := b.tickAfter(40 * time.Second)
	if len(state.Conflicts) != 1 {
		t.Fatalf("the conflict must survive a restart: %+v", state)
	}
	if got := remoteFile(t, remote, "shop-web/tasks/t.md"); got != "A\n" {
		t.Fatalf("after a restart the paused local content must still not be pushed, remote has %q", got)
	}
}
