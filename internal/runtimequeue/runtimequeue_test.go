package runtimequeue

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewIDIsUniqueAcrossConcurrentCalls(t *testing.T) {
	const workers = 32
	const idsPerWorker = 256

	ids := make(chan string, workers*idsPerWorker)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range idsPerWorker {
				ids <- newID()
			}
		}()
	}
	wg.Wait()
	close(ids)

	seen := make(map[string]struct{}, workers*idsPerWorker)
	for id := range ids {
		if _, exists := seen[id]; exists {
			t.Fatalf("duplicate ID generated: %s", id)
		}
		seen[id] = struct{}{}
	}
}

func TestGlobalRootHonorsHOMEOverride(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", t.TempDir())

	want := filepath.Join(home, ".knowns")
	if got := GlobalRoot(); got != want {
		t.Fatalf("GlobalRoot() = %q, want HOME override %q", got, want)
	}
}

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

func TestEnqueueRequiresExplicitAPIForReindex(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	storeRoot := filepath.Join(t.TempDir(), ".knowns")

	if _, err := Enqueue(storeRoot, JobReindex, storeRoot); err == nil {
		t.Fatal("generic Enqueue should reject full search reindex jobs")
	}

	job, err := EnqueueReindex(storeRoot)
	if err != nil {
		t.Fatalf("enqueue explicit reindex: %v", err)
	}
	if job.Kind != JobReindex {
		t.Fatalf("explicit reindex kind = %q, want %q", job.Kind, JobReindex)
	}
	if job.Target != "" {
		t.Fatalf("explicit reindex target = %q, want empty target", job.Target)
	}
}

func TestQdrantIntentFailurePersistsAcrossReloadAndRetry(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), ".knowns")
	job, err := EnqueueQdrantIntent(root, QdrantIntent{EntityType: "task", EntityID: "retry", Revision: 3, Operation: "update", CanonicalHash: "hash"})
	if err != nil {
		t.Fatal(err)
	}
	running, err := MarkJobStarted(root, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := CompleteJob(root, running, errors.New("qdrant unavailable")); err != nil {
		t.Fatal(err)
	}
	state, err := LoadQueue(root)
	if err != nil || len(state.Jobs) != 1 {
		t.Fatalf("retry queue = %#v, err=%v", state, err)
	}
	if state.Jobs[0].LastError == "" || !state.Jobs[0].RunAfter.After(time.Now()) {
		t.Fatalf("retry state = %#v, want error and future backoff", state.Jobs[0])
	}
	if len(state.Recent) != 1 || !state.Recent[0].Retryable {
		t.Fatalf("retry recent = %#v, want retryable failure", state.Recent)
	}
	// Reloading the JSON queue must retain the active retry, and waiting must
	// not return the older Recent failure while it remains queued.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := WaitForJobContext(ctx, root, job.ID, time.Second); err == nil || !strings.Contains(err.Error(), "context deadline") {
		t.Fatalf("WaitForJob while retry queued = %v, want context deadline", err)
	}
	if err := updateQueue(root, func(s *QueueState) error { s.Jobs[0].DeadLetter = true; return nil }); err != nil {
		t.Fatal(err)
	}
	retried, err := RetryJob(root, job.ID)
	if err != nil || retried.DeadLetter || retried.LastError != "" || retried.RunAfter.After(time.Now().Add(time.Second)) {
		t.Fatalf("RetryJob = %#v, err=%v", retried, err)
	}
}

