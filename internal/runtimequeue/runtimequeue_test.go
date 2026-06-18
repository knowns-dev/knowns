package runtimequeue

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestIsGoTestBinaryRecognizesWindowsExe(t *testing.T) {
	tests := map[string]bool{
		"/tmp/routes.test":                   true,
		`C:\Temp\TestRoutes\routes.test.exe`: true,
		"/tmp/routes.test.exe":               true,
		"/tmp/routes-test.exe":               false,
		"/tmp/routes.testify.exe":            false,
	}
	for path, want := range tests {
		if got := isGoTestBinary(path); got != want {
			t.Fatalf("isGoTestBinary(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestEnqueueCoalescesDuplicateJobs(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	storeRoot := filepath.Join(t.TempDir(), ".knowns")

	job1, err := Enqueue(storeRoot, JobIndexTask, "abc")
	if err != nil {
		t.Fatalf("enqueue first job: %v", err)
	}
	job2, err := Enqueue(storeRoot, JobIndexTask, "abc")
	if err != nil {
		t.Fatalf("enqueue second job: %v", err)
	}
	queue, err := LoadQueue(storeRoot)
	if err != nil {
		t.Fatalf("load queue: %v", err)
	}
	if len(queue.Jobs) != 1 {
		t.Fatalf("expected 1 coalesced job, got %d", len(queue.Jobs))
	}
	if queue.Jobs[0].ID != job1.ID {
		t.Fatalf("expected coalesced job to keep original id %s, got %s", job1.ID, queue.Jobs[0].ID)
	}
	if job2.ID != job1.ID {
		t.Fatalf("expected returned coalesced job id %s, got %s", job1.ID, job2.ID)
	}
}

func TestAcquireClientTracksIndependentLeases(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	storeRoot := filepath.Join(t.TempDir(), ".knowns")

	first, err := AcquireClient("mcp", storeRoot, false)
	if err != nil {
		t.Fatalf("acquire first client: %v", err)
	}
	defer first.Release()
	second, err := AcquireClient("opencode", storeRoot, true)
	if err != nil {
		t.Fatalf("acquire second client: %v", err)
	}
	defer second.Release()

	leases, err := ActiveLeases()
	if err != nil {
		t.Fatalf("active leases: %v", err)
	}
	projectLeases := 0
	for _, lease := range leases {
		if lease.ProjectRoot == storeRoot {
			projectLeases++
		}
	}
	if projectLeases != 2 {
		t.Fatalf("expected 2 leases for project %s, got %d", storeRoot, projectLeases)
	}
	if err := first.Release(); err != nil {
		t.Fatalf("release first lease: %v", err)
	}
	leases, err = ActiveLeases()
	if err != nil {
		t.Fatalf("active leases after release: %v", err)
	}
	projectLeases = 0
	for _, lease := range leases {
		if lease.ProjectRoot == storeRoot {
			projectLeases++
		}
	}
	if projectLeases != 1 {
		t.Fatalf("expected second lease to remain for project %s, got %d leases", storeRoot, projectLeases)
	}
}

func TestRunDaemonStopsAfterIdle(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KNOWNS_RUNTIME_IDLE_TIMEOUT_MS", "100")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	started := time.Now()
	err := RunDaemon(ctx, func(storeRoot string, job Job) error {
		return nil
	}, nil)
	if err != nil {
		t.Fatalf("run daemon: %v", err)
	}
	if time.Since(started) < 100*time.Millisecond {
		t.Fatalf("daemon exited before idle timeout elapsed")
	}
}

func TestLoadJobSnapshotFindsQueuedAndCompletedJobs(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	storeRoot := filepath.Join(t.TempDir(), ".knowns")

	job, err := Enqueue(storeRoot, JobReindex, "")
	if err != nil {
		t.Fatalf("enqueue job: %v", err)
	}
	if err := ReportProgress(storeRoot, job.ID, "docs", 3, 10); err != nil {
		t.Fatalf("report progress: %v", err)
	}

	snapshot, err := LoadJobSnapshot(storeRoot, job.ID)
	if err != nil {
		t.Fatalf("load queued snapshot: %v", err)
	}
	if !snapshot.Found || snapshot.Completed {
		t.Fatalf("expected active queued snapshot, got %+v", snapshot)
	}
	if snapshot.Phase() != "docs" || snapshot.Processed() != 3 || snapshot.Total() != 10 {
		t.Fatalf("unexpected queued snapshot data: phase=%q processed=%d total=%d", snapshot.Phase(), snapshot.Processed(), snapshot.Total())
	}

	if err := CompleteJob(storeRoot, job, nil); err != nil {
		t.Fatalf("complete job: %v", err)
	}

	snapshot, err = LoadJobSnapshot(storeRoot, job.ID)
	if err != nil {
		t.Fatalf("load completed snapshot: %v", err)
	}
	if !snapshot.Found || !snapshot.Completed {
		t.Fatalf("expected completed snapshot, got %+v", snapshot)
	}
	if !snapshot.Success() {
		t.Fatalf("expected completed snapshot to be successful")
	}
}

func TestLoadJobSnapshotMissingJob(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	storeRoot := filepath.Join(t.TempDir(), ".knowns")

	snapshot, err := LoadJobSnapshot(storeRoot, "missing-job")
	if err != nil {
		t.Fatalf("load missing snapshot: %v", err)
	}
	if snapshot.Found {
		t.Fatalf("expected missing snapshot, got %+v", snapshot)
	}
}

func TestWaitForJobReturnsCompletedSnapshotResult(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	storeRoot := filepath.Join(t.TempDir(), ".knowns")

	job, err := Enqueue(storeRoot, JobReindex, "")
	if err != nil {
		t.Fatalf("enqueue job: %v", err)
	}
	started, err := MarkJobStarted(storeRoot, job.ID)
	if err != nil {
		t.Fatalf("mark started: %v", err)
	}
	if err := CompleteJob(storeRoot, started, nil); err != nil {
		t.Fatalf("complete job: %v", err)
	}

	result, err := WaitForJob(storeRoot, job.ID, time.Second)
	if err != nil {
		t.Fatalf("wait for job: %v", err)
	}
	if result.JobID != job.ID || !result.Success {
		t.Fatalf("unexpected result: %+v", result)
	}
}
