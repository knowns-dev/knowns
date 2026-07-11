package lspdaemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
	"github.com/howznguyen/knowns/internal/storage"
)

func Run(ctx context.Context, root string) error {
	return RunWithOptions(ctx, root, RunOptions{IdleTimeout: IdleTimeoutFromEnv()})
}

type RunOptions struct {
	IdleTimeout time.Duration
}

func RunWithOptions(ctx context.Context, root string, opts RunOptions) error {
	identity, err := IdentifyProject(root)
	if err != nil {
		return err
	}
	paths := PathsForIdentity(identity)
	if err := paths.EnsureDir(); err != nil {
		return err
	}
	token, err := EnsureToken(paths)
	if err != nil {
		return err
	}
	manager, err := newProjectManager(identity.Root)
	if err != nil {
		return err
	}
	defer manager.StopAll(context.Background())

	listener, err := listenEndpoint(paths)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer cleanupEndpoint(paths)

	state := NewState(paths, os.Getpid())
	if err := WriteState(paths, state); err != nil {
		return err
	}

	server := &Server{
		identity:    identity,
		paths:       paths,
		token:       token,
		manager:     manager,
		idleTimeout: opts.IdleTimeout,
		leases:      make(map[string]lease),
	}
	server.markActivity()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	if opts.IdleTimeout > 0 {
		go server.monitorIdle(ctx, listener)
	}

	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go server.handle(conn)
	}
}

type Server struct {
	identity ProjectIdentity
	paths    Paths
	token    string
	manager  *lsp.Manager
	active   atomic.Int64

	idleTimeout  time.Duration
	lastActivity atomic.Int64
	leasesMu     sync.Mutex
	leases       map[string]lease
}

type lease struct {
	Owner     string
	ExpiresAt time.Time
}