func TestQdrantIntentRunningSuccessorSurvivesOlderCompletion(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), ".knowns")
	first, err := EnqueueQdrantIntent(root, QdrantIntent{EntityType: "doc", EntityID: "doc-1", Revision: 1, Operation: "update", Path: "docs/a.md"})
	if err != nil {
		t.Fatal(err)
	}
	running, err := MarkJobStarted(root, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := EnqueueQdrantIntent(root, QdrantIntent{EntityType: "doc", EntityID: "doc-1", Revision: 2, Operation: "rename", Path: "docs/b.md", PreviousPath: "docs/a.md"})
	if err != nil {
		t.Fatal(err)
	}
	if second.Intent == nil || second.Intent.Generation <= running.Intent.Generation {
		t.Fatalf("successor generation = %#v, running=%#v", second.Intent, running.Intent)
	}
	if err := CompleteJob(root, running, nil); err != nil {
		t.Fatal(err)
	}
	state, err := LoadQueue(root)
	if err != nil || len(state.Jobs) != 1 {
		t.Fatalf("successor queue = %#v, err=%v", state, err)
	}
	if state.Jobs[0].Intent == nil || state.Jobs[0].Intent.Revision != 2 || state.Jobs[0].StartedAt != nil {
		t.Fatalf("successor was lost or still running: %#v", state.Jobs[0])
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

func TestWatchLifecycleSharesOneWatcherAndHonorsGrace(t *testing.T) {
	current := time.Date(2026, 8, 14, 7, 0, 0, 0, time.UTC)
	started := make(chan struct{}, 2)
	stopped := make(chan struct{}, 2)
	finished := make(chan struct{}, 2)
	starts := 0
	lifecycle := NewWatchLifecycle(func() time.Time { return current }, func(string) time.Duration { return 30 * time.Second })
	factory := func(ctx context.Context, projectRoot string) error {
		starts++
		started <- struct{}{}
		<-ctx.Done()
		stopped <- struct{}{}
		finished <- struct{}{}
		return ctx.Err()
	}
	leases := make([]Lease, 10)
	for i := range leases {
		leases[i] = Lease{ID: string(rune('a' + i)), ClientKind: "mcp", ProjectRoot: "/project/.knowns", Watch: true}
	}
	lifecycle.Reconcile(leases, factory)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("watcher did not start")
	}
	lifecycle.Reconcile(leases, factory)
	if starts != 1 {
		t.Fatalf("watcher starts = %d, want one for ten leases", starts)
	}
	status := lifecycle.Status(leases)
	if len(status) != 1 || status[0].Demand != 10 || !status[0].Active || status[0].GracePending {
		t.Fatalf("active watcher status = %+v, want demand=10 active", status)
	}

	leases = leases[:1]
	lifecycle.Reconcile(leases, factory)
	status = lifecycle.Status(leases)
	if len(status) != 1 || status[0].Demand != 1 || !status[0].Active {
		t.Fatalf("partial disconnect status = %+v, want watcher active with demand=1", status)
	}

	leases = nil
	lifecycle.Reconcile(leases, factory)
	status = lifecycle.Status(leases)
	if len(status) != 1 || status[0].Demand != 0 || !status[0].Active || !status[0].GracePending {
		t.Fatalf("final disconnect status = %+v, want grace-pending watcher", status)
	}
	current = current.Add(29 * time.Second)
	lifecycle.Reconcile(leases, factory)
	select {
	case <-stopped:
		t.Fatal("watcher stopped before grace expired")
	default:
	}

	// A new eligible lease cancels the pending grace period.
	leases = []Lease{{ID: "new", ClientKind: "mcp", ProjectRoot: "/project/.knowns", Watch: true}}
	lifecycle.Reconcile(leases, factory)
	status = lifecycle.Status(leases)
	if len(status) != 1 || status[0].Demand != 1 || status[0].GracePending {
		t.Fatalf("grace cancellation status = %+v, want active demand=1", status)
	}
	if starts != 1 {
		t.Fatalf("watcher restarted after grace cancellation, starts = %d", starts)
	}

	leases = nil
	lifecycle.Reconcile(leases, factory)
	current = current.Add(30 * time.Second)
	lifecycle.Reconcile(leases, factory)
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("watcher did not stop after grace expiry")
	}
	<-finished
	deadline := time.After(time.Second)
	for {
		lifecycle.Reconcile(leases, factory)
		if status := lifecycle.Status(leases); len(status) == 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("stopped watcher status = %+v, want no watcher", lifecycle.Status(leases))
		case <-time.After(time.Millisecond):
		}
	}
}

