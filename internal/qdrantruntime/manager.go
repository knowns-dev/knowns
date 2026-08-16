package qdrantruntime

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

const (
	DefaultHTTPPort = 6333
	DefaultGRPCPort = 6334

	StatusRunning      = "running"
	StatusStopped      = "stopped"
	StatusStale        = "stale"
	StatusExternal     = "external"
	StatusDisabled     = "disabled"
	StatusNotInstalled = "not-installed"
)

// Config describes either a managed local Qdrant runtime or an external Qdrant
// endpoint. Managed process ownership is used only when Backend=qdrant and
// Mode=managed.
type Config struct {
	Enabled     bool
	Backend     string
	Mode        string
	Root        string
	ExternalURL string
	BinaryPath  string
	HTTPPort    int
	GRPCPort    int
}

// Paths is the canonical managed Qdrant runtime layout under
// ~/.knowns/runtime/qdrant (spec qdrant-default-vector-backend, D2/AC-2).
type Paths struct {
	Root         string `json:"root"`
	BinDir       string `json:"binDir"`
	BinaryPath   string `json:"binaryPath"`
	DataDir      string `json:"dataDir"`
	LogsDir      string `json:"logsDir"`
	LogPath      string `json:"logPath"`
	PIDPath      string `json:"pidPath"`
	StatusPath   string `json:"statusPath"`
	SnapshotsDir string `json:"snapshotsDir"`
}