func (s *Server) handle(conn net.Conn) {
	s.markActivity()
	s.active.Add(1)
	defer func() {
		s.active.Add(-1)
		s.markActivity()
	}()
	defer conn.Close()

	var req Request
	decoder := json.NewDecoder(conn)
	if err := decoder.Decode(&req); err != nil {
		_ = json.NewEncoder(conn).Encode(Response{Error: err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp := s.dispatch(ctx, req)
	_ = json.NewEncoder(conn).Encode(resp)
}

func (s *Server) dispatch(ctx context.Context, req Request) Response {
	if err := ValidateHandshake(s.identity, s.token, req.Handshake); err != nil {
		return Response{Error: err.Error()}
	}

	var resp Response
	var err error
	switch req.Operation {
	case OperationPing:
		return Response{}
	case OperationDefinition:
		resp.Location, err = s.withSessionLocation(ctx, req, func(session lsp.Session) (lsp.Location, error) {
			return session.Definition(ctx, req.Path, req.Line, req.Character)
		})
	case OperationReferences:
		resp.Locations, err = s.withSessionLocations(ctx, req, func(session lsp.Session) ([]lsp.Location, error) {
			return session.References(ctx, req.Path, req.Line, req.Character)
		})
	case OperationImplementations:
		resp.Locations, err = s.withSessionLocations(ctx, req, func(session lsp.Session) ([]lsp.Location, error) {
			return session.Implementations(ctx, req.Path, req.Line, req.Character)
		})
	case OperationDiagnostics:
		resp.Diagnostics, err = s.withSessionDiagnostics(ctx, req, func(session lsp.Session) ([]lsp.Diagnostic, error) {
			return session.Diagnostics(ctx, req.Path)
		})
	case OperationDocumentSymbols:
		resp.DocumentSymbols, err = s.withSessionSymbols(ctx, req, func(session lsp.Session) ([]lsp.DocumentSymbol, error) {
			return session.DocumentSymbols(ctx, req.Path)
		})
	case OperationWorkspaceSymbol:
		resp.WorkspaceSymbolResults, err = s.workspaceSymbols(ctx, req.Query)
	case OperationRename:
		resp.WorkspaceEdit, err = s.withSessionEdit(ctx, req, func(session lsp.Session) (*lsp.WorkspaceEdit, error) {
			return session.Rename(ctx, req.Path, req.Line, req.Character, req.NewName)
		})
	case OperationDidChange:
		err = s.withSessionVoid(ctx, req, func(session lsp.Session) error {
			return session.DidChange(ctx, req.Path, req.Text)
		})
	case OperationStatus:
		resp.Statuses = s.runtimeStatuses(ctx)
	case OperationStartLanguage:
		err = s.manager.StartLanguage(ctx, req.Language)
		if err == nil {
			resp.Statuses = s.runtimeStatuses(ctx)
		}
	case OperationStopLanguage:
		err = s.manager.StopLanguage(req.Language)
		if err == nil {
			resp.Statuses = s.runtimeStatuses(ctx)
		}
	case OperationRestartLanguage:
		err = s.manager.RestartLanguage(ctx, req.Language)
		if err == nil {
			resp.Statuses = s.runtimeStatuses(ctx)
		}
	case OperationApplyConfig:
		err = s.reloadConfig()
		if err == nil {
			resp.Statuses = s.runtimeStatuses(ctx)
		}
	case OperationAcquireLease:
		err = s.acquireLease(req.Owner, time.Duration(req.TTLMillis)*time.Millisecond)
		if err == nil {
			resp.Statuses = s.runtimeStatuses(ctx)
		}
	case OperationReleaseLease:
		err = s.releaseLease(req.Owner)
		if err == nil {
			resp.Statuses = s.runtimeStatuses(ctx)
		}
	default:
		err = fmt.Errorf("unsupported LSP daemon operation: %s", req.Operation)
	}
	if err != nil {
		return s.errorResponse(req.Path, err)
	}
	return resp
}

func (s *Server) reloadConfig() error {
	store := storage.NewStore(filepath.Join(s.identity.Root, ".knowns"))
	project, err := store.Config.Load()
	if err != nil {
		return err
	}
	var defaults *storage.ProjectDefaults
	if settings, err := storage.NewEmbeddingSettingsStore().Load(); err == nil {
		defaults = settings.ProjectDefaults
	}
	s.manager.SetConfig(lsp.ConfigFromProjectWithDefaults(project, defaults))
	return nil
}

func (s *Server) runtimeStatuses(ctx context.Context) []lsp.LanguageRuntimeStatus {
	idleDeadline, leaseOwners := s.lifecycleSnapshot(time.Now())
	statuses := s.manager.RuntimeStatuses(ctx)
	endpoint := s.paths.Endpoint()
	for i := range statuses {
		statuses[i].Owner = "daemon"
		statuses[i].DaemonState = DaemonStateRunning
		statuses[i].DaemonPID = os.Getpid()
		statuses[i].DaemonClients = int(s.active.Load())
		statuses[i].DaemonTransport = string(endpoint.Kind)
		statuses[i].DaemonEndpoint = endpoint.Address
		statuses[i].DaemonIdleDeadline = formatDeadline(idleDeadline)
		statuses[i].DaemonLeaseCount = len(leaseOwners)
		statuses[i].DaemonLeaseOwners = append([]string(nil), leaseOwners...)
	}
	return statuses
}

func (s *Server) markActivity() {
	s.lastActivity.Store(time.Now().UnixNano())
}

func (s *Server) monitorIdle(ctx context.Context, listener net.Listener) {
	interval := s.idleTimeout / 4
	if interval <= 0 || interval > time.Second {
		interval = time.Second
	}
	if interval < 20*time.Millisecond {
		interval = 20 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if s.shouldExitIdle(now) {
				fmt.Fprintf(os.Stderr, "[knowns-lsp-daemon] idle timeout reached; exiting project=%s timeout=%s\n", s.identity.Root, s.idleTimeout)
				_ = listener.Close()
				return
			}
		}
	}
}

func (s *Server) shouldExitIdle(now time.Time) bool {
	if s.idleTimeout <= 0 || s.active.Load() > 0 {
		return false
	}
	if _, owners := s.lifecycleSnapshot(now); len(owners) > 0 {
		return false
	}
	last := s.lastActivityTime()
	if last.IsZero() {
		return false
	}
	deadline := last.Add(s.idleTimeout)
	return !now.Before(deadline)
}

func (s *Server) lifecycleSnapshot(now time.Time) (time.Time, []string) {
	if now.IsZero() {
		now = time.Now()
	}
	owners, latestLease := s.activeLeaseOwners(now)
	deadline := time.Time{}
	if s.idleTimeout > 0 {
		last := s.lastActivityTime()
		if !last.IsZero() {
			deadline = last.Add(s.idleTimeout)
		}
		if !latestLease.IsZero() && latestLease.After(deadline) {
			deadline = latestLease
		}
	}
	return deadline, owners
}

func (s *Server) lastActivityTime() time.Time {
	unixNano := s.lastActivity.Load()
	if unixNano == 0 {
		return time.Time{}
	}
	return time.Unix(0, unixNano)
}

func (s *Server) activeLeaseOwners(now time.Time) ([]string, time.Time) {
	s.leasesMu.Lock()
	defer s.leasesMu.Unlock()
	owners := make([]string, 0, len(s.leases))
	var latest time.Time
	for owner, lease := range s.leases {
		if !lease.ExpiresAt.After(now) {
			delete(s.leases, owner)
			continue
		}
		owners = append(owners, owner)
		if lease.ExpiresAt.After(latest) {
			latest = lease.ExpiresAt
		}
	}
	sort.Strings(owners)
	return owners, latest
}

func (s *Server) acquireLease(owner string, ttl time.Duration) error {
	owner, err := validateLeaseOwner(owner)
	if err != nil {
		return err
	}
	if ttl <= 0 {
		ttl = LeaseTTLFromEnv()
	}
	expiresAt := time.Now().Add(ttl)
	s.leasesMu.Lock()
	if s.leases == nil {
		s.leases = make(map[string]lease)
	}
	s.leases[owner] = lease{Owner: owner, ExpiresAt: expiresAt}
	s.leasesMu.Unlock()
	fmt.Fprintf(os.Stderr, "[knowns-lsp-daemon] lease acquired owner=%s ttl=%s expires=%s\n", owner, ttl, formatDeadline(expiresAt))
	return nil
}

func (s *Server) releaseLease(owner string) error {
	owner, err := validateLeaseOwner(owner)
	if err != nil {
		return err
	}
	s.leasesMu.Lock()
	delete(s.leases, owner)
	s.leasesMu.Unlock()
	fmt.Fprintf(os.Stderr, "[knowns-lsp-daemon] lease released owner=%s\n", owner)
	return nil
}

func (s *Server) withSessionVoid(ctx context.Context, req Request, fn func(lsp.Session) error) error {
	return s.manager.WithSession(ctx, req.Path, fn)
}

func (s *Server) withSessionLocation(ctx context.Context, req Request, fn func(lsp.Session) (lsp.Location, error)) (lsp.Location, error) {
	var result lsp.Location
	err := s.manager.WithSession(ctx, req.Path, func(session lsp.Session) error {
		var callErr error
		result, callErr = fn(session)
		return callErr
	})
	return result, err
}

func (s *Server) withSessionLocations(ctx context.Context, req Request, fn func(lsp.Session) ([]lsp.Location, error)) ([]lsp.Location, error) {
	var result []lsp.Location
	err := s.manager.WithSession(ctx, req.Path, func(session lsp.Session) error {
		var callErr error
		result, callErr = fn(session)
		return callErr
	})
	return result, err
}

func (s *Server) withSessionDiagnostics(ctx context.Context, req Request, fn func(lsp.Session) ([]lsp.Diagnostic, error)) ([]lsp.Diagnostic, error) {
	var result []lsp.Diagnostic
	err := s.manager.WithSession(ctx, req.Path, func(session lsp.Session) error {
		var callErr error
		result, callErr = fn(session)
		return callErr
	})
	return result, err
}

func (s *Server) withSessionSymbols(ctx context.Context, req Request, fn func(lsp.Session) ([]lsp.DocumentSymbol, error)) ([]lsp.DocumentSymbol, error) {
	var result []lsp.DocumentSymbol
	err := s.manager.WithSession(ctx, req.Path, func(session lsp.Session) error {
		var callErr error
		result, callErr = fn(session)
		return callErr
	})
	return result, err
}

func (s *Server) withSessionEdit(ctx context.Context, req Request, fn func(lsp.Session) (*lsp.WorkspaceEdit, error)) (*lsp.WorkspaceEdit, error) {
	var result *lsp.WorkspaceEdit
	err := s.manager.WithSession(ctx, req.Path, func(session lsp.Session) error {
		var callErr error
		result, callErr = fn(session)
		return callErr
	})
	return result, err
}

func (s *Server) workspaceSymbols(ctx context.Context, query string) ([]lsp.WorkspaceSymbolResult, error) {
	var result []lsp.WorkspaceSymbolResult
	err := s.manager.WithAnyServer(ctx, func(server *lsp.Server) error {
		var callErr error
		result, callErr = server.WorkspaceSymbol(ctx, query)
		return callErr
	})
	return result, err
}

func (s *Server) errorResponse(path string, err error) Response {
	var runtimeErr *lsp.RuntimeError
	if errors.As(err, &runtimeErr) {
		return Response{RuntimeError: runtimeErrorPayload(runtimeErr)}
	}
	if described := s.manager.DescribeRuntimeError(path, err); described != nil {
		return Response{RuntimeError: runtimeErrorPayload(described)}
	}
	return Response{Error: err.Error()}
}

func newProjectManager(root string) (*lsp.Manager, error) {
	store := storage.NewStore(filepath.Join(root, ".knowns"))
	project, err := store.Config.Load()
	if err != nil {
		return nil, err
	}
	var defaults *storage.ProjectDefaults
	if settings, err := storage.NewEmbeddingSettingsStore().Load(); err == nil {
		defaults = settings.ProjectDefaults
	}
	manager := lsp.NewManager(root, lsp.ConfigFromProjectWithDefaults(project, defaults))
	for _, adapter := range adapters.All() {
		if err := manager.RegisterAdapter(adapter); err != nil {
			return nil, err
		}
	}
	_ = manager.RegisterPluginAdapters(lsp.PluginAdapterLoadOptions{})
	return manager, nil
}
