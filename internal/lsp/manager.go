package lsp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// MissingServer describes a language detected in the project but without an available binary.
type MissingServer struct {
	LanguageID string
	Name       string
	BinaryName string
	Guide      InstallGuide
}

var ErrServerUnavailable = errors.New("LSP not available for this language")

// PathMatcherAdapter optionally provides ordered routing signals beyond the
// legacy extension list. Adapters that do not implement it remain extension
// routed exactly as before.
type PathMatcherAdapter interface {
	PathMatchers() []PathMatcher
}

// LazyStartAdapter opts an adapter out of project-activation startup. Its
// server is resolved and started only by an explicit matching file request.
type LazyStartAdapter interface {
	LazyStart() bool
}

type Manager struct {
	root     string
	registry *Registry
	detector *Detector
	config   Config

	mu       sync.Mutex
	clients  int
	servers  map[string]*Server
	adapters map[string]LanguageAdapter
	status   map[string]ServerStatus

	traceEnabled map[string]bool
}

func NewManager(root string, cfg Config) *Manager {
	registry := NewEmptyRegistry()
	return &Manager{
		root:     root,
		registry: registry,
		detector: NewDetector(registry),
		config:   cfg,
		servers:  make(map[string]*Server),
		adapters: make(map[string]LanguageAdapter),
		status:   make(map[string]ServerStatus),

		traceEnabled: make(map[string]bool),
	}
}

// RegisterAdapter registers a language adapter with the manager.
func (m *Manager) RegisterAdapter(adapter LanguageAdapter) error {
	if adapter == nil {
		return fmt.Errorf("adapter is nil")
	}
	if adapter.ID() == "" {
		return fmt.Errorf("adapter id is required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	return m.registerAdapterLocked(adapter)
}

func (m *Manager) RegisterPluginAdapters(opts PluginAdapterLoadOptions) []PluginAdapterLoadError {
	result := LoadPluginAdapters(opts)
	errs := append([]PluginAdapterLoadError(nil), result.Errors...)
	for _, adapter := range result.Adapters {
		if err := m.RegisterAdapter(adapter); err != nil {
			path := ""
			if sourced, ok := adapter.(interface{ SourcePath() string }); ok {
				path = sourced.SourcePath()
			}
			errs = append(errs, PluginAdapterLoadError{Path: path, Err: err})
		}
	}
	return errs
}

func (m *Manager) SetDetector(detector *Detector) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if detector != nil {
		m.detector = detector
	}
}

// Config returns a snapshot of the manager's current LSP configuration.
func (m *Manager) Config() Config {
	m.mu.Lock()
	defer m.mu.Unlock()
	return cloneManagerConfig(m.config)
}

// SetConfig replaces the manager's LSP configuration for future runtime work.
func (m *Manager) SetConfig(cfg Config) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.config = cloneManagerConfig(cfg)
}

func cloneManagerConfig(cfg Config) Config {
	if len(cfg.Languages) == 0 {
		return Config{}
	}
	out := Config{Languages: make(map[string]LanguageConfig, len(cfg.Languages))}
	for langID, entry := range cfg.Languages {
		out.Languages[langID] = entry.clone()
	}
	return out
}

func (m *Manager) ClientConnected(ctx context.Context) error {
	m.mu.Lock()
	m.clients++
	first := m.clients == 1
	m.mu.Unlock()
	if !first {
		return nil
	}
	if err := m.startDetected(ctx); err != nil {
		m.mu.Lock()
		m.clients--
		m.mu.Unlock()
		return err
	}
	return nil
}

func (m *Manager) ClientDisconnected(ctx context.Context) error {
	m.mu.Lock()
	if m.clients > 0 {
		m.clients--
	}
	last := m.clients == 0
	servers := m.serverListLocked()
	m.mu.Unlock()
	if !last {
		return nil
	}
	for _, srv := range servers {
		_ = srv.Stop(ctx)
	}
	return nil
}

