package runtimequeue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/util"
)

type JobKind string

const (
	JobIndexTask          JobKind = "index-task"
	JobIndexDoc           JobKind = "index-doc"
	JobRemoveTask         JobKind = "remove-task"
	JobRemoveDoc          JobKind = "remove-doc"
	JobIndexMemory        JobKind = "index-memory"
	JobRemoveMemory       JobKind = "remove-memory"
	JobIndexDecision      JobKind = "index-decision"
	JobRemoveDecision     JobKind = "remove-decision"
	JobSemanticSearch     JobKind = "semantic-search"
	JobIndexAll           JobKind = "index-all-files"
	JobIndexFile          JobKind = "index-file"
	JobRemoveFile         JobKind = "remove-file"
	JobReindex            JobKind = "reindex-search"
	JobReconcileKnowledge JobKind = "reconcile-knowledge"
	// JobQdrantReconcile is a targeted, routine lifecycle sync. It is
	// intentionally distinct from JobReindex: it may never create/swap a
	// collection or mutate the active pointer.
	JobQdrantReconcile JobKind = "reconcile-qdrant"
)

const (
	defaultPollInterval = 500 * time.Millisecond
	defaultIdleTimeout  = 15 * time.Second
	defaultLeaseTTL     = 20 * time.Second
	defaultWatchGrace   = 30 * time.Second
	defaultLockTimeout  = 3 * time.Second
	defaultLockStaleAge = 10 * time.Second
	maxRecentResults    = 50
	defaultLogMaxBytes  = 10 * 1024 * 1024
	defaultLogBackups   = 3
	qdrantRetryLimit    = 8
)

// QdrantIntent is the content-free handoff from durable history/manifest to
// targeted indexing. It contains no entity text, endpoint, or credential.
type QdrantIntent struct {
	EntityType    string `json:"entityType"`
	EntityID      string `json:"entityId"`
	Revision      int    `json:"revision"`
	Operation     string `json:"operation"`
	CanonicalHash string `json:"canonicalHash,omitempty"`
	Path          string `json:"path,omitempty"`
	PreviousPath  string `json:"previousPath,omitempty"`
	BatchID       string `json:"batchId,omitempty"`
	Generation    uint64 `json:"generation"`
}

type Job struct {
	ID          string        `json:"id"`
	Key         string        `json:"key"`
	Kind        JobKind       `json:"kind"`
	Target      string        `json:"target,omitempty"`
	RequestedAt time.Time     `json:"requestedAt"`
	RunAfter    time.Time     `json:"runAfter"`
	StartedAt   *time.Time    `json:"startedAt,omitempty"`
	Attempts    int           `json:"attempts,omitempty"`
	LastError   string        `json:"lastError,omitempty"`
	Phase       string        `json:"phase,omitempty"`
	Processed   int           `json:"processed,omitempty"`
	Total       int           `json:"total,omitempty"`
	Details     *JobDetails   `json:"details,omitempty"`
	Intent      *QdrantIntent `json:"intent,omitempty"`
	DeadLetter  bool          `json:"deadLetter,omitempty"`
}

