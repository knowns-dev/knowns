package lsp

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	RuntimeInstallDisabled     = "disabled"
	RuntimeInstallInstalled    = "installed"
	RuntimeInstallNotInstalled = "not_installed"
	RuntimeInstallError        = "error"

	RuntimeRunningDisabled = "disabled"
	RuntimeRunningRunning  = "running"
	RuntimeRunningStarting = "starting"
	RuntimeRunningStopped  = "stopped"
	RuntimeRunningCrashed  = "crashed"
	RuntimeRunningUnknown  = "unknown"

	RuntimeReadinessReady         = "ready"
	RuntimeReadinessIndexing      = "indexing"
	RuntimeReadinessUnknown       = "unknown"
	RuntimeReadinessNotApplicable = "not_applicable"

	RuntimeSourcePATH   = "PATH"
	RuntimeSourceKnowns = "knowns"
	RuntimeSourceConfig = "config"
	RuntimeSourceAuto   = "auto"
)

const runtimeStatusProbeTimeout = 2 * time.Second

// LanguageRuntimeStatus is the canonical per-language LSP runtime snapshot used
// by CLI, MCP/API status, and server routes.
type LanguageRuntimeStatus struct {
	ID                 string           `json:"id"`
	Name               string           `json:"name"`
	Enabled            bool             `json:"enabled"`
	Detected           bool             `json:"detected"`
	Status             string           `json:"status"`
	InstallState       string           `json:"install_state"`
	RunningState       string           `json:"running_state"`
	ReadinessState     string           `json:"readiness_state"`
	Binary             string           `json:"binary,omitempty"`
	BinaryPath         string           `json:"binary_path,omitempty"`
	Source             string           `json:"source,omitempty"`
	Version            string           `json:"version,omitempty"`
	CachePath          string           `json:"cache_path,omitempty"`
	SelectedPath       string           `json:"selected_path,omitempty"`
	CleanupEligible    bool             `json:"cleanup_eligible,omitempty"`
	InstallError       string           `json:"install_error,omitempty"`
	UpdateError        string           `json:"update_error,omitempty"`
	InstallCmd         string           `json:"install_cmd,omitempty"`
	Backend            string           `json:"backend,omitempty"`
	BackendSource      string           `json:"backend_source,omitempty"`
	ProjectPath        string           `json:"project_path,omitempty"`
	ProjectKind        string           `json:"project_kind,omitempty"`
	LogPath            string           `json:"log_path,omitempty"`
	Attempts           []BackendAttempt `json:"attempts,omitempty"`
	Owner              string           `json:"owner,omitempty"`
	DaemonState        string           `json:"daemon_state,omitempty"`
	DaemonPID          int              `json:"daemon_pid,omitempty"`
	DaemonClients      int              `json:"daemon_clients,omitempty"`
	DaemonTransport    string           `json:"daemon_transport,omitempty"`
	DaemonEndpoint     string           `json:"daemon_endpoint,omitempty"`
	DaemonIdleDeadline string           `json:"daemon_idle_deadline,omitempty"`
	DaemonLeaseCount   int              `json:"daemon_lease_count,omitempty"`
	DaemonLeaseOwners  []string         `json:"daemon_lease_owners,omitempty"`
}

// RuntimeStatusOptions configures side-effect-light LSP runtime inspection.
type RuntimeStatusOptions struct {
	Root      string
	Config    Config
	Adapters  []LanguageAdapter
	Detector  *Detector
	Installer *Installer
	Status    map[string]ServerStatus
	Servers   map[string]*Server
}

