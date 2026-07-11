// Package server provides the HTTP server, REST API, SSE broker, and WebSocket
// support for the Knowns CLI Go rewrite.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gorilla/websocket"

	"github.com/howznguyen/knowns/internal/agents/opencode"
	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
	"github.com/howznguyen/knowns/internal/lspdaemon"
	"github.com/howznguyen/knowns/internal/models"
	serverreadiness "github.com/howznguyen/knowns/internal/readiness"
	"github.com/howznguyen/knowns/internal/registry"
	"github.com/howznguyen/knowns/internal/runtimememory"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/server/routes"
	"github.com/howznguyen/knowns/internal/services"
	"github.com/howznguyen/knowns/internal/storage"
	ui "github.com/howznguyen/knowns/ui"
	"github.com/rs/cors"
)

// wsUpgrader is the WebSocket upgrader used for the terminal endpoint.
var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Options configures the server behaviour.
type Options struct {
	Dev      bool   // enable verbose logging (HTTP requests, WebSocket, etc.)
	Tunnel   bool   // start tunnel automatically on server boot
	Password string // initial password for WebUI protection (in-memory only)
}

// Server is the top-level HTTP server.
type Server struct {
	store             *storage.Store
	manager           *storage.Manager // Multi-project store manager (may be nil)
	router            chi.Router
	sse               *SSEBroker
	port              int
	projectRoot       string
	opts              Options
	opencodeDaemon    *opencode.Daemon // Shared OpenCode daemon (may be nil if not configured)
	runtimeOpenCode   *opencode.Config
	opencodeProxy     *httputil.ReverseProxy // Shared proxy singleton — reused across requests
	opencodeProxyMu   sync.RWMutex
	runtimeStatus     opencode.RuntimeStatus
	runtimeStatusMu   sync.RWMutex
	shutdownCh        chan struct{}      // Signals graceful shutdown from /api/shutdown endpoint
	cancelSSEFwd      context.CancelFunc // Cancels the OpenCode SSE forwarder goroutine
	cancelRuntimeMon  context.CancelFunc
	cancelServiceMon  context.CancelFunc
	prevServiceStatus []services.ServiceStatus
	prevServiceMu     sync.RWMutex
	tunnel            *ServerTunnelManager
	auth              *AuthManager
	lspManager        *lsp.Manager
}

type openCodeConfigResolution struct {
	cfg          opencode.Config
	configured   bool
	explicitPort bool
	mode         opencode.RuntimeMode
}

const openCodeHealthMonitorInterval = 15 * time.Second
const serviceStatusMonitorInterval = 7 * time.Second
const defaultLSPLeaseCleanupTimeout = 2 * time.Second

func deriveOpenCodePortCandidates(browserPort int, defaultPort int) []int {
	seen := make(map[int]struct{})
	candidates := make([]int, 0, 3)
	appendCandidate := func(port int) {
		if port <= 0 || port > 65535 {
			return
		}
		if _, exists := seen[port]; exists {
			return
		}
		seen[port] = struct{}{}
		candidates = append(candidates, port)
	}

	if browserPort > 0 {
		base := browserPort * 10
		for offset := 0; offset < 3; offset++ {
			appendCandidate(base + offset)
		}
	}

	if len(candidates) == 0 {
		for offset := 0; offset < 3; offset++ {
			appendCandidate(defaultPort + offset)
		}
	}

	return candidates
}

func resolveOpenCodeConfig(browserPort int, stored *models.OpenCodeServerConfig) openCodeConfigResolution {
	cfg := opencode.DefaultConfig()
	mode := opencode.RuntimeModeManaged
	if stored != nil {
		mode = opencode.NormalizeRuntimeMode(stored.Mode)
		if stored.Host != "" {
			cfg.Host = stored.Host
		}
		cfg.Password = stored.Password
		if stored.Port != 0 {
			cfg.Port = stored.Port
			return openCodeConfigResolution{
				cfg:          cfg,
				configured:   true,
				explicitPort: true,
				mode:         mode,
			}
		}
	}

	candidates := deriveOpenCodePortCandidates(browserPort, cfg.Port)
	if len(candidates) > 0 {
		cfg.Port = candidates[0]
	}
	return openCodeConfigResolution{
		cfg:        cfg,
		configured: true,
		mode:       mode,
	}
}

func newRuntimeStatus(cfg opencode.Config, configured bool, mode opencode.RuntimeMode, agentStatus *opencode.AgentStatus) opencode.RuntimeStatus {
	status := opencode.RuntimeStatus{
		Configured: configured,
		Mode:       mode,
		State:      opencode.RuntimeStateUnavailable,
		Host:       cfg.Host,
		Port:       cfg.Port,
		MinVersion: opencode.MinOpenCodeVersion,
	}
	if agentStatus != nil {
		status.CLIInstalled = agentStatus.Installed
		status.Compatible = agentStatus.Compatible
		status.Version = agentStatus.Version
		status.MinVersion = agentStatus.MinVersion
	}
	return status
}

func applyRuntimeReadiness(status *opencode.RuntimeStatus, readiness opencode.RuntimeReadiness) {
	status.Readiness = readiness
	status.Available = readiness.Healthy
	status.Ready = readiness.Ready
	if readiness.Version != "" {
		status.Version = readiness.Version
	}
	if readiness.Ready {
		status.State = opencode.RuntimeStateReady
		status.LastError = ""
		now := time.Now().UTC()
		status.LastHealthyAt = &now
		return
	}
	status.State = opencode.RuntimeStateDegraded
	if readiness.Error != "" {
		status.LastError = readiness.Error
	}
}