func (m *Manager) ServerForPath(ctx context.Context, path string) (*Server, bool, error) {
	lang, ok := m.registry.ForPath(path)
	if !ok || !m.config.Enabled(lang.ID) {
		return nil, false, nil
	}
	m.mu.Lock()
	srv := m.servers[lang.ID]
	status := m.status[lang.ID]
	adapter := m.adapters[lang.ID]
	if pathCapabilityBlocksAll(adapter, path) {
		if srv == nil {
			backend := primaryBinaryName(adapter)
			srv = NewServer(m.root, ServerCommand{Language: lang.ID, Name: backend, Backend: backend})
			m.configureServerInitializeParamsLocked(lang.ID, srv)
			m.configureServerCapabilityProfileLocked(lang.ID, srv)
			m.configureServerDocumentSyncLocked(lang.ID, srv)
			m.configureServerPathCapabilityLocked(lang.ID, srv)
			m.configureTraceLocked(lang.ID, srv)
		}
		m.mu.Unlock()
		return srv, true, nil
	}
	m.mu.Unlock()

	// Auto-restart: if server exists but is not alive, restart it transparently.
	if srv != nil && !srv.Alive() && status != StatusDisabled {
		slog.Warn("lsp: server not alive, restarting", "language", lang.ID)
		m.mu.Lock()
		m.status[lang.ID] = StatusStarting
		m.mu.Unlock()
		if err := srv.Start(ctx); err != nil {
			m.mu.Lock()
			m.status[lang.ID] = StatusCrashed
			m.mu.Unlock()
			return nil, false, m.runtimeErrorForCommand(srv.Command, err)
		}
		m.mu.Lock()
		m.status[lang.ID] = StatusRunning
		m.mu.Unlock()
		return srv, true, nil
	}

	if srv != nil {
		if err := srv.Start(ctx); err != nil {
			return nil, false, m.runtimeErrorForCommand(srv.Command, err)
		}
		return srv, true, nil
	}
	if lang.ID == CSharpLanguageID && m.config.BinaryOverride(lang.ID) == "" {
		cmd, ok, err := m.resolveCSharpCommand(ctx, false)
		if err != nil || !ok {
			return nil, false, err
		}
		m.mu.Lock()
		srv = m.servers[lang.ID]
		if srv == nil {
			srv = NewServer(m.root, cmd)
			m.servers[lang.ID] = srv
		} else {
			srv.Command = cmd
		}
		m.configureServerInitializeParamsLocked(lang.ID, srv)
		m.configureServerCapabilityProfileLocked(lang.ID, srv)
		m.configureServerDocumentSyncLocked(lang.ID, srv)
		m.configureServerPathCapabilityLocked(lang.ID, srv)
		m.configureTraceLocked(lang.ID, srv)
		m.mu.Unlock()
		if err := srv.Start(ctx); err != nil {
			return nil, false, m.runtimeErrorForCommand(cmd, err)
		}
		m.mu.Lock()
		m.status[lang.ID] = StatusRunning
		m.mu.Unlock()
		return srv, true, nil
	}
	cmd, ok, err := m.resolveLanguageCommand(ctx, lang)
	if err != nil || !ok {
		return nil, false, err
	}
	if err := m.startCommand(ctx, lang.ID, cmd); err != nil {
		return nil, false, err
	}
	m.mu.Lock()
	srv = m.servers[lang.ID]
	m.mu.Unlock()
	if srv == nil {
		return nil, false, nil
	}
	return srv, true, nil
}

func (m *Manager) resolveLanguageCommand(ctx context.Context, lang Language) (ServerCommand, bool, error) {
	m.mu.Lock()
	detector := m.detector
	root := m.root
	cfg := m.config
	m.mu.Unlock()
	if detector == nil {
		detector = NewDetector(nil)
	}
	cmd, ok := detector.resolve(ctx, root, lang, cfg.BinaryOverride(lang.ID))
	if !ok {
		return ServerCommand{}, false, nil
	}
	if lang.ID == CSharpLanguageID {
		cmd.Backend = cfg.BackendOverride(lang.ID)
		if cmd.Backend == "" {
			cmd.Backend = "custom"
		}
		cmd.ProjectPath = DiscoverCSharpProject(root, cfg.ProjectPathOverride(lang.ID)).Path
	}
	return cmd, true, nil
}

func primaryBinaryName(adapter LanguageAdapter) string {
	binaries := adapter.Binaries()
	if len(binaries) == 0 {
		return adapter.Name()
	}
	return binaries[0].Name
}

func (m *Manager) WithFile(ctx context.Context, path string, fn func(*Server) error) error {
	return m.WithSession(ctx, path, func(session Session) error {
		srv, ok := session.(*Server)
		if !ok {
			return fmt.Errorf("lsp session is not a server")
		}
		return fn(srv)
	})
}

// WithSession starts the session for path, syncs the file for the duration of
// fn, and exposes only the shared runtime/session surface to callers.
func (m *Manager) WithSession(ctx context.Context, path string, fn func(Session) error) error {
	srv, ok, err := m.ServerForPath(ctx, path)
	if err != nil {
		return err
	}
	if !ok {
		return ErrServerUnavailable
	}
	return srv.WithFile(ctx, path, func() error { return fn(srv) })
}

// WithAnyServer calls fn with any running server. Used for workspace-level queries.
func (m *Manager) WithAnyServer(ctx context.Context, fn func(*Server) error) error {
	m.mu.Lock()
	var srv *Server
	for _, s := range m.servers {
		if s != nil {
			srv = s
			break
		}
	}
	m.mu.Unlock()
	if srv == nil {
		return fmt.Errorf("no LSP server available")
	}
	return fn(srv)
}