type JobDetails struct {
	Phase     string          `json:"phase,omitempty"`
	Processed int             `json:"processed,omitempty"`
	Total     int             `json:"total,omitempty"`
	Stats     map[string]int  `json:"stats,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
}

type JobResult struct {
	JobID        string      `json:"jobId"`
	Key          string      `json:"key"`
	Kind         JobKind     `json:"kind"`
	Target       string      `json:"target,omitempty"`
	Success      bool        `json:"success"`
	Error        string      `json:"error,omitempty"`
	CompletedAt  time.Time   `json:"completedAt"`
	RequestedAt  time.Time   `json:"requestedAt"`
	StartedAt    time.Time   `json:"startedAt"`
	AttemptCount int         `json:"attemptCount"`
	Details      *JobDetails `json:"details,omitempty"`
	Retryable    bool        `json:"retryable,omitempty"`
	DeadLetter   bool        `json:"deadLetter,omitempty"`
}

type QueueState struct {
	Jobs    []*Job      `json:"jobs"`
	Recent  []JobResult `json:"recent,omitempty"`
	Updated time.Time   `json:"updatedAt"`
}

type JobSnapshot struct {
	Job       *Job
	Result    *JobResult
	Found     bool
	Completed bool
}

func LoadJobSnapshot(storeRoot, jobID string) (JobSnapshot, error) {
	state, err := LoadQueue(storeRoot)
	if err != nil {
		return JobSnapshot{}, err
	}
	for _, job := range state.Jobs {
		if job.ID == jobID {
			clone := *job
			return JobSnapshot{Job: &clone, Found: true}, nil
		}
	}
	for i := range state.Recent {
		if state.Recent[i].JobID == jobID {
			clone := state.Recent[i]
			return JobSnapshot{Result: &clone, Found: true, Completed: true}, nil
		}
	}
	return JobSnapshot{}, nil
}

func (s JobSnapshot) Phase() string {
	if s.Job != nil {
		return s.Job.Phase
	}
	return ""
}

func (s JobSnapshot) Processed() int {
	if s.Job != nil {
		return s.Job.Processed
	}
	return 0
}

func (s JobSnapshot) Total() int {
	if s.Job != nil {
		return s.Job.Total
	}
	return 0
}

func (s JobSnapshot) Error() string {
	if s.Result != nil {
		return s.Result.Error
	}
	return ""
}

func (s JobSnapshot) Success() bool {
	if s.Result != nil {
		return s.Result.Success
	}
	return false
}

func (s JobSnapshot) JobResult() JobResult {
	if s.Result != nil {
		return *s.Result
	}
	return JobResult{}
}

type Lease struct {
	ID          string    `json:"id"`
	ClientKind  string    `json:"clientKind"`
	ProjectRoot string    `json:"projectRoot"`
	Watch       bool      `json:"watch"`
	PID         int       `json:"pid,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

type ClientHandle struct {
	mu       sync.Mutex
	lease    Lease
	released bool
}

type ProjectStatus struct {
	ProjectRoot string `json:"projectRoot"`
	QueuedJobs  int    `json:"queuedJobs"`
	RunningJobs int    `json:"runningJobs"`
}

type Status struct {
	Running  bool            `json:"running"`
	PID      int             `json:"pid,omitempty"`
	Version  string          `json:"version,omitempty"`
	Clients  []Lease         `json:"clients"`
	Project  []ProjectStatus `json:"projects"`
	Watchers []WatcherStatus `json:"watchers,omitempty"`
}

// WatcherStatus describes the project-level knowledge watcher demand and
// lifecycle. Demand is the number of valid watch-enabled client leases. A
// watcher with zero demand may remain active while its final-client grace
// period is pending.
type WatcherStatus struct {
	ProjectRoot  string    `json:"projectRoot"`
	Demand       int       `json:"demand"`
	Active       bool      `json:"active"`
	State        string    `json:"state"`
	GracePending bool      `json:"gracePending,omitempty"`
	GraceUntil   time.Time `json:"graceUntil,omitempty"`
}

type ReloadRequest struct {
	ID          string    `json:"id"`
	RequestedAt time.Time `json:"requestedAt"`
	PID         int       `json:"pid,omitempty"`
}

type ReloadStatus struct {
	RequestID   string    `json:"requestId,omitempty"`
	Generation  int64     `json:"generation,omitempty"`
	RequestedAt time.Time `json:"requestedAt,omitempty"`
	ProcessedAt time.Time `json:"processedAt,omitempty"`
	PID         int       `json:"pid,omitempty"`
	Success     bool      `json:"success"`
	Error       string    `json:"error,omitempty"`
}

type ReloadHandler func(ctx context.Context, status ReloadStatus) error

type DaemonOptions struct {
	Executor       Executor
	WatcherFactory WatcherFactory
	ReloadHandler  ReloadHandler
}

type Executor func(storeRoot string, job Job) error

type WatcherFactory func(ctx context.Context, storeRoot string) error

// WatchLifecycle owns at most one watcher per project and applies D1's final
// client grace period. The clock and grace-period resolver are injectable so
// lifecycle behavior can be tested without sleeping.
type watcherState string

const (
	watcherRunning         watcherState = "running"
	watcherGrace           watcherState = "grace"
	watcherCancelRequested watcherState = "cancelRequested"
	watcherStopped         watcherState = "stopped"
)

type WatchLifecycle struct {
	mu             sync.Mutex
	now            func() time.Time
	gracePeriod    func(string) time.Duration
	watchers       map[string]*watchLifecycleEntry
	nextGeneration uint64
}

type watchLifecycleEntry struct {
	cancel     context.CancelFunc
	graceUntil time.Time
	state      watcherState
	generation uint64
	done       chan struct{}
	doneOnce   sync.Once
}

// NewWatchLifecycle creates a watcher lifecycle controller. A nil clock uses
// UTC wall time and a nil grace resolver uses the project runtime-watch
// setting, falling back to the 30-second default.
func NewWatchLifecycle(now func() time.Time, gracePeriod func(string) time.Duration) *WatchLifecycle {
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	if gracePeriod == nil {
		gracePeriod = projectWatchGracePeriod
	}
	return &WatchLifecycle{
		now:         now,
		gracePeriod: gracePeriod,
		watchers:    make(map[string]*watchLifecycleEntry),
	}
}

// Reconcile starts missing project watchers, cancels pending grace when new
// demand arrives, and stops a watcher only after its grace deadline expires.
// The supplied factory is invoked at most once for each active project.
func (l *WatchLifecycle) Reconcile(leases []Lease, factory WatcherFactory) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now().UTC()
	demand := make(map[string]int)
	for _, lease := range leases {
		if leaseRequestsWatch(lease, now) {
			demand[lease.ProjectRoot]++
		}
	}

	// Keep canceled generations registered until their factories return. This
	// prevents a reacquired lease from starting an overlapping replacement.
	for projectRoot, entry := range l.watchers {
		select {
		case <-entry.done:
			delete(l.watchers, projectRoot)
		default:
		}
		if demand[projectRoot] > 0 {
			if entry.state == watcherGrace {
				entry.graceUntil = time.Time{}
				entry.state = watcherRunning
			}
			// A cancellation request cannot be undone. Reacquisition waits for
			// this generation to finish before the next reconcile starts one.
			continue
		}
		if entry.state == watcherCancelRequested {
			continue
		}
		if entry.state == watcherRunning {
			grace := l.gracePeriod(projectRoot)
			if grace < 0 {
				grace = defaultWatchGrace
			}
			entry.graceUntil = now.Add(grace)
			entry.state = watcherGrace
		}
		if !now.Before(entry.graceUntil) {
			entry.cancel()
			entry.state = watcherCancelRequested
		}
	}
	if factory == nil {
		return
	}
	for projectRoot, count := range demand {
		if count == 0 {
			continue
		}
		if _, ok := l.watchers[projectRoot]; ok {
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		l.nextGeneration++
		generation := l.nextGeneration
		entry := &watchLifecycleEntry{
			cancel: cancel, state: watcherRunning, generation: generation,
			done: make(chan struct{}),
		}
		l.watchers[projectRoot] = entry
		go func(storeRoot string, watcherCtx context.Context, watched *watchLifecycleEntry, token uint64) {
			if err := factory(watcherCtx, storeRoot); err != nil && !errors.Is(err, context.Canceled) {
				log.Printf("[runtime] watcher failed for %s: %v", storeRoot, err)
			}
			watched.doneOnce.Do(func() { close(watched.done) })
			// Do not mutate a newer generation if a late completion races with
			// reconciliation. The done channel is still closed for its owner.
			l.mu.Lock()
			if current, ok := l.watchers[storeRoot]; !ok || current != watched || current.generation != token {
				l.mu.Unlock()
				return
			}
			l.mu.Unlock()
		}(projectRoot, ctx, entry, generation)
	}
}

// Status returns a stable snapshot of watcher state, including projects in
// final-client grace so status remains useful during shutdown.
func (l *WatchLifecycle) Status(leases []Lease) []WatcherStatus {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	demand := make(map[string]int)
	for _, lease := range leases {
		if leaseRequestsWatch(lease, l.now().UTC()) {
			demand[lease.ProjectRoot]++
		}
	}
	for projectRoot, entry := range l.watchers {
		select {
		case <-entry.done:
			delete(l.watchers, projectRoot)
		default:
		}
	}
	projects := make(map[string]struct{}, len(l.watchers)+len(demand))
	for projectRoot := range l.watchers {
		projects[projectRoot] = struct{}{}
	}
	for projectRoot := range demand {
		projects[projectRoot] = struct{}{}
	}
	result := make([]WatcherStatus, 0, len(projects))
	for projectRoot := range projects {
		entry := l.watchers[projectRoot]
		status := WatcherStatus{ProjectRoot: projectRoot, Demand: demand[projectRoot], State: string(watcherStopped)}
		if entry != nil {
			status.State = string(entry.state)
			status.Active = entry.state == watcherRunning || entry.state == watcherGrace
			status.GraceUntil = entry.graceUntil
			status.GracePending = entry.state == watcherGrace
		}
		result = append(result, status)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ProjectRoot < result[j].ProjectRoot })
	return result
}