// CollectRuntimeStatuses returns status for adapters without starting servers
// or installing dependencies.
func CollectRuntimeStatuses(ctx context.Context, opts RuntimeStatusOptions) []LanguageRuntimeStatus {
	if ctx == nil {
		ctx = context.Background()
	}
	detector := opts.Detector
	if detector == nil {
		detector = NewDetector(nil)
	}
	lookPath := detector.LookPath
	if lookPath == nil {
		lookPath = func(name string) (string, error) { return "", os.ErrNotExist }
	}
	runCheck := detector.RunCheck
	runCommand := detector.RunCommand
	installer := opts.Installer
	if installer == nil && detector.Installer != nil {
		installer = detector.Installer
	}
	if installer == nil {
		installer = NewInstaller(DefaultLSPBaseDir())
	}

	detected := detectedRuntimeLanguages(opts.Root, opts.Config, opts.Adapters, detector)
	statuses := make([]LanguageRuntimeStatus, 0, len(opts.Adapters))
	for _, adapter := range opts.Adapters {
		langID := adapter.ID()
		status := LanguageRuntimeStatus{
			ID:             langID,
			Name:           adapter.Name(),
			Enabled:        opts.Config.Enabled(langID),
			Detected:       detected[langID],
			Status:         RuntimeInstallNotInstalled,
			InstallState:   RuntimeInstallNotInstalled,
			RunningState:   RuntimeRunningUnknown,
			ReadinessState: RuntimeReadinessNotApplicable,
		}
		if guide := adapter.InstallGuide(); guide.KnownsCmd != "" {
			status.InstallCmd = guide.KnownsCmd
		} else if guide.Command != "" {
			status.InstallCmd = guide.Command
		} else if adapter.CanInstall() {
			status.InstallCmd = installCommand(langID)
		}

		applyManagedStatus(&status, adapter, opts.Config, installer)
		applyBinaryStatus(ctx, &status, adapter, opts.Config.BinaryOverride(langID), lookPath, runCheck)
		if langID == CSharpLanguageID {
			applyCSharpStatus(ctx, &status, opts, lookPath, runCheck, runCommand, installer)
		} else if langID == DartLanguageID {
			applyDartStatus(ctx, &status, opts, runCommand)
		} else {
			status.LogPath = LanguageLogPath(opts.Root, langID)
		}
		applyLiveStatus(&status, opts.Status[langID], opts.Servers[langID])
		finalizeRuntimeStatus(&status)
		statuses = append(statuses, status)
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].ID < statuses[j].ID })
	return statuses
}

// RuntimeStatuses returns manager-backed runtime status, including live process
// and readiness state when a server exists.
func (m *Manager) RuntimeStatuses(ctx context.Context) []LanguageRuntimeStatus {
	m.mu.Lock()
	adapters := make([]LanguageAdapter, 0, len(m.adapters))
	for _, adapter := range m.adapters {
		adapters = append(adapters, adapter)
	}
	status := make(map[string]ServerStatus, len(m.status))
	for id, serverStatus := range m.status {
		status[id] = serverStatus
	}
	servers := make(map[string]*Server, len(m.servers))
	for id, server := range m.servers {
		servers[id] = server
	}
	opts := RuntimeStatusOptions{
		Root:     m.root,
		Config:   m.config,
		Adapters: adapters,
		Detector: m.detector,
		Status:   status,
		Servers:  servers,
	}
	m.mu.Unlock()
	return CollectRuntimeStatuses(ctx, opts)
}

func detectedRuntimeLanguages(root string, cfg Config, adapters []LanguageAdapter, detector *Detector) map[string]bool {
	seen := make(map[string]bool)
	if root == "" {
		return seen
	}
	extToLang := make(map[string]string)
	for _, adapter := range adapters {
		if !cfg.Enabled(adapter.ID()) {
			continue
		}
		for _, ext := range adapter.Extensions() {
			extToLang[strings.ToLower(ext)] = adapter.ID()
		}
	}
	if detector != nil && detector.Registry != nil {
		for _, lang := range detector.Registry.Languages() {
			if !cfg.Enabled(lang.ID) {
				continue
			}
			for _, ext := range lang.Extensions {
				extToLang[strings.ToLower(ext)] = lang.ID
			}
		}
	}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", ".knowns", "node_modules", "vendor", "target", "dist", "build":
				if path != root {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if langID, ok := extToLang[strings.ToLower(filepath.Ext(path))]; ok {
			seen[langID] = true
		}
		return nil
	})
	return seen
}

func applyManagedStatus(status *LanguageRuntimeStatus, adapter LanguageAdapter, cfg Config, installer *Installer) {
	if installer == nil {
		return
	}
	if adapter.ID() != CSharpLanguageID && len(adapter.RuntimeDeps()) == 0 {
		return
	}
	managed := managedStatusForAdapter(adapter, cfg, installer)
	status.Version = managed.Version
	status.CachePath = managed.CachePath
	status.SelectedPath = managed.SelectedPath
	status.CleanupEligible = managed.CleanupEligible
	status.InstallError = managed.InstallError
	status.UpdateError = managed.UpdateError
	if managed.Installed {
		status.InstallState = RuntimeInstallInstalled
		status.Source = RuntimeSourceKnowns
		status.BinaryPath = managed.SelectedPath
		status.Binary = filepath.Base(managed.SelectedPath)
	}
	if !managed.Installed && managed.InstallError != "" {
		status.InstallState = RuntimeInstallError
	}
}