// StartAll starts all detected and adapter-registered servers in parallel.
// It uses fail-open semantics: if a server fails to start, it logs a warning and continues.
func (m *Manager) StartAll(ctx context.Context) error {
	commands, err := m.detector.Detect(ctx, m.root, m.config)
	if err != nil {
		return err
	}

	m.mu.Lock()
	for _, cmd := range commands {
		lang, registered := m.registry.Language(cmd.Language)
		if registered && lang.LazyStart {
			if _, exists := m.status[cmd.Language]; !exists {
				m.status[cmd.Language] = StatusInstalled
			}
			continue
		}
		if _, exists := m.servers[cmd.Language]; !exists {
			srv := NewServer(m.root, cmd)
			m.configureTraceLocked(cmd.Language, srv)
			m.servers[cmd.Language] = srv
		}
		m.configureServerInitializeParamsLocked(cmd.Language, m.servers[cmd.Language])
		m.configureServerCapabilityProfileLocked(cmd.Language, m.servers[cmd.Language])
		m.configureServerDocumentSyncLocked(cmd.Language, m.servers[cmd.Language])
		m.configureServerPathCapabilityLocked(cmd.Language, m.servers[cmd.Language])
		if _, exists := m.status[cmd.Language]; !exists {
			m.status[cmd.Language] = StatusInstalled
		}
	}
	// Collect servers to start
	type startItem struct {
		langID string
		srv    *Server
	}
	var items []startItem
	for langID, srv := range m.servers {
		if lang, registered := m.registry.Language(langID); registered && lang.LazyStart {
			continue
		}
		if m.status[langID] != StatusDisabled {
			m.configureTraceLocked(langID, srv)
			items = append(items, startItem{langID: langID, srv: srv})
			m.status[langID] = StatusStarting
		}
	}
	m.mu.Unlock()

	var wg sync.WaitGroup
	for _, item := range items {
		wg.Add(1)
		go func(langID string, srv *Server) {
			defer wg.Done()
			startCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			if err := srv.Start(startCtx); err != nil {
				slog.Warn("lsp: failed to start server", "language", langID, "error", err)
				m.mu.Lock()
				m.status[langID] = StatusCrashed
				m.mu.Unlock()
				return
			}
			m.mu.Lock()
			m.status[langID] = StatusRunning
			m.mu.Unlock()
		}(item.langID, item.srv)
	}
	wg.Wait()
	return nil
}

// StopAll stops all running servers.
func (m *Manager) StopAll(ctx context.Context) error {
	m.mu.Lock()
	servers := m.serverListLocked()
	m.mu.Unlock()
	for _, srv := range servers {
		_ = srv.Stop(ctx)
	}
	m.mu.Lock()
	for langID := range m.status {
		if m.status[langID] == StatusRunning || m.status[langID] == StatusStarting {
			m.status[langID] = StatusInstalled
		}
	}
	m.mu.Unlock()
	return nil
}

// LanguageInfo describes an available language adapter with its runtime status.
type LanguageInfo struct {
	ID                     string           `json:"id"`
	Name                   string           `json:"name"`
	Enabled                bool             `json:"enabled"`
	Detected               bool             `json:"detected"`
	Status                 string           `json:"status,omitempty"`
	Binary                 string           `json:"binary"`
	BinaryPath             string           `json:"binaryPath,omitempty"`
	Source                 string           `json:"source,omitempty"`
	Installed              bool             `json:"installed"`
	Running                bool             `json:"running"`
	InstallState           string           `json:"installState,omitempty"`
	RunningState           string           `json:"runningState,omitempty"`
	ReadinessState         string           `json:"readinessState,omitempty"`
	Version                string           `json:"version,omitempty"`
	RequestedVersion       string           `json:"requestedVersion,omitempty"`
	ResolvedVersion        string           `json:"resolvedVersion,omitempty"`
	SourceLocation         string           `json:"sourceLocation,omitempty"`
	Integrity              string           `json:"integrity,omitempty"`
	InstalledAt            string           `json:"installedAt,omitempty"`
	Verified               bool             `json:"verified"`
	CachePath              string           `json:"cachePath,omitempty"`
	SelectedPath           string           `json:"selectedPath,omitempty"`
	CleanupEligible        bool             `json:"cleanupEligible,omitempty"`
	InstallError           string           `json:"installError,omitempty"`
	UpdateError            string           `json:"updateError,omitempty"`
	InstallHint            string           `json:"installHint,omitempty"`
	Backend                string           `json:"backend,omitempty"`
	BackendSource          string           `json:"backendSource,omitempty"`
	ProjectPath            string           `json:"projectPath,omitempty"`
	ProjectKind            string           `json:"projectKind,omitempty"`
	LogPath                string           `json:"logPath,omitempty"`
	Attempts               []BackendAttempt `json:"attempts,omitempty"`
	TraceEnabled           bool             `json:"traceEnabled,omitempty"`
	Owner                  string           `json:"owner,omitempty"`
	DaemonState            string           `json:"daemonState,omitempty"`
	DaemonPID              int              `json:"daemonPid,omitempty"`
	DaemonClients          int              `json:"daemonClients,omitempty"`
	DaemonTransport        string           `json:"daemonTransport,omitempty"`
	DaemonEndpoint         string           `json:"daemonEndpoint,omitempty"`
	DaemonIdleDeadline     string           `json:"daemonIdleDeadline,omitempty"`
	DaemonLeaseCount       int              `json:"daemonLeaseCount,omitempty"`
	DaemonLeaseOwners      []string         `json:"daemonLeaseOwners,omitempty"`
	CapabilitiesKnown      bool             `json:"capabilitiesKnown,omitempty"`
	Capabilities           []string         `json:"capabilities,omitempty"`
	AdvertisedCapabilities []string         `json:"advertisedCapabilities,omitempty"`
	ObservedCapabilities   []string         `json:"observedCapabilities,omitempty"`
	RequiredCapabilities   []string         `json:"requiredCapabilities,omitempty"`
	MissingCapabilities    []string         `json:"missingCapabilities,omitempty"`
}

