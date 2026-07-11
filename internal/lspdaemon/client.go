package lspdaemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/lsp"
)

const (
	defaultDialTimeout  = 2 * time.Second
	defaultStartTimeout = 10 * time.Second
)

type Runtime struct {
	client *Client
	err    error
}

func NewRuntime(ctx context.Context, root string) *Runtime {
	client, err := EnsureClient(ctx, root)
	return &Runtime{client: client, err: err}
}

func (r *Runtime) WithSession(ctx context.Context, path string, fn func(lsp.Session) error) error {
	if r == nil {
		return errors.New("LSP daemon runtime is not configured")
	}
	if r.err != nil {
		return r.err
	}
	if r.client == nil {
		return errors.New("LSP daemon client is not configured")
	}
	return fn(&remoteSession{client: r.client})
}

func (r *Runtime) DescribeRuntimeError(_ string, err error) *lsp.RuntimeError {
	var runtimeErr *lsp.RuntimeError
	if errors.As(err, &runtimeErr) {
		return runtimeErr
	}
	return nil
}

type Client struct {
	identity ProjectIdentity
	paths    Paths
	token    string
	recover  func(context.Context) error
}

func EnsureClient(ctx context.Context, root string) (*Client, error) {
	if DisabledByEnv() {
		return nil, ErrDisabledByEnv
	}
	client, err := NewClient(root)
	if err != nil {
		return nil, err
	}
	if err := client.Ping(ctx); err == nil {
		return client, nil
	}
	if err := client.startDaemon(ctx); err != nil {
		return nil, client.daemonError("start", err)
	}
	return client, nil
}

func NewClient(root string) (*Client, error) {
	identity, err := IdentifyProject(root)
	if err != nil {
		return nil, err
	}
	paths := PathsForIdentity(identity)
	if err := paths.EnsureDir(); err != nil {
		return nil, err
	}
	token, err := EnsureToken(paths)
	if err != nil {
		return nil, err
	}
	return &Client{identity: identity, paths: paths, token: token}, nil
}

func (c *Client) Ping(ctx context.Context) error {
	_, err := c.callOnce(ctx, Request{Operation: OperationPing})
	return err
}

func (c *Client) RuntimeStatuses(ctx context.Context) ([]lsp.LanguageRuntimeStatus, error) {
	resp, err := c.call(ctx, Request{Operation: OperationStatus})
	return resp.Statuses, err
}

func (c *Client) StartLanguage(ctx context.Context, langID string) ([]lsp.LanguageRuntimeStatus, error) {
	resp, err := c.call(ctx, Request{Operation: OperationStartLanguage, Language: langID})
	return resp.Statuses, err
}

func (c *Client) StopLanguage(ctx context.Context, langID string) ([]lsp.LanguageRuntimeStatus, error) {
	resp, err := c.call(ctx, Request{Operation: OperationStopLanguage, Language: langID})
	return resp.Statuses, err
}

func (c *Client) RestartLanguage(ctx context.Context, langID string) ([]lsp.LanguageRuntimeStatus, error) {
	resp, err := c.call(ctx, Request{Operation: OperationRestartLanguage, Language: langID})
	return resp.Statuses, err
}

func (c *Client) ApplyConfig(ctx context.Context) ([]lsp.LanguageRuntimeStatus, error) {
	resp, err := c.call(ctx, Request{Operation: OperationApplyConfig})
	return resp.Statuses, err
}

func (c *Client) AcquireLease(ctx context.Context, owner string, ttl time.Duration) ([]lsp.LanguageRuntimeStatus, error) {
	owner, err := validateLeaseOwner(owner)
	if err != nil {
		return nil, err
	}
	if ttl <= 0 {
		ttl = LeaseTTLFromEnv()
	}
	resp, err := c.call(ctx, Request{Operation: OperationAcquireLease, Owner: owner, TTLMillis: ttl.Milliseconds()})
	return resp.Statuses, err
}

func (c *Client) ReleaseLease(ctx context.Context, owner string) error {
	owner, err := validateLeaseOwner(owner)
	if err != nil {
		return err
	}
	_, err = c.call(ctx, Request{Operation: OperationReleaseLease, Owner: owner})
	return err
}

// TryReleaseLease releases a lease only when the daemon is already running.
// It deliberately avoids recovery so shutdown cleanup cannot start a daemon.
func (c *Client) TryReleaseLease(ctx context.Context, owner string) error {
	owner, err := validateLeaseOwner(owner)
	if err != nil {
		return err
	}
	_, err = c.callOnce(ctx, Request{Operation: OperationReleaseLease, Owner: owner})
	return err
}

func (c *Client) call(ctx context.Context, req Request) (Response, error) {
	resp, err := c.callOnce(ctx, req)
	if err == nil {
		return resp, nil
	}
	if !recoverableDaemonError(err) {
		return resp, c.daemonError(string(req.Operation), err)
	}
	if recoverErr := c.recoverDaemon(ctx); recoverErr != nil {
		return Response{}, c.daemonError("recover after "+string(req.Operation), errors.Join(err, recoverErr))
	}
	resp, err = c.callOnce(ctx, req)
	if err != nil {
		return resp, c.daemonError("retry "+string(req.Operation), err)
	}
	return resp, nil
}

