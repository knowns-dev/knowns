// Package services provides unified status detection for all managed sub-processes:
// OpenCode daemon, LSP servers, and Cloudflared tunnel.
package services

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/howznguyen/knowns/internal/agents/opencode"
	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
	"github.com/howznguyen/knowns/internal/models"
	goruntime "runtime"

	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

// ServiceStatus describes the current state of a managed sub-process.
type ServiceStatus struct {
	Name            string            `json:"name"`
	Type            string            `json:"type"`   // "opencode", "lsp", "cloudflared", "embedding"
	Status          string            `json:"status"` // "running", "stopped", "error", "disabled"
	PID             int               `json:"pid,omitempty"`
	Port            int               `json:"port,omitempty"`
	Uptime          time.Duration     `json:"uptime,omitempty"`
	EnabledInConfig bool              `json:"enabledInConfig"`
	Details         map[string]string `json:"details,omitempty"` // extra info: model, language, URL, etc.
}

// detectionTimeout is the max time each individual detector may spend.
const detectionTimeout = 2 * time.Second

// DetectAll returns status for all managed sub-processes.
// Each detector runs independently and is protected by a 2-second timeout.
// It handles stale PID files gracefully without false "running" status.
func DetectAll(store *storage.Store) []ServiceStatus {
	var proj *models.Project
	if store != nil {
		loaded, err := store.Config.Load()
		if err == nil {
			proj = loaded
		}
	}

	// Gather all statuses; each detector is timeout-protected.
	var (
		mu      sync.Mutex
		results []ServiceStatus
		wg      sync.WaitGroup
	)

	add := func(ss []ServiceStatus) {
		mu.Lock()
		results = append(results, ss...)
		mu.Unlock()
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		add(detectOpenCode(proj))
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		add(detectLSP(proj, filepath.Dir(store.Root)))
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		add(detectCloudflared())
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		add(detectEmbedding(store))
	}()

	wg.Wait()
	return results
}

// ----- OpenCode Daemon Detection -----

func detectOpenCode(proj *models.Project) []ServiceStatus {
	ctx, cancel := context.WithTimeout(context.Background(), detectionTimeout)
	defer cancel()

	ss := ServiceStatus{
		Name:            "OpenCode",
		Type:            "opencode",
		Status:          "stopped",
		Details:         make(map[string]string),
		EnabledInConfig: true,
	}

	// Check if ChatUI (and thus OpenCode daemon) is explicitly disabled.
	if proj != nil && proj.Settings.EnableChatUI != nil && !*proj.Settings.EnableChatUI {
		ss.Status = "disabled"
		ss.EnabledInConfig = false
		return []ServiceStatus{ss}
	}

	cfg := opencode.DefaultConfig()
	if proj != nil && proj.Settings.OpenCodeServerConfig != nil {
		oc := proj.Settings.OpenCodeServerConfig
		if oc.Host != "" {
			cfg.Host = oc.Host
		}
		if oc.Port != 0 {
			cfg.Port = oc.Port
		}
		if oc.Password != "" {
			cfg.Password = oc.Password
		}
	}

	daemon := opencode.NewDaemon(cfg.Host, cfg.Port)

	// Read PID file to get PID (even if stale, we report it for info).
	pid, pidErr := daemon.ReadPID()
	if pidErr == nil && pid > 0 {
		ss.PID = pid
	}

	// Check liveness with timeout.
	alive := isProcessAlive(pid)
	if !alive {
		// Clean up stale PID file.
		if pidErr == nil && pid > 0 {
			os.Remove(daemon.PIDFile)
		}
		ss.Status = "stopped"
		return []ServiceStatus{ss}
	}

	// Process alive — verify HTTP health.
	client := opencode.NewClient(cfg)
	readyCh := make(chan opencode.RuntimeReadiness, 1)
	go func() {
		readyCh <- client.Readiness()
	}()

	select {
	case ready := <-readyCh:
		if ready.Healthy {
			ss.Status = "running"
			ss.Port = cfg.Port
			ss.Details["version"] = ready.Version
			if proj != nil && proj.Settings.OpenCodeServerConfig != nil {
				mode := proj.Settings.OpenCodeServerConfig.Mode
				if mode == "" {
					mode = "managed"
				}
				ss.Details["mode"] = mode
			}
		}
	case <-ctx.Done():
		// Timeout — process alive but HTTP unresponsive.
		ss.Status = "error"
		ss.Details["error"] = "health check timed out"
	}

	// Compute uptime from PID file mtime as approximation.
	if info, statErr := os.Stat(daemon.PIDFile); statErr == nil {
		ss.Uptime = time.Since(info.ModTime())
	}

	return []ServiceStatus{ss}
}

// ----- LSP Server Detection -----