// StartLanguage starts a single language server by adapter ID.
func (m *Manager) StartLanguage(ctx context.Context, langID string) error {
	m.mu.Lock()
	adapter := m.adapters[langID]
	if adapter == nil {
		m.mu.Unlock()
		return fmt.Errorf("no adapter registered for language %q", langID)
	}
	if !m.config.Enabled(langID) {
		m.mu.Unlock()
		return fmt.Errorf("language %q is disabled", langID)
	}
	if langID == CSharpLanguageID && m.config.BinaryOverride(langID) == "" {
		m.mu.Unlock()
		cmd, ok, err := m.resolveCSharpCommand(ctx, true)
		if err != nil || !ok {
			return err
		}
		return m.startCommand(ctx, langID, cmd)
	}
	installer := m.installerLocked()
	binaries := runtimeBinariesForAdapter(adapter, installer)
	if override := m.config.BinaryOverride(langID); override != "" {
		binaries = []BinaryCandidate{{Name: override}}
	}
	m.mu.Unlock()

	if len(binaries) == 0 {
		return fmt.Errorf("language %q has no binary candidates", langID)
	}

	var lastErr error
	for _, b := range binaries {
		path, err := exec.LookPath(b.Name)
		if err != nil {
			lastErr = fmt.Errorf("%s: %w", b.Name, err)
			continue
		}
		if lastErr != nil {
			lastErr = nil
		}
		cmd := ServerCommand{
			Language: langID,
			Name:     b.Name,
			Path:     path,
			Args:     append([]string(nil), b.Args...),
			LogPath:  LanguageLogPath(m.root, langID),
		}

		return m.startCommand(ctx, langID, cmd)
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("all binary candidates failed version check")
	}
	return lastErr
}

func runtimeBinariesForAdapter(adapter LanguageAdapter, installer *Installer) []BinaryCandidate {
	if adapter == nil {
		return nil
	}
	binaries := append([]BinaryCandidate(nil), adapter.Binaries()...)
	if len(adapter.RuntimeDeps()) == 0 || installer == nil {
		return binaries
	}
	status := installer.Status(adapter)
	if status.Installed && status.SelectedPath != "" {
		// Config overrides are handled by Detector.resolve. Keep compatible
		// user PATH binaries ahead of the Knowns-managed fallback here.
		return append(binaries, BinaryCandidate{Name: status.SelectedPath, Args: adapter.DefaultArgs()})
	}
	return binaries
}

func (m *Manager) startCommand(ctx context.Context, langID string, cmd ServerCommand) error {
	m.mu.Lock()
	srv, exists := m.servers[langID]
	if !exists {
		srv = NewServer(m.root, cmd)
		m.servers[langID] = srv
	} else {
		srv.Command = cmd
	}
	m.configureServerInitializeParamsLocked(langID, srv)
	m.configureServerCapabilityProfileLocked(langID, srv)
	m.configureServerDocumentSyncLocked(langID, srv)
	m.configureServerPathCapabilityLocked(langID, srv)
	m.configureTraceLocked(langID, srv)
	m.status[langID] = StatusStarting
	m.mu.Unlock()

	startCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	err := srv.Start(startCtx)
	cancel()
	if err != nil {
		m.mu.Lock()
		m.status[langID] = StatusCrashed
		m.mu.Unlock()
		return m.runtimeErrorForCommand(cmd, err)
	}
	m.mu.Lock()
	m.status[langID] = StatusRunning
	m.mu.Unlock()
	return nil
}

func (m *Manager) resolveCSharpCommand(ctx context.Context, autoInstall bool) (ServerCommand, bool, error) {
	m.mu.Lock()
	detector := m.detector
	root := m.root
	cfg := m.config
	m.mu.Unlock()
	if detector == nil {
		detector = NewDetector(nil)
	}
	cmd, ok := ResolveCSharpBackendWithOptions(ctx, root, cfg, CSharpResolveOptions{
		LookPath:          detector.LookPath,
		RunCheck:          detector.RunCheck,
		RunCommand:        detector.RunCommand,
		Installer:         detector.Installer,
		AutoInstallRoslyn: autoInstall,
	})
	if !ok {
		return cmd, false, CSharpBackendUnavailableError(root, cmd)
	}
	return cmd, true, nil
}