func initializeOpenCodeRuntime(store *storage.Store, browserPort int) (*opencode.Config, *opencode.Daemon, opencode.RuntimeStatus) {
	defaultCfg := opencode.DefaultConfig()
	agentStatus := opencode.DetectOpenCode()
	if store == nil {
		return nil, nil, newRuntimeStatus(defaultCfg, false, opencode.RuntimeModeManaged, agentStatus)
	}

	resolution := resolveOpenCodeConfig(browserPort, store.Config.GetOpenCodeServerConfig())
	status := newRuntimeStatus(resolution.cfg, resolution.configured, resolution.mode, agentStatus)
	if !resolution.configured {
		status.LastError = "OpenCode server is not configured"
		return nil, nil, status
	}

	cfg := resolution.cfg
	if resolution.mode == opencode.RuntimeModeExternal {
		readiness := opencode.NewClient(cfg).Readiness()
		applyRuntimeReadiness(&status, readiness)
		if !readiness.Ready && status.LastError == "" {
			status.LastError = "Configured external OpenCode runtime is not ready"
		}
		if !readiness.Ready {
			return nil, nil, status
		}
		cfgCopy := cfg
		return &cfgCopy, nil, status
	}

	if !agentStatus.Installed {
		status.LastError = "OpenCode CLI not installed"
		return nil, nil, status
	}
	if !agentStatus.Compatible {
		status.LastError = fmt.Sprintf("OpenCode version %s is below minimum %s", agentStatus.Version, agentStatus.MinVersion)
		return nil, nil, status
	}

	if !resolution.explicitPort {
		for _, candidate := range deriveOpenCodePortCandidates(browserPort, cfg.Port) {
			candidateCfg := cfg
			candidateCfg.Port = candidate
			if opencode.NewClient(candidateCfg).Readiness().Ready {
				cfg = candidateCfg
				status.Host = candidateCfg.Host
				status.Port = candidateCfg.Port
				break
			}
		}
	}

	daemon := opencode.NewDaemon(cfg.Host, cfg.Port)
	if err := daemon.EnsureRunning(); err != nil {
		status.LastError = err.Error()
		return nil, nil, status
	}

	readiness := opencode.NewClient(cfg).Readiness()
	applyRuntimeReadiness(&status, readiness)
	if !readiness.Ready && status.LastError == "" {
		status.LastError = "Managed OpenCode runtime is not ready"
	}
	cfgCopy := cfg
	if !readiness.Ready {
		return nil, daemon, status
	}
	return &cfgCopy, daemon, status
}

// buildOpenCodeProxy creates a shared reverse proxy for the OpenCode server.
// The proxy uses a pooled transport with keep-alive so connections are reused
// across requests instead of creating a new TCP connection each time.
func buildOpenCodeProxy(cfg opencode.Config) *httputil.ReverseProxy {
	target, _ := url.Parse(fmt.Sprintf("http://%s:%d", cfg.Host, cfg.Port))

	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = transport
	proxy.FlushInterval = -1 // flush immediately — required for SSE streaming
	proxy.ModifyResponse = func(resp *http.Response) error {
		// Let the Knowns server own CORS for proxied OpenCode responses.
		resp.Header.Del("Access-Control-Allow-Origin")
		resp.Header.Del("Access-Control-Allow-Credentials")
		resp.Header.Del("Access-Control-Allow-Headers")
		resp.Header.Del("Access-Control-Allow-Methods")
		resp.Header.Del("Access-Control-Expose-Headers")
		return nil
	}
	proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, proxyErr error) {
		http.Error(rw, "OpenCode server unavailable: "+proxyErr.Error(), http.StatusBadGateway)
	}

	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = target.Host
		if cfg.Password != "" {
			req.SetBasicAuth(cfg.Username, cfg.Password)
		}
	}

	return proxy
}