// Status is written to status.json and rendered by `knowns qdrant status`.
type Status struct {
	Enabled     bool      `json:"enabled"`
	Backend     string    `json:"backend"`
	Mode        string    `json:"mode"`
	Managed     bool      `json:"managed"`
	State       string    `json:"state"`
	Running     bool      `json:"running"`
	Installed   bool      `json:"installed"`
	PID         int       `json:"pid,omitempty"`
	Endpoint    string    `json:"endpoint,omitempty"`
	ExternalURL string    `json:"externalURL,omitempty"`
	Message     string    `json:"message,omitempty"`
	Paths       Paths     `json:"paths"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// ProcessController abstracts process start/stop/liveness so tests never need
// a real qdrant binary.
type ProcessController interface {
	Start(ctx context.Context, binary string, args []string, env []string, stdout, stderr io.Writer) (int, error)
	Stop(pid int, timeout time.Duration) error
	Alive(pid int) bool
}

// Manager controls the managed Qdrant process metadata and process lifecycle.
type Manager struct {
	Config           Config
	Controller       ProcessController
	Now              func() time.Time
	HealthCheck      func(context.Context, string) error
	ReadinessTimeout time.Duration
}

// DefaultConfig returns managed Qdrant defaults rooted at
// ~/.knowns/runtime/qdrant.
func DefaultConfig() Config {
	return Config{
		Enabled:  true,
		Backend:  models.SemanticVectorBackendQdrant,
		Mode:     models.SemanticVectorStoreModeManaged,
		Root:     DefaultRoot(),
		HTTPPort: DefaultHTTPPort,
		GRPCPort: DefaultGRPCPort,
	}
}

// ConfigFromResolution maps semantic vector-store resolution into Qdrant
// runtime configuration.
func ConfigFromResolution(res models.SemanticVectorStoreResolution) Config {
	cfg := DefaultConfig()
	cfg.Enabled = res.Enabled
	cfg.Backend = res.Backend
	cfg.Mode = res.Mode
	cfg.ExternalURL = res.ExternalURL
	if res.ManagedRoot != "" {
		cfg.Root = ExpandPath(res.ManagedRoot)
	}
	return cfg
}

// DefaultRoot returns ~/.knowns/runtime/qdrant.
func DefaultRoot() string {
	return filepath.Join(storage.GlobalRootPath(), "runtime", "qdrant")
}

// ExpandPath expands a leading ~ in config paths.
func ExpandPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		home := storage.GlobalRootPath()
		// storage.GlobalRootPath returns ~/.knowns, so use its parent as $HOME.
		home = filepath.Dir(home)
		if path == "~" {
			return home
		}
		return filepath.Join(home, strings.TrimPrefix(path, "~/"))
	}
	return path
}

// PathsForRoot returns the canonical qdrant runtime layout for root.
func PathsForRoot(root string) Paths {
	root = ExpandPath(root)
	if root == "" {
		root = DefaultRoot()
	}
	binDir := filepath.Join(root, "bin")
	binaryName := "qdrant"
	if filepath.Ext(binaryName) == "" && runtime.GOOS == "windows" {
		binaryName += ".exe"
	}
	return Paths{
		Root:         root,
		BinDir:       binDir,
		BinaryPath:   filepath.Join(binDir, binaryName),
		DataDir:      filepath.Join(root, "data"),
		LogsDir:      filepath.Join(root, "logs"),
		LogPath:      filepath.Join(root, "logs", "qdrant.log"),
		PIDPath:      filepath.Join(root, "qdrant.pid"),
		StatusPath:   filepath.Join(root, "status.json"),
		SnapshotsDir: filepath.Join(root, "snapshots"),
	}
}

// NewManager creates a manager with default process control.
func NewManager(cfg Config) *Manager {
	if cfg.Root == "" {
		cfg.Root = DefaultRoot()
	}
	if cfg.HTTPPort == 0 {
		cfg.HTTPPort = DefaultHTTPPort
	}
	if cfg.GRPCPort == 0 {
		cfg.GRPCPort = DefaultGRPCPort
	}
	if cfg.Backend == "" {
		cfg.Backend = models.SemanticVectorBackendQdrant
	}
	if cfg.Mode == "" {
		cfg.Mode = models.SemanticVectorStoreModeManaged
	}
	return &Manager{Config: cfg, Controller: defaultProcessController{}, Now: time.Now, HealthCheck: defaultHealthCheck, ReadinessTimeout: 20 * time.Second}
}

// Paths returns this manager's managed runtime paths.
func (m *Manager) Paths() Paths {
	paths := PathsForRoot(m.Config.Root)
	if m.Config.BinaryPath != "" {
		paths.BinaryPath = ExpandPath(m.Config.BinaryPath)
		paths.BinDir = filepath.Dir(paths.BinaryPath)
	}
	return paths
}

// EnsureDirs creates managed runtime directories. It never creates vector data
// in project .knowns; all directories are under the managed root.
func (m *Manager) EnsureDirs() error {
	paths := m.Paths()
	for _, dir := range []string{paths.Root, paths.BinDir, paths.DataDir, paths.LogsDir, paths.SnapshotsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create qdrant runtime dir %s: %w", dir, err)
		}
	}
	return nil
}

// Status inspects runtime state without starting or stopping any process.
func (m *Manager) Status(ctx context.Context) (Status, error) {
	_ = ctx
	return m.statusWithMessage(""), nil
}

// ProbeHealth performs one bounded, read-only health request for a managed
// runtime. It never starts, stops, installs, or writes Qdrant metadata.
func (m *Manager) ProbeHealth(ctx context.Context) error {
	if m.isExternal() {
		return fmt.Errorf("managed Qdrant health probe is not applicable in external mode")
	}
	check := m.HealthCheck
	if check == nil {
		check = defaultHealthCheck
	}
	return check(ctx, managedEndpoint(m.Config.HTTPPort))
}

// Start starts managed Qdrant if needed. External mode is a visible no-op.
func (m *Manager) Start(ctx context.Context) (Status, error) {
	if m.isExternal() {
		status := m.statusWithMessage("external Qdrant URL configured; managed process start bypassed")
		_ = m.writeStatus(status)
		return status, nil
	}
	if !m.Config.Enabled || m.Config.Backend != models.SemanticVectorBackendQdrant {
		status := m.statusWithMessage("semantic Qdrant backend is disabled")
		_ = m.writeStatus(status)
		return status, nil
	}
	if err := m.EnsureDirs(); err != nil {
		return Status{}, err
	}
	status := m.statusWithMessage("")
	if status.Running {
		if err := m.waitForReady(ctx, status.Endpoint); err == nil {
			status.Message = "managed Qdrant already running and healthy"
			_ = m.writeStatus(status)
			return status, nil
		} else {
			stopErr := m.controller().Stop(status.PID, 10*time.Second)
			_ = os.Remove(status.Paths.PIDPath)
			status.Running, status.PID, status.State = false, 0, StatusStopped
			status.Message = "managed Qdrant process was running but failed HTTP readiness; inspect logs: knowns qdrant logs"
			_ = m.writeStatus(status)
			if stopErr != nil {
				return status, fmt.Errorf("existing Qdrant failed /healthz: %w; cleanup process: %v; inspect %s", err, stopErr, status.Paths.LogPath)
			}
			return status, fmt.Errorf("existing Qdrant failed /healthz: %w; inspect %s or run `knowns qdrant logs`", err, status.Paths.LogPath)
		}
	}
	if !status.Installed {
		status.State = StatusNotInstalled
		status.Message = "managed Qdrant binary not installed; run an explicit install/repair command"
		_ = m.writeStatus(status)
		return status, fmt.Errorf("managed Qdrant binary not found at %s", status.Paths.BinaryPath)
	}
	logFile, err := os.OpenFile(status.Paths.LogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return Status{}, fmt.Errorf("open qdrant log: %w", err)
	}
	defer logFile.Close()
	pid, err := m.controller().Start(ctx, status.Paths.BinaryPath, nil, m.processEnv(status.Paths), logFile, logFile)
	if err != nil {
		return Status{}, err
	}
	if err := os.WriteFile(status.Paths.PIDPath, []byte(strconv.Itoa(pid)), 0o644); err != nil {
		_ = m.controller().Stop(pid, 10*time.Second)
		return Status{}, fmt.Errorf("write qdrant pid: %w", err)
	}
	if err := m.waitForReady(ctx, managedEndpoint(m.Config.HTTPPort)); err != nil {
		stopErr := m.controller().Stop(pid, 10*time.Second)
		_ = os.Remove(status.Paths.PIDPath)
		status = m.statusWithMessage("managed Qdrant failed HTTP readiness; inspect logs: knowns qdrant logs")
		status.Running, status.PID, status.State = false, 0, StatusStopped
		_ = m.writeStatus(status)
		if stopErr != nil {
			return status, fmt.Errorf("wait for Qdrant /healthz: %w; cleanup process: %v; inspect %s", err, stopErr, status.Paths.LogPath)
		}
		return status, fmt.Errorf("wait for Qdrant /healthz: %w; inspect %s or run `knowns qdrant logs`", err, status.Paths.LogPath)
	}
	status = m.statusWithMessage("managed Qdrant started")
	status.PID = pid
	status.Running = true
	status.State = StatusRunning
	if err := m.writeStatus(status); err != nil {
		return Status{}, err
	}
	return status, nil
}

func (m *Manager) waitForReady(ctx context.Context, endpoint string) error {
	timeout := m.ReadinessTimeout
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	readyCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	check := m.HealthCheck
	if check == nil {
		check = defaultHealthCheck
	}
	var lastErr error
	for {
		if err := check(readyCtx, endpoint); err == nil {
			return nil
		} else {
			lastErr = err
		}
		select {
		case <-readyCtx.Done():
			return fmt.Errorf("readiness timeout: %w (last error: %v)", readyCtx.Err(), lastErr)
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func defaultHealthCheck(ctx context.Context, endpoint string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(endpoint, "/")+"/healthz", nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET /healthz returned %s", resp.Status)
	}
	return nil
}

// Stop stops the managed Qdrant process if Knowns owns one. External mode is a
// visible no-op and never sends local process signals.
func (m *Manager) Stop(ctx context.Context) (Status, error) {
	_ = ctx
	if m.isExternal() {
		status := m.statusWithMessage("external Qdrant URL configured; no managed process stopped")
		_ = m.writeStatus(status)
		return status, nil
	}
	status := m.statusWithMessage("")
	if status.PID == 0 || !status.Running {
		_ = os.Remove(status.Paths.PIDPath)
		status.PID = 0
		status.Running = false
		status.State = StatusStopped
		status.Message = "managed Qdrant is not running"
		_ = m.writeStatus(status)
		return status, nil
	}
	if err := m.Controller.Stop(status.PID, 10*time.Second); err != nil {
		return status, err
	}
	_ = os.Remove(status.Paths.PIDPath)
	status = m.statusWithMessage("managed Qdrant stopped")
	status.State = StatusStopped
	status.Running = false
	status.PID = 0
	if err := m.writeStatus(status); err != nil {
		return Status{}, err
	}
	return status, nil
}

// Cleanup removes stale process metadata. It never deletes Qdrant data or
// collections; collection cleanup/purge is handled by doctor/reindex tasks.
func (m *Manager) Cleanup(ctx context.Context) (Status, error) {
	_ = ctx
	if m.isExternal() {
		status := m.statusWithMessage("external Qdrant URL configured; managed cleanup bypassed")
		_ = m.writeStatus(status)
		return status, nil
	}
	status := m.statusWithMessage("")
	if status.PID != 0 && !status.Running {
		_ = os.Remove(status.Paths.PIDPath)
		status.PID = 0
		status.State = StatusStopped
		status.Message = "removed stale Qdrant pid file"
	} else if status.Running {
		status.Message = "managed Qdrant is running; no stale pid cleanup needed"
	} else {
		status.Message = "no stale Qdrant runtime metadata found"
	}
	if err := m.writeStatus(status); err != nil {
		return Status{}, err
	}
	return status, nil
}

// TailLog writes the last n log lines to w. Missing logs are reported as a
// non-error message so `knowns qdrant logs` works before first start.
func (m *Manager) TailLog(w io.Writer, n int) error {
	path := m.Paths().LogPath
	if _, err := os.Stat(path); os.IsNotExist(err) {
		_, err = fmt.Fprintf(w, "%s (no log yet)\n", path)
		return err
	}
	return tail(path, w, n)
}

func (m *Manager) statusWithMessage(message string) Status {
	paths := m.Paths()
	now := m.now()
	status := Status{
		Enabled:   m.Config.Enabled,
		Backend:   m.Config.Backend,
		Mode:      m.Config.Mode,
		Managed:   !m.isExternal(),
		Paths:     paths,
		Endpoint:  managedEndpoint(m.Config.HTTPPort),
		UpdatedAt: now,
		Message:   message,
	}
	if !m.Config.Enabled || m.Config.Backend != models.SemanticVectorBackendQdrant {
		status.State = StatusDisabled
		status.Message = firstNonEmpty(message, "semantic Qdrant backend is disabled")
		return status
	}
	if m.isExternal() {
		status.Managed = false
		status.State = StatusExternal
		status.ExternalURL = sanitizedEndpoint(m.Config.ExternalURL)
		status.Endpoint = status.ExternalURL
		status.Installed = true
		status.Message = firstNonEmpty(message, "external Qdrant URL configured; managed process ownership disabled")
		return status
	}
	status.Installed = fileExists(paths.BinaryPath)
	pid, pidErr := readPID(paths.PIDPath)
	if pidErr == nil {
		status.PID = pid
		status.Running = m.controller().Alive(pid)
		if status.Running {
			status.State = StatusRunning
		} else {
			status.State = StatusStale
			status.Message = firstNonEmpty(message, "managed Qdrant pid file is stale")
		}
	} else if !status.Installed {
		status.State = StatusNotInstalled
		status.Message = firstNonEmpty(message, "managed Qdrant binary is not installed")
	} else {
		status.State = StatusStopped
	}
	return status
}

func sanitizedEndpoint(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "invalid-external-endpoint"
	}
	u.User = nil
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

func (m *Manager) writeStatus(status Status) error {
	if err := os.MkdirAll(filepath.Dir(status.Paths.StatusPath), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(status.Paths.StatusPath, append(data, '\n'), 0o644)
}

func (m *Manager) processEnv(paths Paths) []string {
	env := os.Environ()
	env = append(env,
		"QDRANT__STORAGE__STORAGE_PATH="+paths.DataDir,
		"QDRANT__STORAGE__SNAPSHOTS_PATH="+paths.SnapshotsDir,
		"QDRANT__SERVICE__HOST=127.0.0.1",
		fmt.Sprintf("QDRANT__SERVICE__HTTP_PORT=%d", m.Config.HTTPPort),
		fmt.Sprintf("QDRANT__SERVICE__GRPC_PORT=%d", m.Config.GRPCPort),
		"QDRANT__TELEMETRY_DISABLED=true",
	)
	return env
}

func (m *Manager) isExternal() bool {
	return m.Config.Mode == models.SemanticVectorStoreModeExternal || strings.TrimSpace(m.Config.ExternalURL) != ""
}

func (m *Manager) controller() ProcessController {
	if m.Controller != nil {
		return m.Controller
	}
	return defaultProcessController{}
}

func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now().UTC()
	}
	return time.Now().UTC()
}

func readPID(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("invalid pid file %s", path)
	}
	return pid, nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func managedEndpoint(port int) string {
	if port == 0 {
		port = DefaultHTTPPort
	}
	return fmt.Sprintf("http://127.0.0.1:%d", port)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func tail(path string, w io.Writer, n int) error {
	if n <= 0 {
		n = 50
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	lines := make([]string, 0, n)
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		if len(lines) == n {
			lines = lines[1:]
		}
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	for _, line := range lines {
		fmt.Fprintln(w, line)
	}
	return nil
}

type defaultProcessController struct{}

func (defaultProcessController) Start(ctx context.Context, binary string, args []string, env []string, stdout, stderr io.Writer) (int, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = env
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Stdin = strings.NewReader("")
	setSysProcAttr(cmd)
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("start qdrant: %w", err)
	}
	return cmd.Process.Pid, nil
}

func (defaultProcessController) Stop(pid int, timeout time.Duration) error {
	if pid <= 0 {
		return nil
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return nil
	}
	_ = signalTerm(process)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !isProcessAlive(pid) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = process.Kill()
	return nil
}

func (defaultProcessController) Alive(pid int) bool { return isProcessAlive(pid) }