func (m *Manager) runtimeErrorForCommand(cmd ServerCommand, err error) error {
	if err == nil || cmd.Language != CSharpLanguageID {
		return err
	}
	code := "csharp_lsp_runtime_error"
	message := "C# language server failed"
	remediation := "Check the C# LSP log, run `knowns lsp install csharp`, and ensure .NET SDK 10+ is available."
	if errors.Is(err, io.EOF) {
		code = "csharp_lsp_eof"
		message = "C# language server closed the protocol stream before replying"
	}
	return &RuntimeError{
		Code:        code,
		Language:    CSharpLanguageID,
		Backend:     cmd.Backend,
		Message:     message,
		Remediation: remediation,
		LogPath:     cmd.LogPath,
		Attempts:    cmd.Attempts,
		Cause:       err,
	}
}

func (m *Manager) DescribeRuntimeError(path string, err error) *RuntimeError {
	if err == nil {
		return nil
	}
	var runtimeErr *RuntimeError
	if errors.As(err, &runtimeErr) {
		return runtimeErr
	}
	m.mu.Lock()
	lang, ok := m.registry.ForPath(path)
	root := m.root
	cfg := m.config
	var cmd ServerCommand
	if ok {
		if srv := m.servers[lang.ID]; srv != nil {
			cmd = srv.Command
		}
	}
	m.mu.Unlock()
	if !ok || lang.ID != CSharpLanguageID {
		return nil
	}
	if cmd.Language == "" {
		backend := cfg.BackendOverride(CSharpLanguageID)
		if backend == "" {
			backend = CSharpBackendAuto
		}
		cmd = ServerCommand{
			Language: CSharpLanguageID,
			Backend:  backend,
			LogPath:  CSharpLogPath(root, backend),
		}
	}
	wrapped := m.runtimeErrorForCommand(cmd, err)
	if errors.As(wrapped, &runtimeErr) {
		return runtimeErr
	}
	return nil
}

// RestartLanguage restarts the language server for langID through the shared
// runtime path.
func (m *Manager) RestartLanguage(ctx context.Context, langID string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := m.ensureAdapter(langID); err != nil {
		return err
	}
	if !m.Config().Enabled(langID) {
		_ = m.stopLanguage(ctx, langID, StatusDisabled)
		return fmt.Errorf("language %q is disabled", langID)
	}
	stopCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := m.stopLanguage(stopCtx, langID, StatusInstalled); err != nil {
		return err
	}
	return m.StartLanguage(ctx, langID)
}

// StopLanguage gracefully stops the language server for langID.
func (m *Manager) StopLanguage(langID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return m.stopLanguage(ctx, langID, StatusDisabled)
}

func (m *Manager) stopLanguage(ctx context.Context, langID string, stoppedStatus ServerStatus) error {
	m.mu.Lock()
	srv := m.servers[langID]
	if srv == nil {
		if _, ok := m.status[langID]; ok {
			m.status[langID] = stoppedStatus
		}
		m.mu.Unlock()
		return nil
	}
	m.status[langID] = stoppedStatus
	m.mu.Unlock()

	err := srv.Stop(ctx)

	m.mu.Lock()
	delete(m.servers, langID)
	m.status[langID] = stoppedStatus
	m.mu.Unlock()
	return err
}

// InstallLanguage installs or updates the managed runtime dependency for a
// language using the existing adapter/installer path.
func (m *Manager) InstallLanguage(ctx context.Context, langID string) (string, error) {
	return m.InstallLanguageWithOptions(ctx, langID, InstallOptions{})
}

// InstallLanguageWithOptions installs a selected managed runtime version while
// preserving InstallLanguage as the recommended/default compatibility API.
func (m *Manager) InstallLanguageWithOptions(ctx context.Context, langID string, opts InstallOptions) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	m.mu.Lock()
	adapter := m.adapters[langID]
	if adapter == nil {
		m.mu.Unlock()
		return "", fmt.Errorf("no adapter registered for language %q", langID)
	}
	cfg := cloneManagerConfig(m.config)
	installer := m.installerLocked()
	m.mu.Unlock()

	installAdapter := adapter
	if langID == CSharpLanguageID {
		installAdapter = dependencyAdapter{
			id:   CSharpLanguageID,
			deps: []RuntimeDependency{CSharpRoslynRuntimeDependency(cfg)},
		}
	}
	if len(installAdapter.RuntimeDeps()) > 0 {
		callerBeforeCleanup := opts.BeforeCleanup
		opts.BeforeCleanup = func(path string) error {
			if callerBeforeCleanup != nil {
				if err := callerBeforeCleanup(path); err != nil {
					return err
				}
			}
			return m.refreshAdapterRegistration(langID)
		}
		path, err := installer.InstallWithOptions(ctx, installAdapter, opts)
		return path, err
	}
	if !adapter.CanInstall() {
		return "", fmt.Errorf("language %q does not support managed install", langID)
	}
	path, err := adapter.Install(ctx, installer.baseDir)
	if err == nil {
		err = m.refreshAdapterRegistration(langID)
	}
	return path, err
}