// NewServer creates a Server wired to the given store.
// projectRoot is the directory that contains the .knowns/ folder.
// port is the TCP port to listen on (e.g. 3737).
func NewServer(store *storage.Store, projectRoot string, port int, opts Options) *Server {
	// Silence standard log output unless dev mode is enabled.
	// Must be set before initializeOpenCodeRuntime so daemon/runtime logs are also suppressed.
	if !opts.Dev {
		log.SetOutput(io.Discard)
	}

	// Only initialize OpenCode runtime if Chat UI is enabled
	project, _ := store.Config.Load()
	chatEnabled := project != nil && (project.Settings.EnableChatUI == nil || *project.Settings.EnableChatUI)

	var runtimeOpenCode *opencode.Config
	var daemon *opencode.Daemon
	var runtimeStatus opencode.RuntimeStatus

	if chatEnabled {
		runtimeOpenCode, daemon, runtimeStatus = initializeOpenCodeRuntime(store, port)
		if opts.Dev && runtimeStatus.Configured {
			switch runtimeStatus.State {
			case opencode.RuntimeStateReady:
				log.Printf("[server] OpenCode runtime %s ready on %s:%d", runtimeStatus.Mode, runtimeStatus.Host, runtimeStatus.Port)
			case opencode.RuntimeStateDegraded:
				log.Printf("[server] OpenCode runtime %s degraded: %s", runtimeStatus.Mode, runtimeStatus.LastError)
			default:
				if runtimeStatus.LastError != "" {
					log.Printf("[server] OpenCode unavailable: %s", runtimeStatus.LastError)
				}
			}
		}
	}

	s := &Server{
		store:           store,
		sse:             NewSSEBroker(),
		port:            port,
		projectRoot:     projectRoot,
		opts:            opts,
		opencodeDaemon:  daemon,
		runtimeOpenCode: runtimeOpenCode,
		runtimeStatus:   runtimeStatus,
		shutdownCh:      make(chan struct{}, 1),
		tunnel:          NewServerTunnelManager(port),
		auth:            NewAuthManager(opts.Password),
	}

	// Create multi-project manager wrapping the initial store.
	reg := registry.NewRegistry()
	if err := reg.Load(); err != nil {
		log.Printf("warn: could not load project registry: %v", err)
	}
	s.manager = storage.NewManager(store, reg)

	// Create LSP manager if a project store is available.
	if store != nil {
		if cfg, err := store.Config.Load(); err == nil {
			var defaults *storage.ProjectDefaults
			if settings, err := storage.NewEmbeddingSettingsStore().Load(); err == nil {
				defaults = settings.ProjectDefaults
			}
			lspManager := lsp.NewManager(projectRoot, lsp.ConfigFromProjectWithDefaults(cfg, defaults))
			for _, adapter := range adapters.All() {
				if err := lspManager.RegisterAdapter(adapter); err != nil {
					log.Printf("warn: could not register LSP adapter %s: %v", adapter.ID(), err)
				}
			}
			for _, loadErr := range lspManager.RegisterPluginAdapters(lsp.PluginAdapterLoadOptions{}) {
				log.Printf("warn: could not load LSP plugin adapter: %v", loadErr)
			}
			s.lspManager = lspManager
		}
	}

	// Build shared proxy singleton once at startup.
	if runtimeOpenCode != nil {
		s.opencodeProxy = buildOpenCodeProxy(*runtimeOpenCode)
	}

	// Startup recovery: mark all previously running workspaces as stopped.
	if store != nil {
		if err := store.Workspaces.MarkAllStopped(); err != nil {
			log.Printf("warn: could not mark workspaces stopped: %v", err)
		}
	}

	// Startup recovery: mark all streaming chat sessions as idle.
	if store != nil {
		if err := store.Chats.MarkAllIdle(); err != nil {
			log.Printf("warn: could not mark chats idle: %v", err)
		}
	}

	s.router = s.buildRouter()

	// Start OpenCode SSE forwarder — multiplexes OpenCode events into the
	// Knowns SSE stream so each browser tab needs only one SSE connection.
	ctx, cancel := context.WithCancel(context.Background())
	s.cancelSSEFwd = cancel
	s.startOpenCodeSSEForwarder(ctx)
	monitorCtx, monitorCancel := context.WithCancel(context.Background())
	s.cancelRuntimeMon = monitorCancel
	s.startOpenCodeRuntimeMonitor(monitorCtx)
	svcCtx, svcCancel := context.WithCancel(context.Background())
	s.cancelServiceMon = svcCancel
	s.startServiceStatusMonitor(svcCtx)

	return s
}

// Start binds the configured port and serves HTTP.
func (s *Server) Start() error {
	addr := ":" + strconv.Itoa(s.port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", addr, err)
	}
	return s.serve(listener)
}

// StartWithListener serves HTTP on an already-bound listener.
// Use this when the caller has pre-bound the port (avoids TOCTOU race).
func (s *Server) StartWithListener(listener net.Listener) error {
	return s.serve(listener)
}

