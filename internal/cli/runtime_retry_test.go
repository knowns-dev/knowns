package cli

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/spf13/cobra"
)

// seedRetryDeadLetter enqueues a Qdrant reconcile job in root and drives it to
// dead-lettered through the same exported path the real scheduler uses
// (MarkJobStarted -> CompleteJob with an error), rather than reaching into
// runtimequeue's unexported state or writing a queue file by hand. The loop is
// bounded so a change to the retry budget fails loudly instead of hanging.
func seedRetryDeadLetter(t *testing.T, root, entityID string) runtimequeue.Job {
	t.Helper()
	job, err := runtimequeue.EnqueueQdrantIntent(root, runtimequeue.QdrantIntent{
		EntityType: "task",
		EntityID:   entityID,
		Revision:   1,
		Operation:  "update",
		Generation: 1,
	})
	if err != nil {
		t.Fatalf("EnqueueQdrantIntent: %v", err)
	}
	for i := 0; i < 20; i++ {
		started, err := runtimequeue.MarkJobStarted(root, job.ID)
		if err != nil {
			t.Fatalf("MarkJobStarted: %v", err)
		}
		if err := runtimequeue.CompleteJob(root, started, errors.New("qdrant unreachable")); err != nil {
			t.Fatalf("CompleteJob: %v", err)
		}
		letters, err := runtimequeue.ListDeadLetters(root)
		if err != nil {
			t.Fatalf("ListDeadLetters: %v", err)
		}
		for _, letter := range letters {
			if letter.ID == job.ID {
				return letter
			}
		}
	}
	t.Fatalf("job %s never dead-lettered", job.ID)
	return runtimequeue.Job{}
}

// newRuntimeRetryTestCmd builds a command carrying the same flag set init()
// registers on runtimeRetryCmd, so a flag renamed in one place and not the
// other shows up as a test failure rather than a silently ignored flag.
func newRuntimeRetryTestCmd(t *testing.T) (*cobra.Command, *bytes.Buffer) {
	t.Helper()
	var out bytes.Buffer
	cmd := &cobra.Command{Use: "retry"}
	cmd.SetOut(&out)
	cmd.Flags().Bool("all", false, "")
	cmd.Flags().Bool("all-projects", false, "")
	cmd.Flags().Bool("dry-run", false, "")
	cmd.Flags().Bool("plain", false, "")
	cmd.Flags().Bool("json", false, "")
	return cmd, &out
}

func setRetryFlags(t *testing.T, cmd *cobra.Command, names ...string) {
	t.Helper()
	for _, name := range names {
		if err := cmd.Flags().Set(name, "true"); err != nil {
			t.Fatalf("set --%s: %v", name, err)
		}
	}
}

func deadLetterCount(t *testing.T, root string) int {
	t.Helper()
	letters, err := runtimequeue.ListDeadLetters(root)
	if err != nil {
		t.Fatalf("ListDeadLetters(%s): %v", root, err)
	}
	return len(letters)
}

// newRetryProject creates a project the command's own root lookup will accept
// (FindProjectRoot needs .knowns/config.json) and makes it the working
// directory, so the explicit-job-ID path resolves to a store under test
// instead of whichever repository the test binary happens to run in.
func newRetryProject(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	knownsDir := filepath.Join(dir, ".knowns")
	if err := os.MkdirAll(knownsDir, 0o755); err != nil {
		t.Fatalf("mkdir .knowns: %v", err)
	}
	if err := os.WriteFile(filepath.Join(knownsDir, "config.json"), []byte("{}"), 0o644); err != nil {
		t.Fatalf("write config.json: %v", err)
	}
	t.Chdir(dir)
	return knownsDir
}

// TestRuntimeRetryRejectsContradictoryInvocations pins the argument contract.
// Each of these must fail before any queue is opened: a bulk sweep combined
// with named jobs has no single meaning, and an invocation naming no scope at
// all must not quietly default to releasing everything.
func TestRuntimeRetryRejectsContradictoryInvocations(t *testing.T) {
	cases := []struct {
		name  string
		args  []string
		flags []string
		want  string
	}{
		{name: "job ids with --all", args: []string{"job-1"}, flags: []string{"all"}, want: "cannot combine"},
		{name: "job ids with --all-projects", args: []string{"job-1"}, flags: []string{"all-projects"}, want: "cannot combine"},
		{name: "no ids and no scope flag", args: nil, flags: nil, want: "specify job IDs"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
			cmd, out := newRuntimeRetryTestCmd(t)
			setRetryFlags(t, cmd, tc.flags...)

			err := runRuntimeRetry(cmd, tc.args)
			if err == nil {
				t.Fatalf("expected an error, got nil (output=%s)", out.String())
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %q, want it to mention %q", err, tc.want)
			}
			if out.Len() != 0 {
				t.Fatalf("expected no output on a rejected invocation, got: %s", out.String())
			}
		})
	}
}