func TestWatchLifecycleDoesNotOverlapCanceledGenerationOnReacquire(t *testing.T) {
	current := time.Date(2026, 8, 14, 7, 0, 0, 0, time.UTC)
	const projectRoot = "/project/.knowns"
	started := make(chan struct{}, 2)
	finished := make(chan struct{}, 2)
	releaseOld := make(chan struct{})
	var active, maxActive, starts int32
	lifecycle := NewWatchLifecycle(func() time.Time { return current }, func(string) time.Duration { return time.Second })
	factory := func(ctx context.Context, _ string) error {
		currentActive := atomic.AddInt32(&active, 1)
		for {
			oldMax := atomic.LoadInt32(&maxActive)
			if currentActive <= oldMax || atomic.CompareAndSwapInt32(&maxActive, oldMax, currentActive) {
				break
			}
		}
		generation := atomic.AddInt32(&starts, 1)
		started <- struct{}{}
		if generation == 1 {
			<-ctx.Done()
			<-releaseOld
		} else {
			<-ctx.Done()
		}
		atomic.AddInt32(&active, -1)
		finished <- struct{}{}
		return ctx.Err()
	}

	lease := Lease{ID: "first", ClientKind: "mcp", ProjectRoot: projectRoot, Watch: true}
	lifecycle.Reconcile([]Lease{lease}, factory)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("initial watcher did not start")
	}

	lifecycle.Reconcile(nil, factory)
	current = current.Add(time.Second)
	lifecycle.Reconcile(nil, factory)
	status := lifecycle.Status(nil)
	if len(status) != 1 || status[0].State != string(watcherCancelRequested) || status[0].Active {
		t.Fatalf("expired watcher status = %+v, want inactive cancelRequested", status)
	}

	// Demand returns while shutdown is pending. The old factory is still held
	// open, so no replacement may start and max concurrency must stay at one.
	lifecycle.Reconcile([]Lease{lease}, factory)
	if got := atomic.LoadInt32(&starts); got != 1 {
		t.Fatalf("watcher starts during pending shutdown = %d, want 1", got)
	}
	if got := atomic.LoadInt32(&maxActive); got != 1 {
		t.Fatalf("max concurrent factories = %d, want 1", got)
	}
	if got := lifecycle.Status([]Lease{lease}); len(got) != 1 || got[0].State != string(watcherCancelRequested) || got[0].Active {
		t.Fatalf("reacquired pending-shutdown status = %+v, want inactive cancelRequested", got)
	}

	close(releaseOld)
	<-finished
	deadline := time.After(time.Second)
	for atomic.LoadInt32(&starts) < 2 {
		lifecycle.Reconcile([]Lease{lease}, factory)
		select {
		case <-deadline:
			t.Fatal("replacement watcher did not start after old generation finished")
		case <-time.After(time.Millisecond):
		}
	}
	if got := atomic.LoadInt32(&starts); got != 2 {
		t.Fatalf("watcher starts after completion = %d, want 2", got)
	}
	if got := atomic.LoadInt32(&maxActive); got != 1 {
		t.Fatalf("max concurrent factories after replacement = %d, want 1", got)
	}
	lifecycle.Stop()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("replacement watcher did not stop")
	}
}