func (s *Server) serve(listener net.Listener) error {
	defer s.releaseLSPDaemonLease()

	// Port is bound — now safe to write the port file.
	if err := s.writePortFile(); err != nil {
		fmt.Fprintf(os.Stderr, "warn: could not write .server-port: %v\n", err)
	}
	if err := s.savePortToConfig(); err != nil {
		fmt.Fprintf(os.Stderr, "warn: could not save port to config: %v\n", err)
	}

	srv := &http.Server{Handler: s.router}

	// Auto-start tunnel if requested.
	if s.opts.Tunnel {
		go s.autoStartTunnel()
	}

	serverErr := make(chan error, 1)
	go func() {
		if err := srv.Serve(listener); err != nil && err != http.ErrServerClosed {
			serverErr <- err
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	select {
	case <-quit:
		signal.Stop(quit)
	case err := <-serverErr:
		s.cleanupPortFile()
		return fmt.Errorf("server error: %w", err)
	case <-s.shutdownCh:
		log.Printf("[server] Remote shutdown requested")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("[server] HTTP server shutdown error: %v", err)
	}

	s.cleanupPortFile()
	if s.cancelSSEFwd != nil {
		s.cancelSSEFwd()
	}
	if s.cancelRuntimeMon != nil {
		s.cancelRuntimeMon()
	}
	if s.cancelServiceMon != nil {
		s.cancelServiceMon()
	}
	s.cleanupOpenCodeServer()

	// Stop tunnel if it was started by this server
	if s.tunnel != nil {
		status := s.tunnel.Status()
		if status.Running && status.StartedByUs {
			s.tunnel.Stop()
		}
	}

	// Stop all LSP servers
	if s.lspManager != nil {
		s.lspManager.StopAll(context.Background())
	}

	log.Printf("[server] Shutdown complete")
	return nil
}

func (s *Server) releaseLSPDaemonLease() {
	roots := make(map[string]struct{}, 2)
	if s.projectRoot != "" {
		roots[s.projectRoot] = struct{}{}
	}
	if s.manager != nil {
		if store := s.manager.GetStore(); store != nil && store.Root != "" {
			roots[filepath.Dir(store.Root)] = struct{}{}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), defaultLSPLeaseCleanupTimeout)
	defer cancel()
	for root := range roots {
		client, err := lspdaemon.NewClient(root)
		if err != nil {
			continue
		}
		_ = client.TryReleaseLease(ctx, "webui")
	}
}

// reinitOpenCode tears down the existing OpenCode runtime and starts a fresh
// one for the newly active project. Called after a workspace switch.
func (s *Server) reinitOpenCode(projectPath string) {
	// Stop the old daemon if we started it.
	s.cleanupOpenCodeServer()
	if s.cancelSSEFwd != nil {
		s.cancelSSEFwd()
	}
	if s.cancelRuntimeMon != nil {
		s.cancelRuntimeMon()
	}
	if s.cancelServiceMon != nil {
		s.cancelServiceMon()
	}

	store := s.manager.GetStore()
	runtimeOpenCode, daemon, runtimeStatus := initializeOpenCodeRuntime(store, s.port)

	s.opencodeProxyMu.Lock()
	s.opencodeDaemon = daemon
	s.runtimeOpenCode = runtimeOpenCode
	s.opencodeProxy = nil // force rebuild on next request
	if runtimeOpenCode != nil {
		s.opencodeProxy = buildOpenCodeProxy(*runtimeOpenCode)
	}
	s.opencodeProxyMu.Unlock()
	s.setRuntimeStatus(runtimeStatus)

	ctx, cancel := context.WithCancel(context.Background())
	s.cancelSSEFwd = cancel
	s.startOpenCodeSSEForwarder(ctx)

	monCtx, monCancel := context.WithCancel(context.Background())
	s.cancelRuntimeMon = monCancel
	s.startOpenCodeRuntimeMonitor(monCtx)

	svcCtx, svcCancel := context.WithCancel(context.Background())
	s.cancelServiceMon = svcCancel
	s.startServiceStatusMonitor(svcCtx)

	// Broadcast updated runtime status so the UI reflects the new state
	// without requiring a full page reload.
	s.sse.Broadcast(routes.SSEEvent{
		Type: "opencode:status",
		Data: runtimeStatus,
	})
}

func (s *Server) cleanupOpenCodeServer() {
	if s.opencodeDaemon != nil && s.opencodeDaemon.StartedByUs() {
		if err := s.opencodeDaemon.Stop(); err != nil {
			log.Printf("[server] Failed to stop OpenCode daemon: %v", err)
		}
	}
}

type serviceStatusChange struct {
	Name           string                 `json:"name"`
	Type           string                 `json:"type"`
	PreviousStatus string                 `json:"previousStatus"`
	Status         string                 `json:"status"`
	Timestamp      time.Time              `json:"timestamp"`
	Service        services.ServiceStatus `json:"service"`
}

func serviceStatusKey(status services.ServiceStatus) string {
	if language := status.Details["language"]; language != "" {
		return status.Type + ":" + language
	}
	return status.Type + ":" + status.Name
}

func serviceStatusChanged(prev, next services.ServiceStatus) bool {
	return prev.Status != next.Status || prev.PID != next.PID || prev.Port != next.Port || prev.EnabledInConfig != next.EnabledInConfig
}

func (s *Server) detectChangedServices(next []services.ServiceStatus) []serviceStatusChange {
	s.prevServiceMu.Lock()
	defer s.prevServiceMu.Unlock()

	prevByKey := make(map[string]services.ServiceStatus, len(s.prevServiceStatus))
	for _, status := range s.prevServiceStatus {
		prevByKey[serviceStatusKey(status)] = status
	}

	now := time.Now().UTC()
	changes := make([]serviceStatusChange, 0)
	for _, status := range next {
		key := serviceStatusKey(status)
		prev, seen := prevByKey[key]
		if !seen || !serviceStatusChanged(prev, status) {
			continue
		}
		changes = append(changes, serviceStatusChange{
			Name:           status.Name,
			Type:           status.Type,
			PreviousStatus: prev.Status,
			Status:         status.Status,
			Timestamp:      now,
			Service:        status,
		})
	}
	s.prevServiceStatus = next
	return changes
}

func (s *Server) startServiceStatusMonitor(ctx context.Context) {
	store := s.activeStore()
	if store == nil {
		return
	}

	s.prevServiceMu.Lock()
	s.prevServiceStatus = services.DetectAll(store)
	s.prevServiceMu.Unlock()

	go func() {
		ticker := time.NewTicker(serviceStatusMonitorInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}

			store := s.activeStore()
			if store == nil {
				continue
			}
			changes := s.detectChangedServices(services.DetectAll(store))
			if len(changes) == 0 {
				continue
			}
			s.sse.Broadcast(routes.SSEEvent{
				Type: "service:status",
				Data: changes,
			})
		}
	}()
}

func (s *Server) setRuntimeStatus(status opencode.RuntimeStatus) {
	s.runtimeStatusMu.Lock()
	s.runtimeStatus = status
	s.runtimeStatusMu.Unlock()
}

func (s *Server) updateRuntimeStatus(mut func(*opencode.RuntimeStatus)) opencode.RuntimeStatus {
	s.runtimeStatusMu.Lock()
	defer s.runtimeStatusMu.Unlock()
	mut(&s.runtimeStatus)
	return s.runtimeStatus
}

func (s *Server) runtimeStatusSnapshot() opencode.RuntimeStatus {
	s.runtimeStatusMu.RLock()
	defer s.runtimeStatusMu.RUnlock()
	return s.runtimeStatus
}

func (s *Server) startOpenCodeRuntimeMonitor(ctx context.Context) {
	status := s.runtimeStatusSnapshot()
	if status.Mode != opencode.RuntimeModeManaged || s.opencodeDaemon == nil {
		return
	}

	go func() {
		ticker := time.NewTicker(openCodeHealthMonitorInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}

			cfg, configured := s.openCodeConfig()
			if !configured {
				continue
			}

			readiness := opencode.NewClient(cfg).Readiness()
			if readiness.Ready {
				s.updateRuntimeStatus(func(status *opencode.RuntimeStatus) {
					applyRuntimeReadiness(status, readiness)
				})
				continue
			}

			s.updateRuntimeStatus(func(status *opencode.RuntimeStatus) {
				applyRuntimeReadiness(status, readiness)
			})

			if err := s.opencodeDaemon.EnsureRunning(); err != nil {
				s.updateRuntimeStatus(func(status *opencode.RuntimeStatus) {
					status.State = opencode.RuntimeStateDegraded
					status.Ready = false
					status.Available = false
					status.LastError = err.Error()
				})
				continue
			}

			readiness = opencode.NewClient(cfg).Readiness()
			s.updateRuntimeStatus(func(status *opencode.RuntimeStatus) {
				status.RestartCount++
				applyRuntimeReadiness(status, readiness)
			})
		}
	}()
}