// CleanupLanguage removes old managed runtime versions for a language while
// preserving the selected version.
func (m *Manager) CleanupLanguage(langID string) error {
	if err := m.ensureAdapter(langID); err != nil {
		return err
	}
	m.mu.Lock()
	installer := m.installerLocked()
	m.mu.Unlock()
	return installer.Cleanup(langID)
}

// LogTail is a bounded tail of a language runtime or trace log.
type LogTail struct {
	LanguageID string   `json:"language"`
	Kind       string   `json:"kind"`
	Path       string   `json:"path"`
	Lines      []string `json:"lines"`
}

// TailLog returns the last maxLines from a runtime or trace log. Missing log
// files are reported as an empty tail so the WebUI can render a stable state.
func (m *Manager) TailLog(langID, kind string, maxLines int) (LogTail, error) {
	normalizedKind := strings.ToLower(strings.TrimSpace(kind))
	if normalizedKind == "" {
		normalizedKind = "runtime"
	}
	if normalizedKind != "runtime" && normalizedKind != "trace" {
		return LogTail{}, fmt.Errorf("unsupported log kind %q", kind)
	}
	path, err := m.logPathForLanguage(langID, normalizedKind)
	if err != nil {
		return LogTail{}, err
	}
	lines, err := tailLogFile(path, maxLines)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			lines = []string{}
		} else {
			return LogTail{}, err
		}
	}
	return LogTail{LanguageID: langID, Kind: normalizedKind, Path: path, Lines: lines}, nil
}

// SetTrace enables or disables JSON-RPC trace logging for an existing or future
// server for langID.
func (m *Manager) SetTrace(langID string, enabled bool) (string, error) {
	m.mu.Lock()
	if m.adapters[langID] == nil {
		m.mu.Unlock()
		return "", fmt.Errorf("no adapter registered for language %q", langID)
	}
	path := LanguageTraceLogPath(m.root, langID)
	m.mu.Unlock()

	if enabled {
		if err := touchLogFile(path); err != nil {
			return "", err
		}
	}

	m.mu.Lock()
	if enabled {
		m.traceEnabled[langID] = true
	} else {
		delete(m.traceEnabled, langID)
	}
	if srv := m.servers[langID]; srv != nil {
		m.configureTraceLocked(langID, srv)
	}
	m.mu.Unlock()
	return path, nil
}

// AvailableLanguages returns all registered adapters with their install and
// running status.
func (m *Manager) AvailableLanguages() []LanguageInfo {
	statuses := m.RuntimeStatuses(context.Background())
	out := make([]LanguageInfo, 0, len(statuses))
	for _, status := range statuses {
		info := LanguageInfoFromRuntimeStatus(status)
		info.TraceEnabled = m.isTraceEnabled(status.ID)
		if status.InstallState != RuntimeInstallInstalled {
			info.InstallHint = status.InstallCmd
		}
		out = append(out, info)
	}
	return out
}

func LanguageInfoFromRuntimeStatus(status LanguageRuntimeStatus) LanguageInfo {
	return LanguageInfo{
		ID:                     status.ID,
		Name:                   status.Name,
		Enabled:                status.Enabled,
		Detected:               status.Detected,
		Status:                 status.Status,
		Binary:                 status.Binary,
		BinaryPath:             status.BinaryPath,
		Source:                 status.Source,
		Installed:              status.InstallState == RuntimeInstallInstalled,
		Running:                status.RunningState == RuntimeRunningRunning,
		InstallState:           status.InstallState,
		RunningState:           status.RunningState,
		ReadinessState:         status.ReadinessState,
		Version:                status.Version,
		RequestedVersion:       status.RequestedVersion,
		ResolvedVersion:        status.ResolvedVersion,
		SourceLocation:         status.SourceLocation,
		Integrity:              status.Integrity,
		InstalledAt:            status.InstalledAt,
		Verified:               status.Verified,
		CachePath:              status.CachePath,
		SelectedPath:           status.SelectedPath,
		CleanupEligible:        status.CleanupEligible,
		InstallError:           status.InstallError,
		UpdateError:            status.UpdateError,
		Backend:                status.Backend,
		BackendSource:          status.BackendSource,
		ProjectPath:            status.ProjectPath,
		ProjectKind:            status.ProjectKind,
		LogPath:                status.LogPath,
		Attempts:               status.Attempts,
		Owner:                  status.Owner,
		DaemonState:            status.DaemonState,
		DaemonPID:              status.DaemonPID,
		DaemonClients:          status.DaemonClients,
		DaemonTransport:        status.DaemonTransport,
		DaemonEndpoint:         status.DaemonEndpoint,
		DaemonIdleDeadline:     status.DaemonIdleDeadline,
		DaemonLeaseCount:       status.DaemonLeaseCount,
		DaemonLeaseOwners:      append([]string(nil), status.DaemonLeaseOwners...),
		CapabilitiesKnown:      status.CapabilitiesKnown,
		Capabilities:           append([]string(nil), status.Capabilities...),
		AdvertisedCapabilities: append([]string(nil), status.AdvertisedCapabilities...),
		ObservedCapabilities:   append([]string(nil), status.ObservedCapabilities...),
		RequiredCapabilities:   append([]string(nil), status.RequiredCapabilities...),
		MissingCapabilities:    append([]string(nil), status.MissingCapabilities...),
	}
}

