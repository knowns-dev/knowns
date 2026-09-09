// Package server provides the HTTP server, REST API, SSE broker, and WebSocket
// support for the Knowns CLI Go rewrite.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
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

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
	"github.com/howznguyen/knowns/internal/lspdaemon"
	serverreadiness "github.com/howznguyen/knowns/internal/readiness"
	"github.com/howznguyen/knowns/internal/registry"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/server/routes"
	"github.com/howznguyen/knowns/internal/services"
	"github.com/howznguyen/knowns/internal/storage"
	ui "github.com/howznguyen/knowns/ui"
	"github.com/rs/cors"
)

// Options configures the server behaviour.
type Options struct {
	Dev                 bool   // enable verbose logging (HTTP requests, WebSocket, etc.)
	Tunnel              bool   // start tunnel automatically on server boot
	Password            string // initial password for WebUI protection (in-memory only)
	AllowTaskHardDelete bool   // trusted server capability; default false
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
	shutdownCh        chan struct{} // Signals graceful shutdown from /api/shutdown endpoint
	cancelServiceMon  context.CancelFunc
	cancelTaskSweep   context.CancelFunc
	prevServiceStatus []services.ServiceStatus
	prevServiceMu     sync.RWMutex
	tunnel            *ServerTunnelManager
	auth              *AuthManager
	lspManager        *lsp.Manager
}

const serviceStatusMonitorInterval = 7 * time.Second
const defaultLSPLeaseCleanupTimeout = 2 * time.Second