// startOpenCodeSSEForwarder subscribes to the OpenCode global SSE stream and
// re-broadcasts every event through the Knowns SSEBroker as "opencode:event".
// This eliminates the need for each browser tab to open its own EventSource to
// OpenCode, reducing per-tab SSE connections from 2 to 1 and avoiding HTTP/1.1
// connection exhaustion when multiple tabs are open.
func (s *Server) startOpenCodeSSEForwarder(ctx context.Context) {
	cfg, configured := s.openCodeConfig()
	if !configured {
		return
	}

	go func() {
		client := opencode.NewClient(cfg)
		backoff := time.Second

		for {
			select {
			case <-ctx.Done():
				return
			default:
			}

			if !client.IsServerAvailable() {
				select {
				case <-ctx.Done():
					return
				case <-time.After(backoff):
					if backoff < 30*time.Second {
						backoff *= 2
					}
					continue
				}
			}

			backoff = time.Second
			log.Printf("[sse-fwd] Connected to OpenCode global event stream")

			err := client.StreamGlobalEvents(ctx, func(event map[string]any) {
				s.sse.Broadcast(routes.SSEEvent{
					Type: "opencode:event",
					Data: event,
				})
			})

			if ctx.Err() != nil {
				return
			}
			log.Printf("[sse-fwd] OpenCode event stream disconnected: %v, reconnecting...", err)

			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
		}
	}()
}

// writePortFile saves the active port to .knowns/.server-port so CLI commands
// can discover the running server.
func (s *Server) writePortFile() error {
	if s.store == nil {
		return nil
	}
	portFile := filepath.Join(s.store.Root, ".server-port")
	return os.WriteFile(portFile, []byte(strconv.Itoa(s.port)), 0644)
}

// autoStartTunnel starts the tunnel and broadcasts initial status.
func (s *Server) autoStartTunnel() {
	tunnel := s.tunnel
	if tunnel == nil {
		return
	}
	url, err := tunnel.Start()
	if err != nil {
		fmt.Fprintf(os.Stderr, "  %s  %s\n", "✗", "tunnel failed to start: "+err.Error())
		return
	}
	status := tunnel.Status()
	if s.sse != nil {
		s.sse.Broadcast(routes.SSEEvent{Type: "tunnel:status", Data: status})
	}
	fmt.Printf("  %s  %s  %s\n", "⇄", url, "(cloudflared)")
	fmt.Println()
}

// cleanupPortFile removes the .server-port file on shutdown so stale port
// references don't linger after the server exits.
func (s *Server) cleanupPortFile() {
	if s.store == nil {
		return
	}
	portFile := filepath.Join(s.store.Root, ".server-port")
	os.Remove(portFile)
}

// handleStatus returns whether a project is currently active.
// GET /api/status
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	var store *storage.Store
	active := s.store != nil
	if s.manager != nil {
		store = s.manager.GetStore()
		active = store != nil
	} else if s.store != nil {
		store = s.store
	}

	if !active || store == nil {
		writeJSON(w, http.StatusOK, serverreadiness.InactivePayload())
		return
	}

	// Build runtime snapshot from cached OpenCode status.
	var rtStatus *serverreadiness.RuntimeStatus
	rs := s.runtimeStatusSnapshot()
	if rs.Configured {
		state := "stopped"
		if rs.Ready {
			state = "healthy"
		} else if rs.Available {
			state = "degraded"
		}
		rtStatus = &serverreadiness.RuntimeStatus{
			Enabled:          true,
			Running:          rs.Available,
			ConnectedClients: 0, // not tracked at this level yet
			QueuedJobs:       0,
			RunningJobs:      0,
			State:            state,
		}
	}

	readinessOpts := serverreadiness.Options{Runtime: rtStatus}
	if lspdaemon.DisabledByEnv() {
		log.Printf("[server] %s", lspdaemon.DisabledWarning())
		if s.lspManager != nil {
			readinessOpts.LSP = lspdaemon.AnnotateLocalStatuses(s.lspManager.RuntimeStatuses(r.Context()), lspdaemon.DaemonStateDisabledByEnv)
		}
	} else if client, err := lspdaemon.EnsureClient(r.Context(), s.projectRoot); err == nil {
		_, _ = client.AcquireLease(r.Context(), "webui", lspdaemon.LeaseTTLFromEnv())
		if statuses, err := client.RuntimeStatuses(r.Context()); err == nil {
			readinessOpts.LSP = statuses
		}
	}
	if s.lspManager != nil && len(readinessOpts.LSP) == 0 {
		readinessOpts.LSP = lspdaemon.AnnotateLocalStatuses(s.lspManager.RuntimeStatuses(r.Context()), lspdaemon.DaemonStateUnavailable)
	}
	payload := serverreadiness.BuildReadiness(store, readinessOpts)
	writeJSON(w, http.StatusOK, payload)
}