func TestWatchLifecycleHeartbeatExpiryPreservesQueuedWorkAndReload(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	current := time.Date(2026, 8, 14, 7, 0, 0, 0, time.UTC)
	storeRoot := filepath.Join(t.TempDir(), ".knowns")
	job, err := EnqueueReindex(storeRoot)
	if err != nil {
		t.Fatalf("enqueue job: %v", err)
	}
	if _, err := RequestReload(); err != nil {
		t.Fatalf("request reload: %v", err)
	}

	started := make(chan struct{})
	finished := make(chan struct{})
	lifecycle := NewWatchLifecycle(func() time.Time { return current }, func(string) time.Duration { return 30 * time.Second })
	factory := func(ctx context.Context, _ string) error {
		close(started)
		<-ctx.Done()
		close(finished)
		return ctx.Err()
	}
	lease := Lease{
		ID: "heartbeat", ClientKind: "mcp", ProjectRoot: storeRoot, Watch: true,
		ExpiresAt: current.Add(10 * time.Second),
	}
	lifecycle.Reconcile([]Lease{lease}, factory)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("watcher did not start")
	}

	// Expiry removes demand, but the queued job and pending reload remain
	// available while the watcher enters its final-client grace period.
	current = current.Add(11 * time.Second)
	lifecycle.Reconcile([]Lease{lease}, factory)
	status := lifecycle.Status([]Lease{lease})
	if len(status) != 1 || status[0].Demand != 0 || status[0].State != string(watcherGrace) || !status[0].GracePending {
		t.Fatalf("expired heartbeat status = %+v, want grace with zero demand", status)
	}
	queue, err := LoadQueue(storeRoot)
	if err != nil {
		t.Fatalf("load queue during watcher grace: %v", err)
	}
	if len(queue.Jobs) != 1 || queue.Jobs[0].ID != job.ID {
		t.Fatalf("queued work during watcher grace = %+v, want job %s", queue.Jobs, job.ID)
	}
	if _, found, err := pendingReload(); err != nil || !found {
		t.Fatalf("pending reload during watcher grace: found=%v err=%v", found, err)
	}

	lifecycle.Stop()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("watcher did not stop")
	}
}