func (m *Manager) registerAdapterLocked(adapter LanguageAdapter) error {
	var binaries []Binary
	for _, b := range runtimeBinariesForAdapter(adapter, m.installerLocked()) {
		binaries = append(binaries, Binary{Name: b.Name, Args: b.Args, CheckArgs: b.CheckArgs})
	}
	var matchers []PathMatcher
	if provider, ok := adapter.(PathMatcherAdapter); ok {
		matchers = provider.PathMatchers()
	}
	lazyStart := false
	if provider, ok := adapter.(LazyStartAdapter); ok {
		lazyStart = provider.LazyStart()
	}
	if err := m.registry.Register(Language{
		ID:         adapter.ID(),
		Name:       adapter.Name(),
		Extensions: adapter.Extensions(),
		Binaries:   binaries,
		Matchers:   matchers,
		LazyStart:  lazyStart,
	}); err != nil {
		return err
	}
	m.adapters[adapter.ID()] = adapter
	return nil
}

func (m *Manager) refreshAdapterRegistration(langID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if adapter := m.adapters[langID]; adapter != nil {
		return m.registerAdapterLocked(adapter)
	}
	return nil
}

func (m *Manager) isTraceEnabled(langID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.traceEnabled[langID]
}

// MissingServers returns languages detected in the project that don't have an available binary.
func (m *Manager) MissingServers() []MissingServer {
	m.mu.Lock()
	detector := m.detector
	root := m.root
	cfg := m.config
	adapters := make(map[string]LanguageAdapter, len(m.adapters))
	for id, adapter := range m.adapters {
		adapters[id] = adapter
	}
	status := make(map[string]ServerStatus, len(m.status))
	for id, serverStatus := range m.status {
		status[id] = serverStatus
	}
	m.mu.Unlock()

	if detector == nil {
		return nil
	}
	languages, err := detector.DetectedLanguages(root, cfg)
	if err != nil {
		return nil
	}

	var missing []MissingServer
	for _, lang := range languages {
		adapter := adapters[lang.ID]
		if adapter == nil {
			continue
		}
		if status[lang.ID] == StatusRunning || status[lang.ID] == StatusInstalled || status[lang.ID] == StatusStarting {
			continue
		}
		if _, ok := detector.resolve(context.Background(), root, lang, cfg.BinaryOverride(lang.ID)); ok {
			continue
		}
		missing = append(missing, MissingServer{
			LanguageID: lang.ID,
			Name:       adapter.Name(),
			BinaryName: primaryBinaryName(adapter),
			Guide:      adapter.InstallGuide(),
		})
	}
	return missing
}

// ActiveLanguages returns languages with running servers.
func (m *Manager) ActiveLanguages() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	languages := make([]string, 0, len(m.servers))
	for language, srv := range m.servers {
		if srv.Alive() {
			languages = append(languages, language)
		}
	}
	return languages
}

func (m *Manager) ensureAdapter(langID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.adapters[langID] == nil {
		return fmt.Errorf("no adapter registered for language %q", langID)
	}
	return nil
}

func (m *Manager) installerLocked() *Installer {
	if m.detector != nil && m.detector.Installer != nil {
		return m.detector.Installer
	}
	return NewInstaller(DefaultLSPBaseDir())
}