// handleShutdown handles POST /api/shutdown for graceful remote stop.
func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "shutting down"})
	// Signal the main loop to initiate graceful shutdown.
	select {
	case s.shutdownCh <- struct{}{}:
	default:
	}
}

type runtimeProjectSnapshot struct {
	Root    string                   `json:"root"`
	Running []runtimequeue.Job       `json:"running"`
	Queued  []runtimequeue.Job       `json:"queued"`
	Recent  []runtimequeue.JobResult `json:"recent"`
}

func collectRuntimeProjectJobs(status *runtimequeue.Status) []runtimeProjectSnapshot {
	out := make([]runtimeProjectSnapshot, 0, len(status.Project))
	for _, p := range status.Project {
		queue, err := runtimequeue.LoadQueue(p.ProjectRoot)
		if err != nil {
			continue
		}
		snap := runtimeProjectSnapshot{Root: p.ProjectRoot}
		for _, job := range queue.Jobs {
			if job == nil {
				continue
			}
			if job.StartedAt != nil {
				snap.Running = append(snap.Running, *job)
			} else {
				snap.Queued = append(snap.Queued, *job)
			}
		}
		snap.Recent = queue.Recent
		out = append(out, snap)
	}
	return out
}

func (s *Server) handleRuntimePs(w http.ResponseWriter, r *http.Request) {
	status, err := runtimequeue.LoadStatus()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":   status,
		"projects": collectRuntimeProjectJobs(status),
	})
}

// savePortToConfig persists the server port into config.json so the browser
// and other tools can discover the running server.
func (s *Server) savePortToConfig() error {
	if s.store == nil {
		return nil
	}
	project, err := s.store.Config.Load()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	project.Settings.ServerPort = s.port
	return s.store.Config.Save(project)
}

// buildRouter assembles the chi.Router with all middleware and route groups.
func (s *Server) buildRouter() chi.Router {
	r := chi.NewRouter()

	// --- Middleware ---
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	if s.opts.Dev {
		r.Use(middleware.Logger)
	}

	// CORS: reflect origin when credentials are used.
	c := cors.New(cors.Options{
		AllowOriginFunc:  func(origin string) bool { return true },
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	})
	r.Use(c.Handler)

	// --- Auth middleware (no-op when no password is set) ---
	r.Use(s.auth.Middleware)

	// --- Auth routes (always accessible, bypasses auth middleware) ---
	r.Route("/api/auth", func(r chi.Router) {
		routes.SetupAuthRoutes(r, s.auth, s.sse)
	})

	// --- SSE endpoint ---
	r.Get("/api/events", s.sse.Subscribe)

	// --- Shutdown endpoint (for remote graceful stop) ---
	r.Post("/api/shutdown", s.handleShutdown)

	// --- Status endpoint (project active/inactive) ---
	r.Get("/api/status", s.handleStatus)
	r.Get("/api/runtime/ps", s.handleRuntimePs)

	// --- API routes ---
	r.Route("/api", func(r chi.Router) {
		routes.SetupRoutes(r, s.store, s.sse, s.projectRoot, s.manager, s.reinitOpenCode)
	})

	// --- LSP language management routes ---
	if s.lspManager != nil {
		r.Route("/api/lsp", func(r chi.Router) {
			routes.SetupLSPRoutes(r, s.lspManager, s.store, s.manager, s.sse)
		})
	}

	// --- Tunnel routes (cloudflared tunnel control) ---
	if s.tunnel != nil {
		r.Route("/api/tunnel", func(r chi.Router) {
			routes.SetupTunnelRoutes(r, s.tunnel, s.sse)
		})
	}

	// --- Agent status (CLI installation check) ---
	r.Get("/api/agent/status", s.getAgentStatus)

	// --- OpenCode API proxy (for frontend to call OpenCode directly) ---
	r.Route("/api/opencode", func(r chi.Router) {
		r.Get("/status", s.getOpenCodeStatus)
		r.Get("/*", s.proxyOpenCode)
		r.Post("/*", s.proxyOpenCode)
		r.Put("/*", s.proxyOpenCode)
		r.Patch("/*", s.proxyOpenCode)
		r.Delete("/*", s.proxyOpenCode)
	})

	// --- WebSocket chat ---
	r.Get("/ws/chat", s.handleChatWS)

	// --- Static UI assets ---
	s.mountUI(r)

	return r
}

func (s *Server) openCodeConfig() (opencode.Config, bool) {
	if s.runtimeOpenCode != nil {
		return *s.runtimeOpenCode, true
	}
	if s.store == nil {
		return opencode.DefaultConfig(), false
	}
	resolution := resolveOpenCodeConfig(s.port, s.store.Config.GetOpenCodeServerConfig())
	return resolution.cfg, resolution.configured
}