func managedStatusForAdapter(adapter LanguageAdapter, cfg Config, installer *Installer) ManagedDependencyStatus {
	if adapter.ID() == CSharpLanguageID {
		return installer.Status(dependencyAdapter{id: CSharpLanguageID, deps: []RuntimeDependency{CSharpRoslynRuntimeDependency(cfg)}})
	}
	return installer.Status(adapter)
}

func applyBinaryStatus(ctx context.Context, status *LanguageRuntimeStatus, adapter LanguageAdapter, override string, lookPath func(string) (string, error), runCheck func(context.Context, string, ...string) error) {
	if status.InstallState == RuntimeInstallInstalled && status.Source == RuntimeSourceKnowns && override == "" {
		return
	}
	binary, path, ok := resolveAdapterBinary(ctx, adapter, override, lookPath, runCheck)
	if !ok {
		return
	}
	status.InstallState = RuntimeInstallInstalled
	status.Binary = binary
	status.BinaryPath = path
	status.Source = binarySource(override)
}

func resolveAdapterBinary(ctx context.Context, adapter LanguageAdapter, override string, lookPath func(string) (string, error), runCheck func(context.Context, string, ...string) error) (string, string, bool) {
	binaries := adapter.Binaries()
	if override != "" {
		binaries = []BinaryCandidate{{Name: override}}
	}
	for _, candidate := range binaries {
		path, err := lookPath(candidate.Name)
		if err != nil {
			continue
		}
		if runCheck != nil && len(candidate.CheckArgs) > 0 {
			checkCtx, cancel := context.WithTimeout(ctx, runtimeStatusProbeTimeout)
			err := runCheck(checkCtx, path, candidate.CheckArgs...)
			cancel()
			if err != nil {
				continue
			}
		}
		binary := candidate.Name
		if filepath.IsAbs(binary) {
			binary = filepath.Base(binary)
		}
		return binary, path, true
	}
	return "", "", false
}

func applyCSharpStatus(ctx context.Context, status *LanguageRuntimeStatus, opts RuntimeStatusOptions, lookPath func(string) (string, error), runCheck func(context.Context, string, ...string) error, runCommand func(context.Context, string, ...string) ([]byte, error), installer *Installer) {
	selection := DiscoverCSharpProject(opts.Root, opts.Config.ProjectPathOverride(CSharpLanguageID))
	status.ProjectPath = selection.Path
	status.ProjectKind = selection.Kind

	configuredBackend := opts.Config.BackendOverride(CSharpLanguageID)
	if configuredBackend == "" {
		configuredBackend = CSharpBackendAuto
	}
	status.Backend = configuredBackend
	status.BackendSource = RuntimeSourceAuto
	if configuredBackend != CSharpBackendAuto {
		status.BackendSource = RuntimeSourceConfig
	}
	status.LogPath = CSharpLogPath(opts.Root, configuredBackend)

	if opts.Config.BinaryOverride(CSharpLanguageID) != "" {
		if status.Backend == CSharpBackendAuto {
			status.Backend = "custom"
		}
		status.BackendSource = RuntimeSourceConfig
		return
	}

	cmd, ok := ResolveCSharpBackendWithOptions(ctx, opts.Root, opts.Config, CSharpResolveOptions{
		LookPath:          lookPath,
		RunCheck:          runCheck,
		RunCommand:        runCommand,
		Installer:         installer,
		AutoInstallRoslyn: false,
	})
	status.Attempts = append([]BackendAttempt(nil), cmd.Attempts...)
	if cmd.ProjectPath != "" {
		status.ProjectPath = cmd.ProjectPath
		status.ProjectKind = csharpProjectKind(cmd.ProjectPath)
	}
	if cmd.LogPath != "" {
		status.LogPath = cmd.LogPath
	}
	if cmd.Backend != "" {
		status.Backend = cmd.Backend
	}
	if !ok {
		status.InstallState = RuntimeInstallError
		if status.InstallError == "" {
			status.InstallError = firstAttemptReason(cmd.Attempts)
		}
		return
	}
	status.InstallState = RuntimeInstallInstalled
	status.Binary = cmd.Name
	status.BinaryPath = cmd.Path
	if cmd.Backend == CSharpBackendRoslyn && status.SelectedPath != "" {
		status.Source = RuntimeSourceKnowns
	} else {
		status.Source = RuntimeSourcePATH
	}
}