func leaseRequestsWatch(lease Lease, now time.Time) bool {
	return lease.Watch && lease.ProjectRoot != "" && (lease.ExpiresAt.IsZero() || lease.ExpiresAt.After(now))
}

// Stop cancels all active and grace-pending project watchers.
func (l *WatchLifecycle) Stop() {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, entry := range l.watchers {
		entry.cancel()
		entry.state = watcherCancelRequested
	}
}

func (l *WatchLifecycle) hasActiveOrGrace() bool {
	if l == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.watchers) > 0
}

type activeJob struct {
	storeRoot string
	job       Job
	resultCh  chan error
}

var (
	testBypassMu sync.RWMutex
	testBypass   bool
)

func SetTestBypass(enabled bool) {
	testBypassMu.Lock()
	defer testBypassMu.Unlock()
	testBypass = enabled
}

func ShouldBypassDaemon() bool {
	testBypassMu.RLock()
	defer testBypassMu.RUnlock()
	if testBypass {
		return true
	}
	if os.Getenv("KNOWNS_RUNTIME_INLINE") == "1" {
		return true
	}
	return isGoTestBinary(os.Args[0])
}

func isGoTestBinary(path string) bool {
	path = strings.ToLower(path)
	return strings.HasSuffix(path, ".test") || strings.HasSuffix(path, ".test.exe")
}

func GlobalRoot() string {
	if home := os.Getenv("HOME"); home != "" {
		return filepath.Join(home, ".knowns")
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(os.TempDir(), ".knowns")
	}
	return filepath.Join(home, ".knowns")
}

func RuntimeRoot() string {
	return filepath.Join(GlobalRoot(), "runtime")
}

func PIDFile() string {
	return filepath.Join(RuntimeRoot(), "knowns-runtime.pid")
}

func queuePath(storeRoot string) string {
	return filepath.Join(RuntimeRoot(), "queues", sanitizeProjectKey(storeRoot)+".json")
}

// sanitizeProjectKey produces a filesystem-safe key from a project store root.
// It uses the base directory name plus a short hash to avoid collisions while
// keeping the filename human-readable.
func sanitizeProjectKey(storeRoot string) string {
	clean := filepath.Clean(storeRoot)
	base := filepath.Base(filepath.Dir(clean)) // parent of .knowns
	if base == "" || base == "." || base == string(filepath.Separator) {
		base = "default"
	}
	// Short hash to disambiguate projects with the same parent name.
	h := uint32(0)
	for _, c := range clean {
		h = h*31 + uint32(c)
	}
	return fmt.Sprintf("%s-%08x", base, h)
}

func leaseDir() string {
	return filepath.Join(RuntimeRoot(), "leases")
}

func leasePath(id string) string {
	return filepath.Join(leaseDir(), id+".json")
}

func projectsRegistryPath() string {
	return filepath.Join(RuntimeRoot(), "projects.json")
}

func statusPath() string {
	return filepath.Join(RuntimeRoot(), "status.json")
}

func runtimeLogPath() string {
	return RuntimeLogPath()
}

// RuntimeLogPath returns the absolute path of the shared runtime daemon log.
func RuntimeLogPath() string {
	return filepath.Join(GlobalRoot(), "logs", "runtime.log")
}

// MCPLogPath returns the absolute path of the MCP server log.
func MCPLogPath() string {
	return filepath.Join(GlobalRoot(), "logs", "mcp.log")
}

func stopFlagPath() string {
	return filepath.Join(RuntimeRoot(), "stop.flag")
}

func reloadRequestPath() string {
	return filepath.Join(RuntimeRoot(), "reload-request.json")
}

func reloadStatusPath() string {
	return filepath.Join(RuntimeRoot(), "reload-status.json")
}

// runningDaemonVersion returns the version persisted by the running daemon in
// status.json. Empty string if the file is missing or unreadable.
func runningDaemonVersion() string {
	raw, err := os.ReadFile(statusPath())
	if err != nil {
		return ""
	}
	var persisted struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &persisted); err != nil {
		return ""
	}
	return persisted.Version
}

// requestDaemonShutdown writes a stop flag and waits up to timeout for the
// daemon to exit. Returns nil once the daemon is gone.
func requestDaemonShutdown(timeout time.Duration) error {
	return RequestShutdown(timeout)
}

