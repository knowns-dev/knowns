package runtimequeue

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// markDeadLetter turns the single queued job into a retained dead letter, the
// state CompleteJob leaves behind once a Qdrant intent exhausts its attempts.
func markDeadLetter(t *testing.T, storeRoot string, requestedAt time.Time) {
	t.Helper()
	if err := updateQueue(storeRoot, func(state *QueueState) error {
		for _, job := range state.Jobs {
			job.DeadLetter = true
			job.Attempts = qdrantRetryLimit
			job.RequestedAt = requestedAt
			job.RunAfter = time.Now().UTC().Add(24 * time.Hour)
		}
		return nil
	}); err != nil {
		t.Fatalf("mark dead letter: %v", err)
	}
}

func TestRunDaemonStopsWhenOnlyDeadLettersRemain(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KNOWNS_RUNTIME_IDLE_TIMEOUT_MS", "100")

	storeRoot := filepath.Join(t.TempDir(), ".knowns")
	if err := os.MkdirAll(storeRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := EnqueueReindex(storeRoot); err != nil {
		t.Fatalf("enqueue reindex: %v", err)
	}
	markDeadLetter(t, storeRoot, time.Now().UTC())

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	executed := 0
	if err := RunDaemon(ctx, func(storeRoot string, job Job) error {
		executed++
		return nil
	}, nil); err != nil {
		t.Fatalf("run daemon: %v", err)
	}
	if ctx.Err() != nil {
		t.Fatalf("daemon never reached idle shutdown with only dead letters queued")
	}
	if executed != 0 {
		t.Fatalf("dead letter executed %d times, want 0", executed)
	}
}

func TestPruneDeadLettersDropsExpiredAndCapsRetention(t *testing.T) {
	now := time.Now().UTC()
	state := &QueueState{}
	live := &Job{ID: "live", Key: "live", Kind: JobReindex, RequestedAt: now}
	state.Jobs = append(state.Jobs, live)
	expired := &Job{ID: "expired", Key: "expired", Kind: JobQdrantReconcile,
		DeadLetter: true, RequestedAt: now.Add(-deadLetterTTL - time.Hour)}
	state.Jobs = append(state.Jobs, expired)
	for i := 0; i < maxDeadLettersKept+10; i++ {
		state.Jobs = append(state.Jobs, &Job{
			ID:          "dead-" + string(rune('a'+i%26)) + string(rune('a'+i/26)),
			Kind:        JobQdrantReconcile,
			DeadLetter:  true,
			RequestedAt: now.Add(-time.Duration(i) * time.Minute),
		})
	}

	pruneDeadLetters("/tmp/store", state, now)

	dead := 0
	sawLive, sawExpired := false, false
	for _, job := range state.Jobs {
		switch {
		case job.ID == "live":
			sawLive = true
		case job.ID == "expired":
			sawExpired = true
		}
		if job.DeadLetter {
			dead++
		}
	}
	if !sawLive {
		t.Fatal("pruning removed a live job")
	}
	if sawExpired {
		t.Fatal("dead letter older than the TTL was retained")
	}
	if dead != maxDeadLettersKept {
		t.Fatalf("retained %d dead letters, want the %d cap", dead, maxDeadLettersKept)
	}
}

func TestRegisterProjectUnregistersVanishedRootsWithoutQueuedJobs(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())

	gone := filepath.Join(t.TempDir(), "deleted", ".knowns")
	if err := registerProject(gone); err != nil {
		t.Fatalf("register vanished project: %v", err)
	}
	busy := filepath.Join(t.TempDir(), "busy", ".knowns")
	if _, err := EnqueueReindex(busy); err != nil {
		t.Fatalf("enqueue for busy project: %v", err)
	}

	live := filepath.Join(t.TempDir(), "live", ".knowns")
	if err := os.MkdirAll(live, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := registerProject(live); err != nil {
		t.Fatalf("register live project: %v", err)
	}

	projects, err := registeredProjects()
	if err != nil {
		t.Fatalf("registered projects: %v", err)
	}
	seen := map[string]bool{}
	for _, project := range projects {
		seen[project] = true
	}
	if seen[gone] {
		t.Fatalf("vanished root with no queued jobs stayed registered: %#v", projects)
	}
	if !seen[busy] {
		t.Fatalf("vanished root with queued jobs was unregistered: %#v", projects)
	}
	if !seen[live] {
		t.Fatalf("existing root was unregistered: %#v", projects)
	}
}

func TestRuntimeRootPrefersExplicitOverride(t *testing.T) {
	override := t.TempDir()
	t.Setenv(EnvRuntimeRoot, override)
	if got := RuntimeRoot(); got != override {
		t.Fatalf("RuntimeRoot() = %q, want override %q", got, override)
	}
}

func TestRuntimeRootSandboxesTestBinariesAwayFromRealHome(t *testing.T) {
	t.Setenv(EnvRuntimeRoot, "")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("cannot resolve user home: %v", err)
	}
	root := RuntimeRoot()
	if root == filepath.Join(home, ".knowns", "runtime") {
		t.Fatalf("test binary resolved the real runtime root %q", root)
	}
}