func TestWatchEnabledForClientUsesProjectConfiguration(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	projectRoot := filepath.Join(t.TempDir(), ".knowns")
	if err := os.MkdirAll(projectRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	config := `{"settings":{"runtimeWatch":{"enabled":true,"eligibleClients":["mcp"],"gracePeriod":"45s"}}}`
	if err := os.WriteFile(filepath.Join(projectRoot, "config.json"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	if !WatchEnabledForClient("mcp", projectRoot) {
		t.Fatal("MCP should be eligible under project runtimeWatch configuration")
	}
	if WatchEnabledForClient("opencode", projectRoot) {
		t.Fatal("opencode should not be eligible when omitted from project configuration")
	}
	t.Setenv("KNOWNS_RUNTIME_WATCH_ENABLED", "0")
	if WatchEnabledForClient("mcp", projectRoot) {
		t.Fatal("environment override should disable watch demand")
	}
}

func TestActiveLeasesDropsExpiredWatchLease(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := os.MkdirAll(leaseDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(leaseDir(), "expired.json")
	lease := Lease{
		ID:          "expired",
		ClientKind:  "mcp",
		ProjectRoot: "/project/.knowns",
		Watch:       true,
		ExpiresAt:   time.Now().UTC().Add(-time.Second),
	}
	data, err := json.Marshal(lease)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	active, err := ActiveLeases()
	if err != nil {
		t.Fatal(err)
	}
	if len(active) != 0 {
		t.Fatalf("active leases = %+v, want expired watch lease removed", active)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expired lease file still exists, stat error=%v", err)
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

func TestRequestReloadPersistsRequest(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())

	request, err := RequestReload()
	if err != nil {
		t.Fatalf("request reload: %v", err)
	}
	if request.ID == "" {
		t.Fatalf("request id is empty")
	}
	if request.RequestedAt.IsZero() {
		t.Fatalf("request timestamp is zero")
	}
	stored, found, err := pendingReload()
	if err != nil {
		t.Fatalf("load pending reload: %v", err)
	}
	if !found {
		t.Fatalf("pending reload not found")
	}
	if stored.ID != request.ID {
		t.Fatalf("stored request id = %q, want %q", stored.ID, request.ID)
	}
}

func TestWaitForReloadIgnoresStaleAcknowledgement(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())

	if err := writeJSON(reloadStatusPath(), ReloadStatus{
		RequestID:   "old-request",
		Generation:  3,
		ProcessedAt: time.Now().UTC(),
		Success:     true,
	}); err != nil {
		t.Fatalf("write stale reload status: %v", err)
	}
	if _, err := WaitForReload("new-request", 150*time.Millisecond); err == nil {
		t.Fatalf("wait should time out while only stale acknowledgement exists")
	}
}

func TestRunDaemonProcessesReloadAtSafePoint(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KNOWNS_RUNTIME_IDLE_TIMEOUT_MS", "2000")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	acknowledged := make(chan ReloadStatus, 1)
	done := make(chan error, 1)
	go func() {
		done <- RunDaemonWithOptions(ctx, DaemonOptions{
			Executor: func(storeRoot string, job Job) error {
				return nil
			},
			ReloadHandler: func(ctx context.Context, status ReloadStatus) error {
				acknowledged <- status
				return nil
			},
		})
	}()
	defer func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("run daemon: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("daemon did not stop")
		}
	}()

	request, err := RequestReload()
	if err != nil {
		t.Fatalf("request reload: %v", err)
	}
	status, err := WaitForReload(request.ID, 2*time.Second)
	if err != nil {
		t.Fatalf("wait for reload: %v", err)
	}
	if status.RequestID != request.ID {
		t.Fatalf("ack request id = %q, want %q", status.RequestID, request.ID)
	}
	if status.Generation != 1 {
		t.Fatalf("generation = %d, want 1", status.Generation)
	}
	select {
	case handled := <-acknowledged:
		if handled.RequestID != request.ID {
			t.Fatalf("handler request id = %q, want %q", handled.RequestID, request.ID)
		}
	default:
		t.Fatalf("reload handler was not called")
	}
}

func TestRunDaemonDefersReloadWhileJobIsRunning(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KNOWNS_RUNTIME_IDLE_TIMEOUT_MS", "2000")
	storeRoot := filepath.Join(t.TempDir(), ".knowns")
	if _, err := EnqueueReindex(storeRoot); err != nil {
		t.Fatalf("enqueue reindex: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	started := make(chan struct{})
	release := make(chan struct{})
	acknowledged := make(chan ReloadStatus, 1)
	done := make(chan error, 1)
	go func() {
		done <- RunDaemonWithOptions(ctx, DaemonOptions{
			Executor: func(storeRoot string, job Job) error {
				close(started)
				<-release
				return nil
			},
			ReloadHandler: func(ctx context.Context, status ReloadStatus) error {
				acknowledged <- status
				return nil
			},
		})
	}()
	defer func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("run daemon: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("daemon did not stop")
		}
	}()

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatalf("job did not start")
	}
	request, err := RequestReload()
	if err != nil {
		t.Fatalf("request reload: %v", err)
	}
	select {
	case status := <-acknowledged:
		t.Fatalf("reload acknowledged while job was running: %+v", status)
	case <-time.After(150 * time.Millisecond):
	}
	close(release)
	status, err := WaitForReload(request.ID, 2*time.Second)
	if err != nil {
		t.Fatalf("wait for reload: %v", err)
	}
	if status.RequestID != request.ID {
		t.Fatalf("ack request id = %q, want %q", status.RequestID, request.ID)
	}
}

func TestLoadJobSnapshotFindsQueuedAndCompletedJobs(t *testing.T) {
	SetTestBypass(true)
	defer SetTestBypass(false)
	t.Setenv("HOME", t.TempDir())
	storeRoot := filepath.Join(t.TempDir(), ".knowns")

	job, err := EnqueueReindex(storeRoot)
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

	job, err := EnqueueReindex(storeRoot)
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