// RequestShutdown signals the running daemon to stop via a file flag and waits
// up to timeout for it to exit. Cross-platform alternative to sending signals.
func RequestShutdown(timeout time.Duration) error {
	if err := os.MkdirAll(RuntimeRoot(), 0755); err != nil {
		return err
	}
	if err := os.WriteFile(stopFlagPath(), []byte(time.Now().UTC().Format(time.RFC3339)), 0644); err != nil {
		return err
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !IsRunning() {
			_ = os.Remove(stopFlagPath())
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return errors.New("timed out waiting for outdated runtime to stop")
}

// ShouldStop reports whether the daemon was asked to shut down via stop flag.
func ShouldStop() bool {
	_, err := os.Stat(stopFlagPath())
	return err == nil
}

func RequestReload() (ReloadRequest, error) {
	if err := os.MkdirAll(RuntimeRoot(), 0755); err != nil {
		return ReloadRequest{}, err
	}
	request := ReloadRequest{
		ID:          uuid.NewString(),
		RequestedAt: time.Now().UTC(),
		PID:         os.Getpid(),
	}
	if err := writeJSON(reloadRequestPath(), request); err != nil {
		return ReloadRequest{}, err
	}
	return request, nil
}

func LoadReloadStatus() (ReloadStatus, error) {
	data, err := os.ReadFile(reloadStatusPath())
	if err != nil {
		return ReloadStatus{}, err
	}
	var status ReloadStatus
	if err := json.Unmarshal(data, &status); err != nil {
		return ReloadStatus{}, err
	}
	return status, nil
}

func WaitForReload(requestID string, timeout time.Duration) (ReloadStatus, error) {
	if requestID == "" {
		return ReloadStatus{}, errors.New("reload request id is required")
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	deadline := time.Now().Add(timeout)
	for {
		status, err := LoadReloadStatus()
		if err == nil && status.RequestID == requestID {
			if status.Success {
				return status, nil
			}
			if status.Error != "" {
				return status, errors.New(status.Error)
			}
			return status, errors.New("runtime reload failed")
		}
		if time.Now().After(deadline) {
			return ReloadStatus{}, fmt.Errorf("timed out waiting for runtime reload %s", requestID)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func pendingReload() (ReloadRequest, bool, error) {
	data, err := os.ReadFile(reloadRequestPath())
	if errors.Is(err, os.ErrNotExist) {
		return ReloadRequest{}, false, nil
	}
	if err != nil {
		return ReloadRequest{}, false, err
	}
	var request ReloadRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return ReloadRequest{}, false, err
	}
	if request.ID == "" {
		request.ID = uuid.NewString()
	}
	if request.RequestedAt.IsZero() {
		request.RequestedAt = time.Now().UTC()
	}
	return request, true, nil
}

func acknowledgeReload(ctx context.Context, request ReloadRequest, handler ReloadHandler) (ReloadStatus, error) {
	previous, _ := LoadReloadStatus()
	status := ReloadStatus{
		RequestID:   request.ID,
		Generation:  previous.Generation + 1,
		RequestedAt: request.RequestedAt,
		ProcessedAt: time.Now().UTC(),
		PID:         os.Getpid(),
		Success:     true,
	}
	if handler != nil {
		if err := handler(ctx, status); err != nil {
			status.Success = false
			status.Error = err.Error()
		}
	}
	if err := writeJSON(reloadStatusPath(), status); err != nil {
		return status, err
	}
	removeErr := os.Remove(reloadRequestPath())
	if removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		return status, removeErr
	}
	if !status.Success {
		return status, errors.New(status.Error)
	}
	return status, nil
}

func EnsureDaemon() error {
	if ShouldBypassDaemon() {
		return nil
	}
	if IsRunning() {
		if v := runningDaemonVersion(); v != "" && v != util.Version {
			if err := requestDaemonShutdown(10 * time.Second); err != nil {
				if killErr := forceKillDaemon(); killErr != nil {
					return fmt.Errorf("stop outdated runtime (v%s, want v%s): %w", v, util.Version, err)
				}
				deadline := time.Now().Add(5 * time.Second)
				for time.Now().Before(deadline) {
					if !IsRunning() {
						break
					}
					time.Sleep(100 * time.Millisecond)
				}
				if IsRunning() {
					return fmt.Errorf("stop outdated runtime (v%s, want v%s): %w", v, util.Version, err)
				}
			}
			// Fall through to start new daemon
		} else {
			return nil
		}
	}
	if err := os.MkdirAll(RuntimeRoot(), 0755); err != nil {
		return err
	}
	unlock, err := acquireLock(filepath.Join(RuntimeRoot(), "start.lock"), defaultLockTimeout)
	if err != nil {
		if IsRunning() {
			return nil
		}
		return err
	}
	defer unlock()

	if IsRunning() {
		return nil
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	logFile, err := openRuntimeLogFile()
	if err != nil {
		return err
	}
	defer logFile.Close()

	cmd := exec.Command(exe, "__runtime", "run")
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Stdin = strings.NewReader("")
	setSysProcAttr(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start runtime: %w", err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if IsRunning() {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("timed out waiting for runtime to start")
}

// Enqueue adds incremental background work to the shared runtime queue.
// Full search rebuilds require EnqueueReindex so callers must express intent.
func Enqueue(storeRoot string, kind JobKind, target string) (Job, error) {
	if kind == JobReindex {
		return Job{}, errors.New("full search reindex requires EnqueueReindex")
	}
	return enqueue(storeRoot, kind, target)
}

// EnqueueReindex explicitly requests a user-driven full semantic index rebuild.
func EnqueueReindex(storeRoot string) (Job, error) {
	return enqueue(storeRoot, JobReindex, "")
}

// EnqueueQdrantIntent records one successor-safe targeted reconciliation. The
// durable queue is activated only after the caller has committed history and
// its manifest/outbox. Repeated intents for one entity coalesce to the newest
// generation while preserving a running older generation for completion.
func EnqueueQdrantIntent(storeRoot string, intent QdrantIntent) (Job, error) {
	if storeRoot == "" {
		return Job{}, errors.New("store root is required")
	}
	if strings.TrimSpace(intent.EntityType) == "" || strings.TrimSpace(intent.EntityID) == "" {
		return Job{}, errors.New("qdrant intent entity identity is required")
	}
	if intent.Generation == 0 {
		intent.Generation = uint64(intent.Revision)
		if intent.Generation == 0 {
			intent.Generation = 1
		}
	}
	if err := prepareEnqueue(storeRoot); err != nil {
		return Job{}, err
	}
	var queued Job
	err := updateQueue(storeRoot, func(state *QueueState) error {
		now := time.Now().UTC()
		key := qdrantIntentKey(intent)
		for _, job := range state.Jobs {
			if job.Key != key {
				continue
			}
			if job.Intent != nil && job.Intent.Generation >= intent.Generation {
				queued = *job
				return nil
			}
			intent.Generation = maxUint64(intent.Generation, jobGeneration(job)+1)
			copyIntent := intent
			job.Intent = &copyIntent
			job.RequestedAt = now
			job.RunAfter = now.Add(debounceFor(JobQdrantReconcile))
			job.LastError = ""
			// A running job keeps its StartedAt and is completed against its
			// original generation; CompleteJob retains this newer successor.
			if job.StartedAt == nil {
				job.Attempts = 0
			}
			queued = *job
			return nil
		}
		copyIntent := intent
		queued = Job{ID: newID(), Key: key, Kind: JobQdrantReconcile,
			Target: intent.EntityType + ":" + intent.EntityID, RequestedAt: now,
			RunAfter: now.Add(debounceFor(JobQdrantReconcile)), Intent: &copyIntent}
		state.Jobs = append(state.Jobs, &queued)
		return nil
	})
	return queued, err
}

func qdrantIntentKey(intent QdrantIntent) string {
	return "qdrant:" + intent.EntityType + ":" + intent.EntityID
}

func jobGeneration(job *Job) uint64 {
	if job != nil && job.Intent != nil {
		return job.Intent.Generation
	}
	return 0
}

func maxUint64(a, b uint64) uint64 {
	if a > b {
		return a
	}
	return b
}

func prepareEnqueue(storeRoot string) error {
	if err := os.MkdirAll(filepath.Dir(queuePath(storeRoot)), 0755); err != nil {
		return err
	}
	if err := registerProject(storeRoot); err != nil {
		return err
	}
	return EnsureDaemon()
}

func enqueue(storeRoot string, kind JobKind, target string) (Job, error) {
	if storeRoot == "" {
		return Job{}, errors.New("store root is required")
	}
	if err := prepareEnqueue(storeRoot); err != nil {
		return Job{}, err
	}

	var queued Job
	err := updateQueue(storeRoot, func(state *QueueState) error {
		now := time.Now().UTC()
		key := jobKey(kind, target)
		if state.Jobs == nil {
			state.Jobs = []*Job{}
		}
		for _, job := range state.Jobs {
			if job.Key != key {
				continue
			}
			job.RequestedAt = now
			job.RunAfter = now.Add(debounceFor(kind))
			job.StartedAt = nil
			job.LastError = ""
			queued = *job
			return nil
		}
		queued = Job{
			ID:          newID(),
			Key:         key,
			Kind:        kind,
			Target:      target,
			RequestedAt: now,
			RunAfter:    now.Add(debounceFor(kind)),
		}
		state.Jobs = append(state.Jobs, &queued)
		return nil
	})
	return queued, err
}

func WaitForJob(storeRoot, jobID string, timeout time.Duration) (JobResult, error) {
	return WaitForJobContext(context.Background(), storeRoot, jobID, timeout)
}

// WaitForJobContext waits for one job without blocking cancellation.
func WaitForJobContext(ctx context.Context, storeRoot, jobID string, timeout time.Duration) (JobResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	deadline := time.Now().Add(timeout)
	for {
		select {
		case <-ctx.Done():
			return JobResult{}, ctx.Err()
		default:
		}
		state, err := LoadQueue(storeRoot)
		if err == nil {
			active := false
			for _, job := range state.Jobs {
				if job.ID == jobID {
					active = true
					break
				}
			}
			// A retryable Qdrant failure (or a successor generation) remains
			// active; do not return the older failed Recent result early.
			if active {
				goto waitForJob
			}
			for _, result := range state.Recent {
				if result.JobID == jobID {
					if result.Success {
						return result, nil
					}
					return result, errors.New(result.Error)
				}
			}
		}
	waitForJob:
		if time.Now().After(deadline) {
			return JobResult{}, fmt.Errorf("timed out waiting for runtime job %s", jobID)
		}
		timer := time.NewTimer(200 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return JobResult{}, ctx.Err()
		case <-timer.C:
		}
	}
}

func LoadQueue(storeRoot string) (*QueueState, error) {
	path := queuePath(storeRoot)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return &QueueState{Jobs: []*Job{}, Recent: []JobResult{}}, nil
	}
	if err != nil {
		return nil, err
	}
	var state QueueState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, err
	}
	if state.Jobs == nil {
		state.Jobs = []*Job{}
	}
	if state.Recent == nil {
		state.Recent = []JobResult{}
	}
	return &state, nil
}

func MarkJobStarted(storeRoot, jobID string) (Job, error) {
	var started Job
	err := updateQueue(storeRoot, func(state *QueueState) error {
		for _, job := range state.Jobs {
			if job.ID != jobID {
				continue
			}
			now := time.Now().UTC()
			job.StartedAt = &now
			job.Attempts++
			started = *job
			return nil
		}
		return fmt.Errorf("job %s not found", jobID)
	})
	return started, err
}

// ReportProgress updates the phase / processed / total fields of a queued job.
// Safe to call frequently; errors are non-fatal for callers.
func ReportProgress(storeRoot, jobID, phase string, processed, total int) error {
	return updateQueue(storeRoot, func(state *QueueState) error {
		for _, job := range state.Jobs {
			if job.ID != jobID {
				continue
			}
			if phase != "" {
				job.Phase = phase
			}
			job.Processed = processed
			job.Total = total
			return nil
		}
		return nil
	})
}

// ReportDetails stores structured completion details on a running job.
// Called by executors before returning so CompleteJob can carry them into JobResult.
func ReportDetails(storeRoot, jobID string, details JobDetails) error {
	return updateQueue(storeRoot, func(state *QueueState) error {
		for _, job := range state.Jobs {
			if job.ID != jobID {
				continue
			}
			job.Details = &details
			return nil
		}
		return nil
	})
}

func CompleteJob(storeRoot string, job Job, err error) error {
	return updateQueue(storeRoot, func(state *QueueState) error {
		finalJob := job
		jobs := make([]*Job, 0, len(state.Jobs))
		var queuedCurrent *Job
		for _, queued := range state.Jobs {
			if queued.ID != job.ID {
				jobs = append(jobs, queued)
				continue
			}
			queuedCurrent = queued
			finalJob = *queued
		}
		// A newer intent may have arrived while this generation was running.
		// Keep it queued as a successor instead of removing it with the older
		// completion. The successor starts fresh and is observable in status.
		if queuedCurrent != nil && job.Intent != nil && queuedCurrent.Intent != nil && queuedCurrent.Intent.Generation > job.Intent.Generation {
			copyJob := *queuedCurrent
			copyJob.StartedAt = nil
			copyJob.Attempts = 0
			copyJob.LastError = ""
			copyJob.RunAfter = time.Now().UTC()
			jobs = append(jobs, &copyJob)
		}
		state.Jobs = jobs
		startedAt := finalJob.RequestedAt
		if finalJob.StartedAt != nil {
			startedAt = *finalJob.StartedAt
		}
		result := JobResult{
			JobID:        finalJob.ID,
			Key:          finalJob.Key,
			Kind:         finalJob.Kind,
			Target:       finalJob.Target,
			Success:      err == nil,
			CompletedAt:  time.Now().UTC(),
			RequestedAt:  finalJob.RequestedAt,
			StartedAt:    startedAt,
			AttemptCount: finalJob.Attempts,
		}
		if err != nil {
			result.Error = err.Error()
		}
		if finalJob.Kind == JobQdrantReconcile && err != nil {
			result.Retryable = true
			if finalJob.Attempts >= qdrantRetryLimit {
				result.DeadLetter = true
				result.Retryable = false
				copyJob := finalJob
				copyJob.StartedAt = nil
				copyJob.LastError = err.Error()
				copyJob.DeadLetter = true
				copyJob.RunAfter = time.Now().UTC().Add(24 * time.Hour)
				jobs = append(jobs, &copyJob)
				state.Jobs = jobs
			} else if !(queuedCurrent != nil && job.Intent != nil && queuedCurrent.Intent != nil && queuedCurrent.Intent.Generation > job.Intent.Generation) {
				// Retain the failed Qdrant intent with bounded exponential
				// backoff. A future daemon tick or restart can retry it.
				copyJob := finalJob
				copyJob.StartedAt = nil
				copyJob.LastError = err.Error()
				copyJob.RunAfter = time.Now().UTC().Add(qdrantRetryDelay(finalJob.Attempts))
				jobs = append(jobs, &copyJob)
				state.Jobs = jobs
			}
		}
		result.Details = finalJob.Details
		if result.Details == nil && (finalJob.Phase != "" || finalJob.Processed > 0) {
			result.Details = &JobDetails{
				Phase:     finalJob.Phase,
				Processed: finalJob.Processed,
				Total:     finalJob.Total,
			}
		}
		state.Recent = append([]JobResult{result}, state.Recent...)
		if len(state.Recent) > maxRecentResults {
			state.Recent = state.Recent[:maxRecentResults]
		}
		return nil
	})
}

// RetryJob explicitly releases a retained Qdrant dead-letter job. It is
// intentionally narrow: generic background failures retain their historical
// terminal behavior and cannot be accidentally replayed.
func RetryJob(storeRoot, jobID string) (Job, error) {
	var retried Job
	err := updateQueue(storeRoot, func(state *QueueState) error {
		for _, job := range state.Jobs {
			if job.ID != jobID {
				continue
			}
			if job.Kind != JobQdrantReconcile || !job.DeadLetter {
				return fmt.Errorf("job %s is not a qdrant dead letter", jobID)
			}
			job.DeadLetter = false
			job.Attempts = 0
			job.LastError = ""
			job.RunAfter = time.Now().UTC()
			retried = *job
			return nil
		}
		return fmt.Errorf("job %s not found", jobID)
	})
	return retried, err
}

func qdrantRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := time.Second * time.Duration(1<<(attempt-1))
	if delay > 5*time.Minute {
		return 5 * time.Minute
	}
	return delay
}

func AcquireClient(kind, projectRoot string, watch bool) (*ClientHandle, error) {
	if projectRoot == "" {
		return nil, errors.New("project root is required")
	}
	if err := os.MkdirAll(leaseDir(), 0755); err != nil {
		return nil, err
	}
	if err := registerProject(projectRoot); err != nil {
		return nil, err
	}
	if err := EnsureDaemon(); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	handle := &ClientHandle{lease: Lease{
		ID:          newID(),
		ClientKind:  kind,
		ProjectRoot: projectRoot,
		Watch:       watch,
		PID:         os.Getpid(),
		CreatedAt:   now,
		UpdatedAt:   now,
		ExpiresAt:   now.Add(leaseTTL()),
	}}
	return handle, handle.Refresh()
}

// AcquireConfiguredClient preserves AcquireClient's lease contract while
// deriving watch demand from project runtimeWatch settings for eligible
// long-lived clients such as MCP.
func AcquireConfiguredClient(kind, projectRoot string) (*ClientHandle, error) {
	return AcquireClient(kind, projectRoot, WatchEnabledForClient(kind, projectRoot))
}

// WatchEnabledForClient reports whether a client should request project
// knowledge watching. An explicit KNOWNS_RUNTIME_WATCH_ENABLED environment
// override wins over project configuration.
func WatchEnabledForClient(kind, projectRoot string) bool {
	if raw := os.Getenv("KNOWNS_RUNTIME_WATCH_ENABLED"); raw != "" {
		return parseBool(raw, true)
	}
	settings := models.DefaultRuntimeWatchSettings()
	if projectRoot != "" {
		data, err := os.ReadFile(filepath.Join(projectRoot, "config.json"))
		if err == nil {
			var project models.Project
			if json.Unmarshal(data, &project) == nil {
				settings = project.Settings.EffectiveRuntimeWatch()
			}
		}
	}
	if settings.Enabled != nil && !*settings.Enabled {
		return false
	}
	for _, eligible := range settings.EligibleClients {
		if strings.EqualFold(strings.TrimSpace(eligible), kind) || strings.TrimSpace(eligible) == "*" {
			return true
		}
	}
	return false
}

func (h *ClientHandle) Refresh() error {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	if h.released {
		h.mu.Unlock()
		return nil
	}
	now := time.Now().UTC()
	h.lease.UpdatedAt = now
	h.lease.ExpiresAt = now.Add(leaseTTL())
	data, err := json.MarshalIndent(h.lease, "", "  ")
	if err != nil {
		h.mu.Unlock()
		return err
	}
	err = os.WriteFile(leasePath(h.lease.ID), append(data, '\n'), 0644)
	h.mu.Unlock()
	return err
}

func (h *ClientHandle) Release() error {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	if h.released {
		h.mu.Unlock()
		return nil
	}
	h.released = true
	id := h.lease.ID
	h.mu.Unlock()
	err := os.Remove(leasePath(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func StartHeartbeat(ctx context.Context, handle *ClientHandle) {
	if handle == nil {
		return
	}
	ticker := time.NewTicker(leaseTTL() / 2)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = handle.Release()
				return
			case <-ticker.C:
				_ = handle.Refresh()
			}
		}
	}()
}

func LoadStatus() (*Status, error) {
	status := &Status{Clients: []Lease{}, Project: []ProjectStatus{}}
	pid, err := readPID()
	if err == nil {
		status.Running = isProcessAlive(pid)
		status.PID = pid
	}
	if raw, readErr := os.ReadFile(statusPath()); readErr == nil {
		var persisted struct {
			Version  string          `json:"version"`
			Watchers []WatcherStatus `json:"watchers"`
		}
		if jsonErr := json.Unmarshal(raw, &persisted); jsonErr == nil {
			status.Version = persisted.Version
			status.Watchers = persisted.Watchers
		}
	}
	leases, _ := ActiveLeases()
	status.Clients = leases
	projects, _ := registeredProjects()
	for _, projectRoot := range projects {
		queue, err := LoadQueue(projectRoot)
		if err != nil {
			continue
		}
		queued := 0
		running := 0
		for _, job := range queue.Jobs {
			if job.StartedAt != nil {
				running++
			} else {
				queued++
			}
		}
		status.Project = append(status.Project, ProjectStatus{ProjectRoot: projectRoot, QueuedJobs: queued, RunningJobs: running})
	}
	return status, nil
}

func ActiveLeases() ([]Lease, error) {
	if err := os.MkdirAll(leaseDir(), 0755); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(leaseDir())
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	leases := make([]Lease, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(leaseDir(), entry.Name()))
		if err != nil {
			continue
		}
		var lease Lease
		if err := json.Unmarshal(data, &lease); err != nil {
			continue
		}
		if !lease.ExpiresAt.After(now) {
			_ = os.Remove(filepath.Join(leaseDir(), entry.Name()))
			continue
		}
		if lease.PID > 0 && !isProcessAlive(lease.PID) {
			_ = os.Remove(filepath.Join(leaseDir(), entry.Name()))
			continue
		}
		leases = append(leases, lease)
	}
	sort.Slice(leases, func(i, j int) bool {
		if leases[i].ProjectRoot == leases[j].ProjectRoot {
			return leases[i].ID < leases[j].ID
		}
		return leases[i].ProjectRoot < leases[j].ProjectRoot
	})
	return leases, nil
}

func RunDaemon(ctx context.Context, executor Executor, watcherFactory WatcherFactory) error {
	return RunDaemonWithOptions(ctx, DaemonOptions{
		Executor:       executor,
		WatcherFactory: watcherFactory,
	})
}

func RunDaemonWithOptions(ctx context.Context, opts DaemonOptions) error {
	executor := opts.Executor
	watcherFactory := opts.WatcherFactory
	if executor == nil {
		return errors.New("runtime executor is required")
	}
	if err := os.MkdirAll(RuntimeRoot(), 0755); err != nil {
		return err
	}
	if err := writePID(os.Getpid()); err != nil {
		return err
	}
	defer os.Remove(PIDFile())
	_ = os.Remove(stopFlagPath())

	watchLifecycle := NewWatchLifecycle(nil, projectWatchGracePeriod)
	defer watchLifecycle.Stop()
	ticker := time.NewTicker(defaultPollInterval)
	defer ticker.Stop()
	var running *activeJob
	var idleSince time.Time

	for {
		leases, _ := ActiveLeases()
		projects, _ := registeredProjects()
		for _, lease := range leases {
			projects = appendIfMissing(projects, lease.ProjectRoot)
		}
		watchLifecycle.Reconcile(leases, watcherFactory)
		watcherStates := watchLifecycle.Status(leases)

		pendingJobs := 0
		if running == nil {
			request, found, err := pendingReload()
			if err != nil {
				log.Printf("[runtime] reload request unreadable: %v", err)
			} else if found {
				if _, err := acknowledgeReload(ctx, request, opts.ReloadHandler); err != nil {
					log.Printf("[runtime] reload failed: %v", err)
				}
				_ = writeStatusFile(leases, projects, watcherStates)
				continue
			}
			nextStore, nextJob, found := nextReadyJob(projects)
			if found {
				started, err := MarkJobStarted(nextStore, nextJob.ID)
				if err == nil {
					resultCh := make(chan error, 1)
					running = &activeJob{storeRoot: nextStore, job: started, resultCh: resultCh}
					go func(storeRoot string, job Job) {
						resultCh <- executor(storeRoot, job)
					}(nextStore, started)
				}
			}
		}
		for _, projectRoot := range projects {
			queue, err := LoadQueue(projectRoot)
			if err != nil {
				continue
			}
			pendingJobs += len(queue.Jobs)
		}

		_ = writeStatusFile(leases, projects, watcherStates)

		if ShouldStop() {
			_ = os.Remove(stopFlagPath())
			return nil
		}

		if len(leases) == 0 && pendingJobs == 0 && running == nil && !watchLifecycle.hasActiveOrGrace() {
			if idleSince.IsZero() {
				idleSince = time.Now().UTC()
			} else if time.Since(idleSince) >= idleTimeout() {
				return nil
			}
		} else {
			idleSince = time.Time{}
		}

		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		case err := <-runningResult(running):
			_ = CompleteJob(running.storeRoot, running.job, err)
			running = nil
		}
	}
}

func runningResult(running *activeJob) <-chan error {
	if running == nil {
		return nil
	}
	return running.resultCh
}

func reconcileWatchers(watchers map[string]context.CancelFunc, watchProjects map[string]bool, watcherFactory WatcherFactory) {
	for projectRoot, cancel := range watchers {
		if watchProjects[projectRoot] {
			continue
		}
		cancel()
		delete(watchers, projectRoot)
	}
	if watcherFactory == nil {
		return
	}
	for projectRoot := range watchProjects {
		if _, ok := watchers[projectRoot]; ok {
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		watchers[projectRoot] = cancel
		go func(storeRoot string) {
			if err := watcherFactory(ctx, storeRoot); err != nil && !errors.Is(err, context.Canceled) {
				log.Printf("[runtime] watcher failed for %s: %v", storeRoot, err)
			}
		}(projectRoot)
	}
}

func stopAllWatchers(watchers map[string]context.CancelFunc) {
	for key, cancel := range watchers {
		cancel()
		delete(watchers, key)
	}
}

func nextReadyJob(projects []string) (string, Job, bool) {
	now := time.Now().UTC()
	var chosenStore string
	var chosen Job
	found := false
	for _, projectRoot := range projects {
		queue, err := LoadQueue(projectRoot)
		if err != nil {
			continue
		}
		for _, job := range queue.Jobs {
			if job.DeadLetter {
				continue
			}
			if job.RunAfter.After(now) {
				continue
			}
			if !found || job.RunAfter.Before(chosen.RunAfter) || (job.RunAfter.Equal(chosen.RunAfter) && job.RequestedAt.Before(chosen.RequestedAt)) {
				chosenStore = projectRoot
				chosen = *job
				found = true
			}
		}
	}
	return chosenStore, chosen, found
}

func IsRunning() bool {
	pid, err := readPID()
	if err != nil {
		return false
	}
	return isProcessAlive(pid)
}

func readPID() (int, error) {
	data, err := os.ReadFile(PIDFile())
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(data)))
}