func detectLSP(proj *models.Project, projectRoot string) []ServiceStatus {
	var results []ServiceStatus

	// Determine which languages are configured.
	var defaults *storage.ProjectDefaults
	if settings, err := storage.NewEmbeddingSettingsStore().Load(); err == nil {
		defaults = settings.ProjectDefaults
	}
	lspConfig := lsp.ConfigFromProjectWithDefaults(proj, defaults)

	// If LSP is globally disabled, report one disabled entry.
	if proj != nil && proj.Settings.LSP != nil && proj.Settings.LSP.Enabled != nil && !*proj.Settings.LSP.Enabled {
		results = append(results, ServiceStatus{
			Name:            "LSP (global)",
			Type:            "lsp",
			Status:          "disabled",
			EnabledInConfig: false,
			Details:         make(map[string]string),
		})
		return results
	}

	statuses := lsp.CollectRuntimeStatuses(context.Background(), lsp.RuntimeStatusOptions{
		Root:     projectRoot,
		Config:   lspConfig,
		Adapters: adapters.All(),
	})
	if len(statuses) == 0 {
		results = append(results, ServiceStatus{
			Name:            "LSP",
			Type:            "lsp",
			Status:          "stopped",
			EnabledInConfig: true,
			Details:         map[string]string{"reason": "no languages detected"},
		})
		return results
	}

	for _, runtimeStatus := range statuses {
		ss := ServiceStatus{
			Name:            "LSP (" + runtimeStatus.ID + ")",
			Type:            "lsp",
			Status:          serviceStatusFromLSP(runtimeStatus),
			EnabledInConfig: runtimeStatus.Enabled,
			Details: map[string]string{
				"language":        runtimeStatus.ID,
				"install_state":   runtimeStatus.InstallState,
				"running_state":   runtimeStatus.RunningState,
				"readiness_state": runtimeStatus.ReadinessState,
			},
		}
		addDetail := func(key, value string) {
			if value != "" {
				ss.Details[key] = value
			}
		}
		addDetail("binary", runtimeStatus.Binary)
		addDetail("source", runtimeStatus.Source)
		addDetail("backend", runtimeStatus.Backend)
		addDetail("backend_source", runtimeStatus.BackendSource)
		addDetail("version", runtimeStatus.Version)
		addDetail("selected_path", runtimeStatus.SelectedPath)
		addDetail("project_path", runtimeStatus.ProjectPath)
		addDetail("log_path", runtimeStatus.LogPath)
		addDetail("install_cmd", runtimeStatus.InstallCmd)
		addDetail("install_error", runtimeStatus.InstallError)
		addDetail("update_error", runtimeStatus.UpdateError)
		if runtimeStatus.InstallState != lsp.RuntimeInstallInstalled {
			ss.Details["reason"] = runtimeStatus.InstallState
		}

		results = append(results, ss)
	}

	return results
}

func serviceStatusFromLSP(status lsp.LanguageRuntimeStatus) string {
	switch status.Status {
	case lsp.RuntimeRunningRunning:
		return "running"
	case lsp.RuntimeRunningCrashed, lsp.RuntimeInstallError:
		return "error"
	case lsp.RuntimeInstallDisabled:
		return "disabled"
	default:
		return "stopped"
	}
}

// ----- Cloudflared Tunnel Detection -----

// isProcessRunning checks if a process with the given binary name is running.
func isProcessRunning(name string) bool {
	if goruntime.GOOS == "windows" {
		out, err := exec.Command("tasklist", "/FI", "IMAGENAME eq "+name+".exe", "/NH").Output()
		if err != nil {
			return false
		}
		return strings.Contains(string(out), name)
	}
	err := exec.Command("pgrep", "-f", name).Run()
	return err == nil
}

func detectCloudflared() []ServiceStatus {
	ss := ServiceStatus{
		Name:            "Cloudflared",
		Type:            "cloudflared",
		Status:          "stopped",
		EnabledInConfig: true,
		Details:         make(map[string]string),
	}

	// Check if cloudflared binary is available.
	if _, err := exec.LookPath("cloudflared"); err != nil {
		ss.Status = "stopped"
		ss.Details["reason"] = "cloudflared not installed"
		return []ServiceStatus{ss}
	}

	// Look for PID files matching cloudflared-*.pid in ~/.knowns/.
	stateDir := storage.GlobalRootPath()

	entries, err := os.ReadDir(stateDir)
	if err != nil {
		return []ServiceStatus{ss}
	}

	type tunnelInfo struct {
		pid     int
		url     string
		port    int
		pidFile string
	}
	var tunnels []tunnelInfo

	for _, entry := range entries {
		name := entry.Name()
		if len(name) < 4 || name[len(name)-4:] != ".pid" {
			continue
		}
		if len(name) < 15 || name[:12] != "cloudflared-" {
			continue
		}

		pidFile := stateDir + "/" + name
		data, err := os.ReadFile(pidFile)
		if err != nil {
			continue
		}

		// Extract port from filename: cloudflared-<port>.pid
		portStr := name[12 : len(name)-4]
		var port int
		_, _ = fmt.Sscan(portStr, &port)

		pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
		if err != nil || pid <= 0 {
			continue
		}

		// Check process liveness.
		if !isProcessAlive(pid) {
			os.Remove(pidFile)
			// Also remove corresponding .url file.
			urlFile := pidFile[:len(pidFile)-3] + "url"
			os.Remove(urlFile)
			continue
		}

		// Read URL file if available.
		urlFile := pidFile[:len(pidFile)-3] + "url"
		urlData, err := os.ReadFile(urlFile)
		url := ""
		if err == nil {
			url = strings.TrimSpace(string(urlData))
		}

		tunnels = append(tunnels, tunnelInfo{pid: pid, url: url, port: port, pidFile: pidFile})
	}

	// Report first active tunnel (or stopped if none).
	for _, t := range tunnels {
		ss.Status = "running"
		ss.PID = t.pid
		ss.Port = t.port
		if t.url != "" {
			ss.Details["url"] = t.url
		}
		// Compute uptime from PID file mtime.
		if info, err := os.Stat(t.pidFile); err == nil {
			ss.Uptime = time.Since(info.ModTime())
		}
		return []ServiceStatus{ss}
	}

	return []ServiceStatus{ss}
}