func (m *Manager) configureTraceLocked(langID string, srv *Server) {
	if srv == nil {
		return
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if m.traceEnabled[langID] {
		srv.TraceWriter = &traceLogWriter{path: LanguageTraceLogPath(m.root, langID)}
		return
	}
	srv.TraceWriter = nil
}

func (m *Manager) configureServerInitializeParamsLocked(langID string, srv *Server) {
	if srv == nil {
		return
	}
	adapter := m.adapters[langID]
	if adapter == nil {
		srv.setInitializeParams(nil)
		return
	}
	srv.setInitializeParams(adapter.InitializeParams(m.root, m.config.LanguageSettings(langID)))
}

func (m *Manager) configureServerCapabilityProfileLocked(langID string, srv *Server) {
	if srv == nil {
		return
	}
	if adapter := m.adapters[langID]; adapter != nil {
		srv.SetCapabilityProfile(capabilityProfileForAdapter(adapter))
	}
}

func (m *Manager) configureServerDocumentSyncLocked(langID string, srv *Server) {
	if srv == nil {
		return
	}
	provider, _ := m.adapters[langID].(PathDocumentSyncAdapter)
	srv.setDocumentSyncAdapter(langID, provider)
}

func (m *Manager) configureServerPathCapabilityLocked(langID string, srv *Server) {
	if srv == nil {
		return
	}
	provider, _ := m.adapters[langID].(PathCapabilityAdapter)
	srv.setPathCapabilityAdapter(provider)
}

func pathCapabilityBlocksAll(adapter LanguageAdapter, path string) bool {
	provider, ok := adapter.(PathCapabilityAdapter)
	if !ok {
		return false
	}
	decision, handled := provider.PathCapabilityForAction(path, "", "")
	return handled && !decision.Supported
}

func (m *Manager) logPathForLanguage(langID, kind string) (string, error) {
	m.mu.Lock()
	if m.adapters[langID] == nil {
		m.mu.Unlock()
		return "", fmt.Errorf("no adapter registered for language %q", langID)
	}
	root := m.root
	if kind == "trace" {
		m.mu.Unlock()
		return LanguageTraceLogPath(root, langID), nil
	}
	if srv := m.servers[langID]; srv != nil && srv.Command.LogPath != "" {
		path := srv.Command.LogPath
		m.mu.Unlock()
		return path, nil
	}
	m.mu.Unlock()

	for _, status := range m.RuntimeStatuses(context.Background()) {
		if status.ID == langID && status.LogPath != "" {
			return status.LogPath, nil
		}
	}
	return LanguageLogPath(root, langID), nil
}

func (m *Manager) startDetected(ctx context.Context) error {
	commands, err := m.detector.Detect(ctx, m.root, m.config)
	if err != nil {
		return err
	}
	var servers []*Server
	m.mu.Lock()
	for _, cmd := range commands {
		lang, registered := m.registry.Language(cmd.Language)
		if registered && lang.LazyStart {
			if _, exists := m.status[cmd.Language]; !exists {
				m.status[cmd.Language] = StatusInstalled
			}
			continue
		}
		srv := m.servers[cmd.Language]
		if srv == nil {
			srv = NewServer(m.root, cmd)
			m.servers[cmd.Language] = srv
		}
		m.configureServerInitializeParamsLocked(cmd.Language, srv)
		m.configureServerCapabilityProfileLocked(cmd.Language, srv)
		m.configureServerDocumentSyncLocked(cmd.Language, srv)
		m.configureServerPathCapabilityLocked(cmd.Language, srv)
		m.configureTraceLocked(cmd.Language, srv)
		servers = append(servers, srv)
	}
	m.mu.Unlock()
	for _, srv := range servers {
		if err := srv.Start(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) serverListLocked() []*Server {
	servers := make([]*Server, 0, len(m.servers))
	for _, srv := range m.servers {
		servers = append(servers, srv)
	}
	return servers
}

type traceLogWriter struct {
	path string
	mu   sync.Mutex
}

func (w *traceLogWriter) Write(p []byte) (int, error) {
	if w == nil || w.path == "" {
		return len(p), nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(w.path), 0755); err != nil {
		return 0, err
	}
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return f.Write(p)
}

func tailLogFile(path string, maxLines int) ([]string, error) {
	if maxLines <= 0 {
		maxLines = 200
	}
	if maxLines > 5000 {
		maxLines = 5000
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() == 0 {
		return []string{}, nil
	}
	const chunkSize int64 = 32 * 1024
	var chunks [][]byte
	var newlineCount int
	for offset := info.Size(); offset > 0 && newlineCount <= maxLines; {
		readSize := chunkSize
		if offset < readSize {
			readSize = offset
		}
		offset -= readSize
		buf := make([]byte, readSize)
		if _, err := f.ReadAt(buf, offset); err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		for _, b := range buf {
			if b == '\n' {
				newlineCount++
			}
		}
		chunks = append(chunks, buf)
	}
	var data []byte
	for i := len(chunks) - 1; i >= 0; i-- {
		data = append(data, chunks[i]...)
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	text = strings.TrimRight(text, "\n")
	if text == "" {
		return []string{}, nil
	}
	lines := strings.Split(text, "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return lines, nil
}

func touchLogFile(path string) error {
	if path == "" {
		return fmt.Errorf("log path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return err
	}
	return f.Close()
}

// LanguageTraceLogPath returns the stable JSON-RPC trace log path for a
// language runtime.
func LanguageTraceLogPath(root, languageID string) string {
	if root == "" || languageID == "" {
		return ""
	}
	return filepath.Join(root, ".knowns", "logs", "lsp", languageID+".trace.log")
}
