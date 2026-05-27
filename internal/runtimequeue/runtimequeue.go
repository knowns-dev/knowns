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

	"github.com/howznguyen/knowns/internal/util"
)

type JobKind string

const (
	JobIndexTask    JobKind = "index-task"
	JobIndexDoc     JobKind = "index-doc"
	JobRemoveTask   JobKind = "remove-task"
	JobRemoveDoc    JobKind = "remove-doc"
	JobIndexMemory  JobKind = "index-memory"
	JobRemoveMemory JobKind = "remove-memory"
	JobIndexAll     JobKind = "index-all-files"
	JobIndexFile    JobKind = "index-file"
	JobRemoveFile   JobKind = "remove-file"
	JobReindex      JobKind = "reindex-search"
)

const (
	defaultPollInterval = 500 * time.Millisecond
	defaultIdleTimeout  = 15 * time.Second
	defaultLeaseTTL     = 20 * time.Second
	defaultLockTimeout  = 3 * time.Second
	defaultLockStaleAge = 10 * time.Second
	maxRecentResults    = 50
	defaultLogMaxBytes  = 10 * 1024 * 1024
	defaultLogBackups   = 3
)

type Job struct {
	ID          string     `json:"id"`
	Key         string     `json:"key"`
	Kind        JobKind    `json:"kind"`
	Target      string     `json:"target,omitempty"`
	RequestedAt time.Time  `json:"requestedAt"`
	RunAfter    time.Time  `json:"runAfter"`
	StartedAt   *time.Time `json:"startedAt,omitempty"`
	Attempts    int        `json:"attempts,omitempty"`
	LastError   string     `json:"lastError,omitempty"`
	Phase       string      `json:"phase,omitempty"`
	Processed   int         `json:"processed,omitempty"`
	Total       int         `json:"total,omitempty"`
	Details     *JobDetails `json:"details,omitempty"`
}

type JobDetails struct {
	Phase     string         `json:"phase,omitempty"`
	Processed int            `json:"processed,omitempty"`
	Total     int            `json:"total,omitempty"`
	Stats     map[string]int `json:"stats,omitempty"`
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
	lease Lease
}

type ProjectStatus struct {
	ProjectRoot string `json:"projectRoot"`
	QueuedJobs  int    `json:"queuedJobs"`
	RunningJobs int    `json:"runningJobs"`
}

type Status struct {
	Running bool            `json:"running"`
	PID     int             `json:"pid,omitempty"`
	Version string          `json:"version,omitempty"`
	Clients []Lease         `json:"clients"`
	Project []ProjectStatus `json:"projects"`
}

type Executor func(storeRoot string, job Job) error

type WatcherFactory func(ctx context.Context, storeRoot string) error

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
	return strings.HasSuffix(os.Args[0], ".test")
}

func GlobalRoot() string {
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

func Enqueue(storeRoot string, kind JobKind, target string) (Job, error) {
	if storeRoot == "" {
		return Job{}, errors.New("store root is required")
	}
	if err := os.MkdirAll(filepath.Dir(queuePath(storeRoot)), 0755); err != nil {
		return Job{}, err
	}
	if err := registerProject(storeRoot); err != nil {
		return Job{}, err
	}
	if err := EnsureDaemon(); err != nil {
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
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	deadline := time.Now().Add(timeout)
	for {
		state, err := LoadQueue(storeRoot)
		if err == nil {
			for _, result := range state.Recent {
				if result.JobID == jobID {
					if result.Success {
						return result, nil
					}
					return result, errors.New(result.Error)
				}
			}
		}
		if time.Now().After(deadline) {
			return JobResult{}, fmt.Errorf("timed out waiting for runtime job %s", jobID)
		}
		time.Sleep(200 * time.Millisecond)
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
		jobs := state.Jobs[:0]
		for _, queued := range state.Jobs {
			if queued.ID != job.ID {
				jobs = append(jobs, queued)
			}
		}
		state.Jobs = jobs
		startedAt := job.RequestedAt
		if job.StartedAt != nil {
			startedAt = *job.StartedAt
		}
		result := JobResult{
			JobID:        job.ID,
			Key:          job.Key,
			Kind:         job.Kind,
			Target:       job.Target,
			Success:      err == nil,
			CompletedAt:  time.Now().UTC(),
			RequestedAt:  job.RequestedAt,
			StartedAt:    startedAt,
			AttemptCount: job.Attempts,
		}
		if err != nil {
			result.Error = err.Error()
		}
		result.Details = job.Details
		if result.Details == nil && (job.Phase != "" || job.Processed > 0) {
			result.Details = &JobDetails{
				Phase:     job.Phase,
				Processed: job.Processed,
				Total:     job.Total,
			}
		}
		state.Recent = append([]JobResult{result}, state.Recent...)
		if len(state.Recent) > maxRecentResults {
			state.Recent = state.Recent[:maxRecentResults]
		}
		return nil
	})
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

func (h *ClientHandle) Refresh() error {
	if h == nil {
		return nil
	}
	now := time.Now().UTC()
	h.lease.UpdatedAt = now
	h.lease.ExpiresAt = now.Add(leaseTTL())
	data, err := json.MarshalIndent(h.lease, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(leasePath(h.lease.ID), append(data, '\n'), 0644)
}

func (h *ClientHandle) Release() error {
	if h == nil {
		return nil
	}
	return os.Remove(leasePath(h.lease.ID))
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
			Version string `json:"version"`
		}
		if jsonErr := json.Unmarshal(raw, &persisted); jsonErr == nil {
			status.Version = persisted.Version
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

	watchers := map[string]context.CancelFunc{}
	ticker := time.NewTicker(defaultPollInterval)
	defer ticker.Stop()
	var running *activeJob
	var idleSince time.Time

	for {
		leases, _ := ActiveLeases()
		projects, _ := registeredProjects()
		watchProjects := map[string]bool{}
		for _, lease := range leases {
			if lease.Watch {
				watchProjects[lease.ProjectRoot] = true
			}
			projects = appendIfMissing(projects, lease.ProjectRoot)
		}
		reconcileWatchers(watchers, watchProjects, watcherFactory)

		pendingJobs := 0
		if running == nil {
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

		_ = writeStatusFile(leases, projects)

		if ShouldStop() {
			stopAllWatchers(watchers)
			_ = os.Remove(stopFlagPath())
			return nil
		}

		if len(leases) == 0 && pendingJobs == 0 && running == nil {
			if idleSince.IsZero() {
				idleSince = time.Now().UTC()
			} else if time.Since(idleSince) >= idleTimeout() {
				stopAllWatchers(watchers)
				return nil
			}
		} else {
			idleSince = time.Time{}
		}

		select {
		case <-ctx.Done():
			stopAllWatchers(watchers)
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

func writeStatusFile(leases []Lease, projects []string) error {
	status := struct {
		PID       int       `json:"pid"`
		Version   string    `json:"version,omitempty"`
		UpdatedAt time.Time `json:"updatedAt"`
		Projects  []string  `json:"projects"`
		Clients   []Lease   `json:"clients"`
	}{
		PID:       os.Getpid(),
		Version:   util.Version,
		UpdatedAt: time.Now().UTC(),
		Projects:  projects,
		Clients:   leases,
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
	return fmt.Sprintf("%d-%d", time.Now().UnixNano(), os.Getpid())
}