func (s *Server) refreshRuntimeStatus() opencode.RuntimeStatus {
	status := s.runtimeStatusSnapshot()
	if !status.Configured {
		return status
	}
	if status.Mode == opencode.RuntimeModeManaged && status.State == opencode.RuntimeStateReady {
		return status
	}

	cfg, configured := s.openCodeConfig()
	if !configured {
		return status
	}

	readiness := opencode.NewClient(cfg).Readiness()
	return s.updateRuntimeStatus(func(status *opencode.RuntimeStatus) {
		status.Host = cfg.Host
		status.Port = cfg.Port
		applyRuntimeReadiness(status, readiness)
		if !readiness.Ready && status.LastError == "" {
			status.LastError = readiness.Error
		}
	})
}

// handleChatWS upgrades the connection to WebSocket for chat sessions.
//
// GET /ws/chat?chatId=xxx
func (s *Server) handleChatWS(w http.ResponseWriter, r *http.Request) {
	chatID := r.URL.Query().Get("chatId")
	if chatID == "" {
		http.Error(w, "chatId query parameter is required", http.StatusBadRequest)
		return
	}

	log.Printf("[ws] Chat WS connection request for chat %s", chatID)

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] Upgrade failed for chat %s: %v", chatID, err)
		return
	}
	defer conn.Close()

	// Read loop keeps connection alive until client disconnects.
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			log.Printf("[ws] Chat WS disconnected for chat %s: %v", chatID, err)
			break
		}
	}
}

// getOrRebuildProxy returns the shared proxy singleton, rebuilding it if the
// runtime config has changed (e.g. after a config reload).
func (s *Server) getOrRebuildProxy(cfg opencode.Config) *httputil.ReverseProxy {
	s.opencodeProxyMu.RLock()
	p := s.opencodeProxy
	s.opencodeProxyMu.RUnlock()
	if p != nil {
		return p
	}
	// First request after a config change — build and cache.
	newProxy := buildOpenCodeProxy(cfg)
	s.opencodeProxyMu.Lock()
	s.opencodeProxy = newProxy
	s.opencodeProxyMu.Unlock()
	return newProxy
}

// proxyOpenCode proxies requests to the OpenCode server using a shared
// reverse proxy singleton so TCP connections are pooled and reused.
func (s *Server) proxyOpenCode(w http.ResponseWriter, r *http.Request) {
	status := s.refreshRuntimeStatus()
	if !status.Ready {
		message := status.LastError
		if message == "" {
			message = "OpenCode runtime is not ready"
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": message})
		return
	}

	cfg, configured := s.openCodeConfig()
	if !configured {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "OpenCode server is not configured"})
		return
	}

	proxy := s.getOrRebuildProxy(cfg)

	// Rewrite the path: strip the /api/opencode prefix before forwarding.
	r2 := r.Clone(r.Context())
	r2.URL.Path = strings.TrimPrefix(r.URL.Path, "/api/opencode")
	if r2.URL.Path == "" {
		r2.URL.Path = "/"
	}
	r2.URL.RawQuery = r.URL.RawQuery

	// Resolve the active project root per-request so workspace switches
	// are reflected immediately without restarting the server.
	activeRoot := s.projectRoot
	if s.manager != nil && s.manager.GetStore() != nil {
		activeRoot = s.manager.ActiveProjectRoot()
	}

	// Auto-inject directory for session listing so OpenCode only returns
	// sessions belonging to this project (avoids cross-project leakage).
	if r2.URL.Path == "/session" && r.Method == "GET" && activeRoot != "" {
		q := r2.URL.Query()
		if q.Get("directory") == "" {
			q.Set("directory", activeRoot)
			r2.URL.RawQuery = q.Encode()
		}
	}

	if activeRoot != "" && r2.Header.Get("x-opencode-directory") == "" {
		r2.Header.Set("x-opencode-directory", activeRoot)
	}

	inspection, err := s.prepareOpenCodeRuntimeMemory(r2, activeRoot)
	if err != nil {
		http.Error(w, "could not prepare runtime memory: "+err.Error(), http.StatusBadRequest)
		return
	}
	setRuntimeMemoryHeaders(w.Header(), inspection)

	proxy.ServeHTTP(w, r2)
}

func (s *Server) activeStore() *storage.Store {
	if s.manager != nil && s.manager.GetStore() != nil {
		return s.manager.GetStore()
	}
	return s.store
}

type runtimeMemoryInspection struct {
	Mode string
	Pack runtimememory.Pack
}