func (c *Client) callOnce(ctx context.Context, req Request) (Response, error) {
	if c == nil {
		return Response{}, errors.New("LSP daemon client is nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	req.Handshake = Handshake{ProjectRoot: c.identity.Root, Token: c.token}

	dialCtx, cancel := context.WithTimeout(ctx, defaultDialTimeout)
	defer cancel()
	conn, err := dialEndpoint(dialCtx, c.paths.Endpoint())
	if err != nil {
		return Response{}, err
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	}

	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return Response{}, err
	}
	var resp Response
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		return Response{}, err
	}
	return resp, resp.err()
}

func (c *Client) recoverDaemon(ctx context.Context) error {
	if c.recover != nil {
		return c.recover(ctx)
	}
	return c.startDaemon(ctx)
}

func recoverableDaemonError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
		return true
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "broken pipe")
}

func (c *Client) startDaemon(ctx context.Context) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if isGoTestBinary(exe) {
		return fmt.Errorf("automatic LSP daemon startup is disabled from Go test binary %q", filepath.Base(exe))
	}

	lock, err := AcquireProjectLock(c.paths, LockOptions{Timeout: defaultStartTimeout, StaleAge: 30 * time.Second})
	if err != nil {
		if pingErr := c.Ping(ctx); pingErr == nil {
			return nil
		}
		return err
	}
	defer lock.Release()

	if err := c.Ping(ctx); err == nil {
		return nil
	}

	logFile, err := openLogFile(c.paths.LogPath)
	if err != nil {
		return err
	}
	defer logFile.Close()

	cmd := exec.Command(exe, "__lsp-daemon", "run", "--project", c.identity.Root)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Stdin = strings.NewReader("")
	setSysProcAttr(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start LSP daemon: %w", err)
	}
	return c.waitReady(ctx, defaultStartTimeout)
}

func isGoTestBinary(path string) bool {
	path = strings.ToLower(path)
	return strings.HasSuffix(path, ".test") || strings.HasSuffix(path, ".test.exe")
}

func (c *Client) waitReady(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		if err := c.Ping(ctx); err == nil {
			return nil
		} else {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	if lastErr != nil {
		return fmt.Errorf("timed out waiting for LSP daemon: %w", lastErr)
	}
	return errors.New("timed out waiting for LSP daemon")
}

func openLogFile(path string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}

type remoteSession struct {
	client *Client
}

func (s *remoteSession) Start(context.Context) error { return nil }
func (s *remoteSession) Stop(context.Context) error  { return nil }
func (s *remoteSession) WaitReady(context.Context)   {}
func (s *remoteSession) Alive() bool                 { return true }

func (s *remoteSession) WithFile(_ context.Context, _ string, fn func() error) error {
	return fn()
}

func (s *remoteSession) DidChange(ctx context.Context, path, text string) error {
	_, err := s.client.call(ctx, Request{Operation: OperationDidChange, Path: path, Text: text})
	return err
}

func (s *remoteSession) Definition(ctx context.Context, path string, line, col int) (lsp.Location, error) {
	resp, err := s.client.call(ctx, Request{Operation: OperationDefinition, Path: path, Line: line, Character: col})
	return resp.Location, err
}

func (s *remoteSession) References(ctx context.Context, path string, line, col int) ([]lsp.Location, error) {
	resp, err := s.client.call(ctx, Request{Operation: OperationReferences, Path: path, Line: line, Character: col})
	return resp.Locations, err
}

func (s *remoteSession) Implementations(ctx context.Context, path string, line, col int) ([]lsp.Location, error) {
	resp, err := s.client.call(ctx, Request{Operation: OperationImplementations, Path: path, Line: line, Character: col})
	return resp.Locations, err
}

func (s *remoteSession) Diagnostics(ctx context.Context, path string) ([]lsp.Diagnostic, error) {
	resp, err := s.client.call(ctx, Request{Operation: OperationDiagnostics, Path: path})
	return resp.Diagnostics, err
}

func (s *remoteSession) DocumentSymbols(ctx context.Context, path string) ([]lsp.DocumentSymbol, error) {
	resp, err := s.client.call(ctx, Request{Operation: OperationDocumentSymbols, Path: path})
	return resp.DocumentSymbols, err
}

func (s *remoteSession) WorkspaceSymbol(ctx context.Context, query string) ([]lsp.WorkspaceSymbolResult, error) {
	resp, err := s.client.call(ctx, Request{Operation: OperationWorkspaceSymbol, Query: query})
	return resp.WorkspaceSymbolResults, err
}

func (s *remoteSession) Rename(ctx context.Context, path string, line, col int, newName string) (*lsp.WorkspaceEdit, error) {
	resp, err := s.client.call(ctx, Request{Operation: OperationRename, Path: path, Line: line, Character: col, NewName: newName})
	return resp.WorkspaceEdit, err
}