// ----- Embedding Sidecar Detection -----

func detectEmbedding(store *storage.Store) []ServiceStatus {
	ctx, cancel := context.WithTimeout(context.Background(), detectionTimeout)
	defer cancel()

	ss := ServiceStatus{
		Name:            "Embedding",
		Type:            "embedding",
		Status:          "stopped",
		EnabledInConfig: true,
		Details:         make(map[string]string),
	}

	// Check project-level semantic search config.
	proj, err := store.Config.Load()
	if err != nil || proj == nil {
		ss.Status = "disabled"
		ss.EnabledInConfig = false
		ss.Details["reason"] = "could not load project config"
		return []ServiceStatus{ss}
	}

	semCfg := proj.Settings.SemanticSearch
	if semCfg == nil || !semCfg.Enabled {
		ss.Status = "disabled"
		ss.EnabledInConfig = false
		ss.Details["reason"] = "semantic search not enabled in project config"
		return []ServiceStatus{ss}
	}

	ss.EnabledInConfig = true
	ss.Details["provider"] = semCfg.Provider
	if semCfg.Provider == "" {
		ss.Details["provider"] = "local"
	}

	switch semCfg.Provider {
	case "api", "ollama":
		// Check API provider connectivity.
		embStore := storage.NewEmbeddingSettingsStore()
		settings, err := embStore.Load()
		if err != nil {
			ss.Status = "error"
			ss.Details["error"] = "cannot load embedding settings"
			return []ServiceStatus{ss}
		}

		modelID := semCfg.Model
		if modelID == "" {
			modelID = settings.DefaultEmbeddingModel
		}
		if modelID == "" {
			ss.Status = "stopped"
			ss.Details["reason"] = "no embedding model configured"
			return []ServiceStatus{ss}
		}
		ss.Details["model"] = modelID

		model, err := settings.GetModel(modelID)
		if err != nil {
			ss.Status = "error"
			ss.Details["error"] = "model " + modelID + " not found"
			return []ServiceStatus{ss}
		}

		provider, err := settings.GetProvider(model.Provider)
		if err != nil {
			ss.Status = "error"
			ss.Details["error"] = "provider " + model.Provider + " not found"
			return []ServiceStatus{ss}
		}

		ss.Details["model"] = model.Model
		ss.Details["api_base"] = provider.APIBase
		ss.Details["dimensions"] = strconv.Itoa(model.Dimensions)

		// Probe API with timeout.
		embedderCh := make(chan bool, 1)
		go func() {
			cfg := search.APIEmbedderConfig{
				APIBase:    provider.APIBase,
				APIKey:     provider.APIKey,
				Model:      model.Model,
				Dimensions: model.Dimensions,
				Timeout:    provider.Timeout,
				BatchSize:  provider.BatchSize,
			}
			emb, err := search.NewAPIEmbedder(cfg)
			if err != nil {
				embedderCh <- false
				return
			}
			embedderCh <- emb.IsReachable()
		}()

		select {
		case reachable := <-embedderCh:
			if reachable {
				ss.Status = "running"
			} else {
				ss.Status = "error"
				ss.Details["error"] = "API endpoint not reachable"
			}
		case <-ctx.Done():
			ss.Status = "error"
			ss.Details["error"] = "health check timed out"
		}

	case "local", "":
		// Check ONNX runtime model availability.
		ss.Details["model"] = semCfg.HuggingFaceID
		if semCfg.Dimensions > 0 {
			ss.Details["dimensions"] = strconv.Itoa(semCfg.Dimensions)
		}

		// Check if ONNX model files exist.
		modelDir := filepath.Join(storage.GlobalRootPath(), ".search", "models", semCfg.HuggingFaceID)
		if _, err := os.Stat(modelDir); err == nil {
			// Check for .onnx file.
			entries, err := os.ReadDir(modelDir)
			if err == nil {
				for _, e := range entries {
					if strings.HasSuffix(e.Name(), ".onnx") {
						ss.Status = "stopped"
						ss.Details["note"] = "model available, runtime not active"
						return []ServiceStatus{ss}
					}
				}
			}
		}
		ss.Status = "stopped"
		ss.Details["reason"] = "local model not downloaded"

	default:
		ss.Status = "stopped"
		ss.Details["reason"] = "unknown provider: " + semCfg.Provider
	}

	return []ServiceStatus{ss}
}

// ----- Helper: PID Liveness Check -----

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}