func writePID(pid int) error {
	if err := os.MkdirAll(filepath.Dir(PIDFile()), 0755); err != nil {
		return err
	}
	return os.WriteFile(PIDFile(), []byte(strconv.Itoa(pid)), 0644)
}

func registerProject(storeRoot string) error {
	unlock, err := acquireLock(projectsRegistryPath()+".lock", defaultLockTimeout)
	if err != nil {
		return err
	}
	defer unlock()
	projects, err := registeredProjects()
	if err != nil {
		return err
	}
	projects = appendIfMissing(projects, storeRoot)
	sort.Strings(projects)
	return writeJSON(projectsRegistryPath(), projects)
}

func registeredProjects() ([]string, error) {
	data, err := os.ReadFile(projectsRegistryPath())
	if errors.Is(err, os.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var projects []string
	if err := json.Unmarshal(data, &projects); err != nil {
		return nil, err
	}
	filtered := projects[:0]
	for _, project := range projects {
		if project == "" {
			continue
		}
		filtered = appendIfMissing(filtered, project)
	}
	return filtered, nil
}

func updateQueue(storeRoot string, fn func(*QueueState) error) error {
	lockPath := queuePath(storeRoot) + ".lock"
	unlock, err := acquireLock(lockPath, defaultLockTimeout)
	if err != nil {
		return err
	}
	defer unlock()

	state, err := LoadQueue(storeRoot)
	if err != nil {
		return err
	}
	if err := fn(state); err != nil {
		return err
	}
	state.Updated = time.Now().UTC()
	return writeJSON(queuePath(storeRoot), state)
}

func writeStatusFile(leases []Lease, projects []string, watcherStates ...[]WatcherStatus) error {
	var watchers []WatcherStatus
	if len(watcherStates) > 0 {
		watchers = watcherStates[0]
	}
	status := struct {
		PID       int             `json:"pid"`
		Version   string          `json:"version,omitempty"`
		UpdatedAt time.Time       `json:"updatedAt"`
		Projects  []string        `json:"projects"`
		Clients   []Lease         `json:"clients"`
		Watchers  []WatcherStatus `json:"watchers,omitempty"`
	}{
		PID:       os.Getpid(),
		Version:   util.Version,
		UpdatedAt: time.Now().UTC(),
		Projects:  projects,
		Clients:   leases,
		Watchers:  watchers,
	}
	return writeJSON(statusPath(), status)
}

func acquireLock(path string, timeout time.Duration) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err == nil {
			_, _ = file.WriteString(strconv.Itoa(os.Getpid()))
			_ = file.Close()
			return func() { _ = os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > defaultLockStaleAge {
			_ = os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("timed out waiting for lock %s", path)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func writeJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func openRuntimeLogFile() (*os.File, error) {
	path := runtimeLogPath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, err
	}
	rotateLogFiles(path, defaultLogMaxBytes, defaultLogBackups)
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
}

func rotateLogFiles(path string, maxBytes int64, backups int) {
	info, err := os.Stat(path)
	if err != nil || info.Size() < maxBytes {
		return
	}
	_ = os.Remove(fmt.Sprintf("%s.%d", path, backups))
	for i := backups - 1; i >= 1; i-- {
		_ = os.Rename(fmt.Sprintf("%s.%d", path, i), fmt.Sprintf("%s.%d", path, i+1))
	}
	_ = os.Rename(path, path+".1")
}

func debounceFor(kind JobKind) time.Duration {
	if kind == JobSemanticSearch {
		return 0
	}
	switch kind {
	case JobRemoveTask, JobRemoveDoc, JobRemoveMemory, JobRemoveFile, JobIndexAll, JobReindex:
		return 0
	case JobIndexFile:
		return durationFromEnvMs("KNOWNS_CODE_INDEX_DEBOUNCE_MS", 1000)
	default:
		return durationFromEnvMs("KNOWNS_ENTITY_INDEX_DEBOUNCE_MS", 5000)
	}
}

func idleTimeout() time.Duration {
	return durationFromEnvMs("KNOWNS_RUNTIME_IDLE_TIMEOUT_MS", int(defaultIdleTimeout/time.Millisecond))
}

func leaseTTL() time.Duration {
	return durationFromEnvMs("KNOWNS_RUNTIME_LEASE_TTL_MS", int(defaultLeaseTTL/time.Millisecond))
}

func watchGracePeriod() time.Duration {
	return durationFromEnvMs("KNOWNS_RUNTIME_WATCH_GRACE_MS", int(defaultWatchGrace/time.Millisecond))
}

func projectWatchGracePeriod(projectRoot string) time.Duration {
	grace := watchGracePeriod()
	if projectRoot == "" {
		return grace
	}
	data, err := os.ReadFile(filepath.Join(projectRoot, "config.json"))
	if err != nil {
		return grace
	}
	var project models.Project
	if err := json.Unmarshal(data, &project); err != nil {
		return grace
	}
	configured := project.Settings.EffectiveRuntimeWatch().GracePeriod
	if configured == "" {
		return grace
	}
	parsed, err := time.ParseDuration(configured)
	if err != nil || parsed < 0 {
		return grace
	}
	return parsed
}

func parseBool(value string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func durationFromEnvMs(key string, defaultMs int) time.Duration {
	if raw := os.Getenv(key); raw != "" {
		ms, err := strconv.Atoi(raw)
		if err == nil {
			if ms <= 0 {
				return 0
			}
			return time.Duration(ms) * time.Millisecond
		}
	}
	return time.Duration(defaultMs) * time.Millisecond
}

func jobKey(kind JobKind, target string) string {
	return string(kind) + "::" + target
}

func appendIfMissing(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func newID() string {
	return uuid.NewString()
}