// TestRuntimeRetryDryRunPreviewsWithoutReleasing pins the promise --dry-run
// makes: it reports exactly what a live run would release, and leaves every
// dead letter in place. A preview that mutates is worse than no preview,
// because an operator reaches for it precisely when unsure.
func TestRuntimeRetryDryRunPreviewsWithoutReleasing(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	rootA := t.TempDir()
	rootB := t.TempDir()
	jobA := seedRetryDeadLetter(t, rootA, "preview-a")
	seedRetryDeadLetter(t, rootA, "preview-a2")
	jobB := seedRetryDeadLetter(t, rootB, "preview-b")

	cmd, out := newRuntimeRetryTestCmd(t)
	setRetryFlags(t, cmd, "all-projects", "dry-run", "plain")

	if err := runRuntimeRetry(cmd, nil); err != nil {
		t.Fatalf("runRuntimeRetry: %v", err)
	}

	got := out.String()
	if !strings.Contains(got, "mode=preview") {
		t.Fatalf("expected mode=preview in plain output, got:\n%s", got)
	}
	for _, id := range []string{jobA.ID, jobB.ID} {
		if !strings.Contains(got, id) {
			t.Fatalf("expected job %s in preview output, got:\n%s", id, got)
		}
	}
	if n := deadLetterCount(t, rootA); n != 2 {
		t.Fatalf("rootA dead letters after preview = %d, want 2", n)
	}
	if n := deadLetterCount(t, rootB); n != 1 {
		t.Fatalf("rootB dead letters after preview = %d, want 1", n)
	}
}

// TestRuntimeRetryAllProjectsReleasesEveryProject pins the sweep: --all-projects
// must reach every project the shared runtime knows about, not only the one the
// command happens to be run from, since an outage dead-letters them all at once.
func TestRuntimeRetryAllProjectsReleasesEveryProject(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	rootA := t.TempDir()
	rootB := t.TempDir()
	seedRetryDeadLetter(t, rootA, "sweep-a")
	seedRetryDeadLetter(t, rootB, "sweep-b")

	cmd, out := newRuntimeRetryTestCmd(t)
	setRetryFlags(t, cmd, "all-projects", "plain")

	if err := runRuntimeRetry(cmd, nil); err != nil {
		t.Fatalf("runRuntimeRetry: %v", err)
	}

	got := out.String()
	if !strings.Contains(got, "mode=release") {
		t.Fatalf("expected mode=release in plain output, got:\n%s", got)
	}
	if n := deadLetterCount(t, rootA); n != 0 {
		t.Fatalf("rootA dead letters after release = %d, want 0", n)
	}
	if n := deadLetterCount(t, rootB); n != 0 {
		t.Fatalf("rootB dead letters after release = %d, want 0", n)
	}
}

// TestRuntimeRetryExplicitJobsReportRefusalsAndExitNonZero pins the mixed case
// an operator hits when pasting IDs from a dashboard: the releasable job must
// still be released, the two that cannot be must be named individually, and the
// command must exit non-zero so a script does not read a partial failure as
// success.
func TestRuntimeRetryExplicitJobsReportRefusalsAndExitNonZero(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	storeRoot := newRetryProject(t)

	dead := seedRetryDeadLetter(t, storeRoot, "explicit-1")
	generic, err := runtimequeue.Enqueue(storeRoot, runtimequeue.JobIndexDoc, "docs/example.md")
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	cmd, out := newRuntimeRetryTestCmd(t)
	setRetryFlags(t, cmd, "plain")

	err = runRuntimeRetry(cmd, []string{dead.ID, generic.ID, "no-such-job"})
	if err == nil {
		t.Fatalf("expected a non-nil error so the command exits non-zero (output=%s)", out.String())
	}
	for _, want := range []string{generic.ID, "no-such-job"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error = %q, want it to name %q", err, want)
		}
	}

	got := out.String()
	if !strings.Contains(got, fmt.Sprintf("retry-job\t%s\t%s", projectDisplayName(storeRoot), dead.ID)) {
		t.Fatalf("expected the released job reported in plain output, got:\n%s", got)
	}
	if !strings.Contains(got, "retry-refused") {
		t.Fatalf("expected refusals reported in plain output, got:\n%s", got)
	}

	if n := deadLetterCount(t, storeRoot); n != 0 {
		t.Fatalf("dead letters after release = %d, want 0", n)
	}
	state, err := runtimequeue.LoadQueue(storeRoot)
	if err != nil {
		t.Fatalf("LoadQueue: %v", err)
	}
	var sawGeneric bool
	for _, job := range state.Jobs {
		if job.ID == generic.ID {
			sawGeneric = true
		}
	}
	if !sawGeneric {
		t.Fatal("a refused non-Qdrant job must be left in the queue untouched")
	}
}

// TestRuntimeRetryDryRunOnExplicitJobsMutatesNothing pins the preview contract
// on the named-job path too. That path is the one that would otherwise call
// RetryJob per ID, so it is the easy place for a dry run to release by
// accident.
func TestRuntimeRetryDryRunOnExplicitJobsMutatesNothing(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	storeRoot := newRetryProject(t)
	dead := seedRetryDeadLetter(t, storeRoot, "explicit-preview")

	cmd, out := newRuntimeRetryTestCmd(t)
	setRetryFlags(t, cmd, "dry-run", "plain")

	if err := runRuntimeRetry(cmd, []string{dead.ID}); err != nil {
		t.Fatalf("runRuntimeRetry: %v", err)
	}
	if got := out.String(); !strings.Contains(got, dead.ID) {
		t.Fatalf("expected %s previewed, got:\n%s", dead.ID, got)
	}
	if n := deadLetterCount(t, storeRoot); n != 1 {
		t.Fatalf("dead letters after preview = %d, want 1", n)
	}
}