func (s *Server) prepareOpenCodeRuntimeMemory(r *http.Request, activeRoot string) (runtimeMemoryInspection, error) {
	inspection := runtimeMemoryInspection{Mode: runtimememory.ModeAuto, Pack: runtimememory.Pack{Runtime: "opencode", Mode: runtimememory.ModeAuto, Status: runtimememory.StatusNone}}
	store := s.activeStore()
	if store == nil || !shouldPrepareRuntimeMemory(r) {
		return inspection, nil
	}
	settings := runtimememory.NormalizeSettings(nil)
	if project, err := store.Config.Load(); err == nil {
		settings = runtimememory.NormalizeSettings(project.Settings.RuntimeMemory)
	}
	mode := settings.Mode
	if override := runtimememory.NormalizeMode(r.Header.Get(runtimememory.HeaderMode)); override != "" {
		mode = override
	}
	inspection.Mode = mode
	inspection.Pack = runtimememory.Pack{Runtime: "opencode", Mode: mode, Status: runtimememory.StatusNone}
	if mode == runtimememory.ModeOff {
		inspection.Pack.SkipReason = runtimememory.SkipReasonModeOff
		return inspection, nil
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		return inspection, err
	}
	resetRequestBody(r, body)
	if len(body) == 0 {
		return inspection, nil
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return inspection, nil
	}
	pack, err := runtimememory.Build(store, runtimememory.Input{
		Runtime:     "opencode",
		ProjectRoot: activeRoot,
		WorkingDir:  activeRoot,
		ActionType:  inferOpenCodeActionType(r.URL.Path),
		UserPrompt:  extractOpenCodePrompt(payload),
		Mode:        mode,
		MaxItems:    settings.MaxItems,
		MaxBytes:    settings.MaxBytes,
	})
	if err != nil {
		return inspection, err
	}
	if _, outcome, err := runtimememory.CaptureWithOutcome(store, runtimememory.Input{
		Runtime:     "opencode",
		ProjectRoot: activeRoot,
		WorkingDir:  activeRoot,
		ActionType:  inferOpenCodeActionType(r.URL.Path),
		UserPrompt:  extractOpenCodePrompt(payload),
		Mode:        mode,
		MaxItems:    settings.MaxItems,
		MaxBytes:    settings.MaxBytes,
	}); err != nil {
		return inspection, err
	} else {
		pack.Capture = &outcome
	}
	inspection.Pack = pack
	if len(pack.Items) == 0 {
		return inspection, nil
	}

	requested := headerTruthy(r.Header.Get(runtimememory.HeaderInject))
	switch mode {
	case runtimememory.ModeDebug:
		inspection.Pack.Status = runtimememory.StatusCandidate
		return inspection, nil
	case runtimememory.ModeManual:
		if !requested {
			inspection.Pack.Status = runtimememory.StatusCandidate
			return inspection, nil
		}
	}

	payload["system"] = runtimememory.InjectSystemPrompt(stringValue(payload["system"]), pack.Serialized)
	updated, err := json.Marshal(payload)
	if err != nil {
		return inspection, err
	}
	resetRequestBody(r, updated)
	inspection.Pack.Status = runtimememory.StatusInjected
	return inspection, nil
}

func shouldPrepareRuntimeMemory(r *http.Request) bool {
	if r.Method != http.MethodPost {
		return false
	}
	path := r.URL.Path
	return strings.HasSuffix(path, "/prompt_async") || strings.HasSuffix(path, "/message")
}

func inferOpenCodeActionType(path string) string {
	path = strings.TrimSpace(path)
	if strings.HasSuffix(path, "/prompt_async") {
		return "prompt_async"
	}
	if strings.HasSuffix(path, "/message") {
		return "message"
	}
	return strings.Trim(path, "/")
}

func extractOpenCodePrompt(payload map[string]any) string {
	parts, ok := payload["parts"].([]any)
	if !ok {
		return ""
	}
	chunks := make([]string, 0, len(parts))
	for _, raw := range parts {
		part, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		text := strings.TrimSpace(stringValue(part["text"]))
		if text == "" {
			continue
		}
		chunks = append(chunks, text)
	}
	return strings.Join(chunks, "\n")
}

func stringValue(v any) string {
	s, _ := v.(string)
	return s
}

func headerTruthy(v string) bool {
	v = strings.TrimSpace(strings.ToLower(v))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func resetRequestBody(r *http.Request, body []byte) {
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	r.GetBody = func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(body)), nil
	}
	r.Header.Set("Content-Length", strconv.Itoa(len(body)))
}

func setRuntimeMemoryHeaders(header http.Header, inspection runtimeMemoryInspection) {
	header.Set(runtimememory.HeaderMode, inspection.Mode)
	header.Set(runtimememory.HeaderStatus, inspection.Pack.Status)
	header.Set(runtimememory.HeaderItems, strconv.Itoa(len(inspection.Pack.Items)))
	if inspection.Pack.Status == runtimememory.StatusNone {
		return
	}
	header.Set(runtimememory.HeaderPack, runtimememory.EncodePackHeader(inspection.Pack))
}

// getAgentStatus returns the OpenCode CLI installation status.
// GET /api/agent/status
func (s *Server) getAgentStatus(w http.ResponseWriter, r *http.Request) {
	status := opencode.DetectOpenCode()
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) getOpenCodeStatus(w http.ResponseWriter, r *http.Request) {
	status := s.refreshRuntimeStatus()
	writeJSON(w, http.StatusOK, status)
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

// mountUI embeds the compiled React UI assets and serves them at /.
// All non-API, non-asset paths fall through to index.html (SPA support).
func (s *Server) mountUI(r chi.Router) {
	distFS, err := fs.Sub(ui.Assets, "dist")
	if err != nil {
		// If the embed is unavailable (e.g. during development without a build),
		// skip UI serving gracefully.
		return
	}

	fileServer := http.FileServer(http.FS(distFS))

	r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
		path := req.URL.Path

		// Skip paths that look like API routes (belt-and-suspenders).
		if strings.HasPrefix(path, "/api/") {
			http.NotFound(w, req)
			return
		}

		if path == "/" || path == "" {
			path = "index.html"
		} else {
			// Strip leading slash for fs.Stat.
			path = strings.TrimPrefix(path, "/")
		}

		if _, statErr := fs.Stat(distFS, path); statErr == nil {
			fileServer.ServeHTTP(w, req)
			return
		}

		// Fallback to index.html for client-side routing (SPA).
		index, readErr := distFS.Open("index.html")
		if readErr != nil {
			http.NotFound(w, req)
			return
		}
		defer index.Close()

		data, readErr := io.ReadAll(index)
		if readErr != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	})
}