// NewServer creates a Server wired to the given store.
// projectRoot is the directory that contains the .knowns/ folder.
// port is the TCP port to listen on (e.g. 3737).
func NewServer(store *storage.Store, projectRoot string, port int, opts Options) *Server {
	// Silence standard log output unless dev mode is enabled.
	if !opts.Dev {
		log.SetOutput(io.Discard)
	}

	s := &Server{
		store:       store,
		sse:         NewSSEBroker(),
		port:        port,
		projectRoot: projectRoot,
		opts:        opts,
		shutdownCh:  make(chan struct{}, 1),
		tunnel:      NewServerTunnelManager(port),
		auth:        NewAuthManager(opts.Password),
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

	// Startup recovery: mark all previously running workspaces as stopped.
	if store != nil {
		if err := store.Workspaces.MarkAllStopped(); err != nil {
			log.Printf("warn: could not mark workspaces stopped: %v", err)
		}
	}

	s.router = s.buildRouter()

	svcCtx, svcCancel := context.WithCancel(context.Background())
	s.cancelServiceMon = svcCancel
	s.startServiceStatusMonitor(svcCtx)
	return s
}

// Start binds the configured port and serves HTTP.
func (s *Server) Start() error {
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(s.port))
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
	if !listenerIsLoopback(listener) && !s.auth.HasPassword() {
		return fmt.Errorf("non-loopback listener requires password protection")
	}
	if s.opts.Tunnel && !s.auth.HasPassword() {
		return fmt.Errorf("tunnel requires password protection")
	}
	defer s.releaseLSPDaemonLease()
	sweepCtx, sweepCancel := context.WithCancel(context.Background())
	s.cancelTaskSweep = sweepCancel
	defer sweepCancel()
	routes.StartTaskAutoArchiveSweeper(sweepCtx, s.activeStore, s.sse, routes.DefaultTaskAutoArchiveInterval)

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
	if s.cancelServiceMon != nil {
		s.cancelServiceMon()
	}
	if s.cancelTaskSweep != nil {
		s.cancelTaskSweep()
	}

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

func listenerIsLoopback(listener net.Listener) bool {
	if listener == nil {
		return false
	}
	addr, ok := listener.Addr().(*net.TCPAddr)
	return ok && addr.IP != nil && addr.IP.IsLoopback()
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
	s.prevServiceStatus = s.detectRuntimeServices(ctx, store, false)
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
			changes := s.detectChangedServices(s.detectRuntimeServices(ctx, store, false))
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

type lspRuntimeStatusClient interface {
	AcquireLease(context.Context, string, time.Duration) ([]lsp.LanguageRuntimeStatus, error)
	RuntimeStatuses(context.Context) ([]lsp.LanguageRuntimeStatus, error)
}

func fetchLSPRuntimeStatuses(ctx context.Context, client lspRuntimeStatusClient, acquireLease bool) ([]lsp.LanguageRuntimeStatus, error) {
	if acquireLease {
		if statuses, err := client.AcquireLease(ctx, "webui", lspdaemon.LeaseTTLFromEnv()); err == nil {
			return statuses, nil
		}
	}
	return client.RuntimeStatuses(ctx)
}

func (s *Server) lspRuntimeStatuses(ctx context.Context, store *storage.Store, acquireLease bool) []lsp.LanguageRuntimeStatus {
	if store == nil {
		return nil
	}
	if lspdaemon.DisabledByEnv() {
		log.Printf("[server] %s", lspdaemon.DisabledWarning())
		if s.lspManager != nil {
			return lspdaemon.AnnotateLocalStatuses(s.lspManager.RuntimeStatuses(ctx), lspdaemon.DaemonStateDisabledByEnv)
		}
		return nil
	}

	if client, err := lspdaemon.EnsureClient(ctx, filepath.Dir(store.Root)); err == nil {
		if statuses, err := fetchLSPRuntimeStatuses(ctx, client, acquireLease); err == nil {
			return statuses
		}
	}
	if s.lspManager != nil {
		return lspdaemon.AnnotateLocalStatuses(s.lspManager.RuntimeStatuses(ctx), lspdaemon.DaemonStateUnavailable)
	}
	return nil
}

func (s *Server) detectRuntimeServices(ctx context.Context, store *storage.Store, acquireLease bool) []services.ServiceStatus {
	return services.DetectAllWithLSPStatusProvider(
		ctx,
		store,
		func(providerCtx context.Context, providerStore *storage.Store) []lsp.LanguageRuntimeStatus {
			return s.lspRuntimeStatuses(providerCtx, providerStore, acquireLease)
		},
	)
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

	readinessOpts := serverreadiness.Options{
		LSP: s.lspRuntimeStatuses(r.Context(), store, true),
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

// runtimeRetryJobRef names one job to release, paired with the project it
// belongs to. A single failure cause shown in the WebUI can span several
// projects, so a "retry this cause" click may carry refs into more than one
// project's queue in one request.
type runtimeRetryJobRef struct {
	ProjectRoot string `json:"projectRoot"`
	JobID       string `json:"jobId"`
}

// runtimeRetryRequest selects what a POST /api/runtime/retry call releases.
// Exactly one of the three scopes applies:
//   - "all": every retained Qdrant dead letter across every project
//     registered with the shared runtime (mirrors `knowns runtime retry
//     --all-projects`).
//   - "project": every retained Qdrant dead letter in ProjectRoot only
//     (mirrors `knowns runtime retry --all`).
//   - "jobs": the explicit (project, job) pairs in Jobs (mirrors
//     `knowns runtime retry <jobID...>`).
type runtimeRetryRequest struct {
	Scope       string               `json:"scope"`
	ProjectRoot string               `json:"projectRoot,omitempty"`
	Jobs        []runtimeRetryJobRef `json:"jobs,omitempty"`
}

// runtimeRetryRefusal records why an explicitly named job was not released.
// Bulk scopes ("all", "project") never produce refusals: RetryDeadLetters
// only ever touches jobs that already satisfy IsReleasableDeadLetter.
type runtimeRetryRefusal struct {
	JobID string `json:"jobId"`
	Error string `json:"error"`
}

// runtimeRetryProjectResult is one project's outcome of a retry request, so
// the UI can report per-project counts rather than one opaque total.
type runtimeRetryProjectResult struct {
	ProjectRoot string                `json:"projectRoot"`
	Released    int                   `json:"released"`
	Refused     []runtimeRetryRefusal `json:"refused,omitempty"`
	Error       string                `json:"error,omitempty"`
}

// handleRuntimeRetry releases retained Qdrant dead-letter jobs back to the
// scheduler. It calls the same exported runtimequeue helpers the `knowns
// runtime retry` CLI command uses (RetryDeadLetters, RetryJob) rather than
// reimplementing the release logic, and enumerates projects for scope "all"
// the same way handleRuntimePs does (runtimequeue.LoadStatus().Project) so
// both endpoints agree on what counts as a project.
//
// POST /api/runtime/retry
func (s *Server) handleRuntimeRetry(w http.ResponseWriter, r *http.Request) {
	var req runtimeRetryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	switch req.Scope {
	case "all":
		status, err := runtimequeue.LoadStatus()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		results := make([]runtimeRetryProjectResult, 0, len(status.Project))
		for _, p := range status.Project {
			result := runtimeRetryProjectResult{ProjectRoot: p.ProjectRoot}
			released, err := runtimequeue.RetryDeadLetters(p.ProjectRoot)
			if err != nil {
				result.Error = err.Error()
			} else {
				result.Released = len(released)
			}
			results = append(results, result)
		}
		writeJSON(w, http.StatusOK, map[string]any{"results": results})

	case "project":
		if strings.TrimSpace(req.ProjectRoot) == "" {
			http.Error(w, "projectRoot is required for scope \"project\"", http.StatusBadRequest)
			return
		}
		result := runtimeRetryProjectResult{ProjectRoot: req.ProjectRoot}
		released, err := runtimequeue.RetryDeadLetters(req.ProjectRoot)
		if err != nil {
			result.Error = err.Error()
		} else {
			result.Released = len(released)
		}
		writeJSON(w, http.StatusOK, map[string]any{"results": []runtimeRetryProjectResult{result}})

	case "jobs":
		if len(req.Jobs) == 0 {
			http.Error(w, "jobs is required for scope \"jobs\"", http.StatusBadRequest)
			return
		}
		order := make([]string, 0, len(req.Jobs))
		byProject := make(map[string][]string, len(req.Jobs))
		for _, ref := range req.Jobs {
			if strings.TrimSpace(ref.ProjectRoot) == "" || strings.TrimSpace(ref.JobID) == "" {
				http.Error(w, "each job requires a projectRoot and a jobId", http.StatusBadRequest)
				return
			}
			if _, seen := byProject[ref.ProjectRoot]; !seen {
				order = append(order, ref.ProjectRoot)
			}
			byProject[ref.ProjectRoot] = append(byProject[ref.ProjectRoot], ref.JobID)
		}
		results := make([]runtimeRetryProjectResult, 0, len(order))
		for _, root := range order {
			result := runtimeRetryProjectResult{ProjectRoot: root}
			for _, jobID := range byProject[root] {
				if _, err := runtimequeue.RetryJob(root, jobID); err != nil {
					result.Refused = append(result.Refused, runtimeRetryRefusal{JobID: jobID, Error: err.Error()})
					continue
				}
				result.Released++
			}
			results = append(results, result)
		}
		writeJSON(w, http.StatusOK, map[string]any{"results": results})

	default:
		http.Error(w, `scope must be one of "all", "project", "jobs"`, http.StatusBadRequest)
	}
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

	// Reject cross-site requests before CORS can answer a preflight.
	r.Use(trustedOriginMiddleware(s.auth.HasPassword))

	// CORS: reflect trusted origins when credentials are used.
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
		routes.SetupAuthRoutes(r, s.auth, s.sse, func() bool {
			if s.opts.Tunnel {
				return false
			}
			return s.tunnel == nil || !s.tunnel.Status().Running
		})
	})

	// --- SSE endpoint ---
	r.Get("/api/events", s.sse.Subscribe)

	// --- Shutdown endpoint (for remote graceful stop) ---
	r.Post("/api/shutdown", s.handleShutdown)

	// --- Status endpoint (project active/inactive) ---
	r.Get("/api/status", s.handleStatus)
	r.Get("/api/runtime/ps", s.handleRuntimePs)
	r.Post("/api/runtime/retry", s.handleRuntimeRetry)

	// --- API routes ---
	r.Route("/api", func(r chi.Router) {
		routes.SetupRoutesWithCapabilitiesAndLSPStatusProvider(
			r,
			s.store,
			s.sse,
			s.projectRoot,
			s.manager,
			routes.TaskRouteCapabilities{HardDelete: s.opts.AllowTaskHardDelete},
			func(ctx context.Context, store *storage.Store) []lsp.LanguageRuntimeStatus {
				return s.lspRuntimeStatuses(ctx, store, true)
			},
		)
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
			routes.SetupTunnelRoutes(r, s.tunnel, s.sse, s.auth.HasPassword)
		})
	}

	// --- Static UI assets ---
	s.mountUI(r)

	return r
}

func trustedOriginMiddleware(allowPublicHost func() bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestHost := r.Host
			if host, _, err := net.SplitHostPort(requestHost); err == nil {
				requestHost = host
			} else {
				requestHost = strings.Trim(requestHost, "[]")
			}
			if !isLoopbackHost(requestHost) && (allowPublicHost == nil || !allowPublicHost()) {
				http.Error(w, "untrusted request host", http.StatusForbidden)
				return
			}

			origin := r.Header.Get("Origin")
			if origin == "" {
				next.ServeHTTP(w, r)
				return
			}
			u, err := url.Parse(origin)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
				http.Error(w, "untrusted request origin", http.StatusForbidden)
				return
			}
			originHost := strings.Trim(u.Hostname(), "[]")
			if !strings.EqualFold(originHost, requestHost) && !(isLoopbackHost(originHost) && isLoopbackHost(requestHost)) {
				http.Error(w, "untrusted request origin", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func (s *Server) activeStore() *storage.Store {
	if s.manager != nil && s.manager.GetStore() != nil {
		return s.manager.GetStore()
	}
	return s.store
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