func firstAttemptReason(attempts []BackendAttempt) string {
	for _, attempt := range attempts {
		if attempt.Status == BackendAttemptFailed && attempt.Reason != "" {
			return attempt.Reason
		}
	}
	return ""
}

func applyDartStatus(ctx context.Context, status *LanguageRuntimeStatus, opts RuntimeStatusOptions, runCommand func(context.Context, string, ...string) ([]byte, error)) {
	status.LogPath = LanguageLogPath(opts.Root, DartLanguageID)
	selection := DiscoverDartProject(opts.Root)
	status.ProjectPath = selection.Path
	status.ProjectKind = selection.Kind
	if status.BinaryPath == "" || runCommand == nil {
		return
	}
	checkCtx, cancel := context.WithTimeout(ctx, runtimeStatusProbeTimeout)
	output, err := runCommand(checkCtx, status.BinaryPath, "--version")
	cancel()
	if err != nil {
		return
	}
	if version := ParseDartSDKVersion(string(output)); version != "" {
		status.Version = version
	}
}

func applyLiveStatus(status *LanguageRuntimeStatus, lifecycle ServerStatus, server *Server) {
	if lifecycle == 0 && server == nil {
		return
	}
	switch lifecycle {
	case StatusDisabled:
		status.RunningState = RuntimeRunningDisabled
	case StatusStarting:
		status.RunningState = RuntimeRunningStarting
	case StatusRunning:
		status.RunningState = RuntimeRunningRunning
	case StatusCrashed:
		status.RunningState = RuntimeRunningCrashed
	case StatusInstalled, StatusNotInstalled:
		status.RunningState = RuntimeRunningStopped
	}
	if server != nil {
		if server.Alive() {
			status.RunningState = RuntimeRunningRunning
			status.ReadinessState = server.ReadinessState()
		} else if status.RunningState == RuntimeRunningRunning {
			status.RunningState = RuntimeRunningCrashed
		}
		if server.Command.LogPath != "" {
			status.LogPath = server.Command.LogPath
		}
	}
}

func finalizeRuntimeStatus(status *LanguageRuntimeStatus) {
	if !status.Enabled {
		status.Status = RuntimeInstallDisabled
		status.InstallState = RuntimeInstallDisabled
		status.RunningState = RuntimeRunningDisabled
		status.ReadinessState = RuntimeReadinessNotApplicable
		return
	}
	if status.InstallState == RuntimeInstallInstalled {
		status.Status = RuntimeInstallInstalled
	} else if status.InstallState == RuntimeInstallError {
		status.Status = RuntimeInstallNotInstalled
	} else {
		status.Status = RuntimeInstallNotInstalled
	}
	switch status.RunningState {
	case RuntimeRunningRunning:
		status.Status = RuntimeRunningRunning
		if status.ReadinessState == "" || status.ReadinessState == RuntimeReadinessNotApplicable {
			status.ReadinessState = RuntimeReadinessUnknown
		}
	case RuntimeRunningStarting:
		status.Status = RuntimeRunningStarting
		status.ReadinessState = RuntimeReadinessIndexing
	case RuntimeRunningCrashed:
		status.Status = RuntimeRunningCrashed
		status.ReadinessState = RuntimeReadinessUnknown
	default:
		if status.Detected && status.InstallState == RuntimeInstallInstalled {
			status.ReadinessState = RuntimeReadinessUnknown
		}
		if status.RunningState == "" {
			status.RunningState = RuntimeRunningUnknown
		}
	}
}

func binarySource(override string) string {
	if override != "" {
		return RuntimeSourceConfig
	}
	return RuntimeSourcePATH
}

func installCommand(languageID string) string {
	if languageID == "" {
		return ""
	}
	return "knowns lsp install " + languageID
}

// LanguageLogPath returns the shared wrapper log path for non-backend-specific
// language servers.
func LanguageLogPath(root, languageID string) string {
	if root == "" || languageID == "" {
		return ""
	}
	return filepath.Join(root, ".knowns", "logs", "lsp", languageID+".log")
}
