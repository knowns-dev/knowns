package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Server struct {
	Command ServerCommand
	Root    string

	mu          sync.Mutex
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	reader      *bufio.Reader
	nextID      atomic.Int64
	running     bool
	initialized bool
	exited      chan struct{}
	files       *FileSync
	diagnostics map[string][]Diagnostic
	ready       chan struct{}
	readyOnce   sync.Once
}

func NewServer(root string, command ServerCommand) *Server {
	s := &Server{Root: root, Command: command, diagnostics: make(map[string][]Diagnostic), ready: make(chan struct{})}
	s.files = NewFileSync(s.didOpen, s.didClose)
	return s
}

// WaitReady blocks until the LSP server signals workspace indexing is complete,
// or the context is cancelled. Falls back to a 3-second timeout if no progress
// notification is received.
func (s *Server) WaitReady(ctx context.Context) {
	select {
	case <-s.ready:
	case <-ctx.Done():
	}
}

func (s *Server) Start(ctx context.Context) error {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return nil
	}
	cmd := exec.CommandContext(ctx, s.Command.Path, s.Command.Args...)
	cmd.Dir = s.Root
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		s.mu.Unlock()
		return err
	}
	s.cmd = cmd
	s.stdin = stdin
	s.reader = bufio.NewReader(stdout)
	s.exited = make(chan struct{})
	s.running = true
	exited := s.exited
	s.mu.Unlock()

	go s.wait(cmd, exited)
	if err := s.initialize(ctx); err != nil {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-exited
		s.mu.Lock()
		if s.cmd == cmd {
			s.cmd = nil
			s.stdin = nil
			s.reader = nil
			s.exited = nil
			s.running = false
			s.initialized = false
		}
		s.mu.Unlock()
		return err
	}

	s.mu.Lock()
	s.initialized = true
	s.mu.Unlock()
	if err := s.notify(ctx, "initialized", map[string]any{}); err != nil {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-exited
		s.mu.Lock()
		if s.cmd == cmd {
			s.cmd = nil
			s.stdin = nil
			s.reader = nil
			s.exited = nil
			s.running = false
			s.initialized = false
		}
		s.mu.Unlock()
		return err
	}
	// Fallback: mark ready after 3s if no $/progress "end" received
	time.AfterFunc(3*time.Second, func() {
		s.readyOnce.Do(func() { close(s.ready) })
	})
	return nil
}

func (s *Server) Stop(ctx context.Context) error {
	if s.files != nil {
		_ = s.files.CloseAll()
	}

	s.mu.Lock()
	if !s.running || s.cmd == nil {
		s.mu.Unlock()
		return nil
	}
	_ = s.shutdownLocked(ctx)
	_ = s.notifyLocked(ctx, "exit", nil)
	cmd := s.cmd
	exited := s.exited
	s.running = false
	s.initialized = false
	s.cmd = nil
	s.stdin = nil
	s.reader = nil
	s.exited = nil
	s.mu.Unlock()

	select {
	case <-exited:
		return nil
	case <-ctx.Done():
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		return ctx.Err()
	}
}

func (s *Server) Alive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running
}

func (s *Server) WithFile(ctx context.Context, path string, fn func() error) error {
	if err := s.Start(ctx); err != nil {
		return err
	}
	if err := s.files.Open(path); err != nil {
		return err
	}
	defer func() { _ = s.files.Close(path) }()
	if fn == nil {
		return nil
	}
	return fn()
}

func (s *Server) initialize(ctx context.Context) error {
	params := map[string]any{
		"processId": os.Getpid(),
		"rootUri":   fileURI(s.Root),
		"capabilities": map[string]any{
			"window": map[string]any{
				"workDoneProgress": true,
			},
		},
	}
	return s.request(ctx, "initialize", params, nil)
}

func (s *Server) didOpen(path string) error {
	if err := s.requireInitialized(); err != nil {
		return err
	}
	text, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	params := map[string]any{"textDocument": map[string]any{"uri": fileURI(path), "languageId": s.Command.Language, "version": 1, "text": string(text)}}
	return s.notify(context.Background(), "textDocument/didOpen", params)
}

func (s *Server) DidChange(ctx context.Context, path, text string) error {
	if err := s.requireInitialized(); err != nil {
		return err
	}
	params := map[string]any{
		"textDocument":   map[string]any{"uri": fileURI(path), "version": 2},
		"contentChanges": []map[string]any{{"text": text}},
	}
	return s.notify(ctx, "textDocument/didChange", params)
}

func (s *Server) didClose(path string) error {
	if err := s.requireInitialized(); err != nil {
		return err
	}
	params := map[string]any{"textDocument": map[string]any{"uri": fileURI(path)}}
	return s.notify(context.Background(), "textDocument/didClose", params)
}

func (s *Server) notify(ctx context.Context, method string, params any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.notifyLocked(ctx, method, params)
}

func (s *Server) notifyLocked(ctx context.Context, method string, params any) error {
	return s.writeLocked(ctx, map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (s *Server) request(ctx context.Context, method string, params any, result any) error {
	if method != "initialize" && method != "shutdown" {
		if err := s.requireInitialized(); err != nil {
			return err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requestLocked(ctx, method, params, result)
}

func (s *Server) requestLocked(ctx context.Context, method string, params any, result any) error {
	id := s.nextID.Add(1)
	if err := s.writeLocked(ctx, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return err
	}
	return s.readResponseLocked(ctx, id, result)
}

func (s *Server) shutdownLocked(ctx context.Context) error {
	return s.requestLocked(ctx, "shutdown", nil, nil)
}

func (s *Server) requireInitialized() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requireInitializedLocked()
}

func (s *Server) requireInitializedLocked() error {
	if !s.initialized {
		return fmt.Errorf("lsp server %s not initialized", s.Command.Language)
	}
	return nil
}

func (s *Server) writeLocked(ctx context.Context, msg any) error {
	if !s.running || s.stdin == nil {
		return fmt.Errorf("lsp server %s not running", s.Command.Language)
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	_, err = fmt.Fprintf(s.stdin, "Content-Length: %d\r\n\r\n%s", len(data), data)
	return err
}

func (s *Server) readResponseLocked(ctx context.Context, id int64, result any) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		msg, err := s.readMessageLocked()
		if err != nil {
			s.running = false
			s.initialized = false
			return err
		}
		var envelope struct {
			ID     *int64           `json:"id"`
			Method string           `json:"method"`
			Params json.RawMessage  `json:"params"`
			Error  *json.RawMessage `json:"error"`
			Result json.RawMessage  `json:"result"`
		}
		if err := json.Unmarshal(msg, &envelope); err != nil {
			return err
		}
		if envelope.Method != "" {
			s.handleNotificationLocked(envelope.Method, envelope.Params)
			// Server-to-client request (has both method and id) — respond with empty result
			if envelope.ID != nil && *envelope.ID != id {
				_ = s.writeLocked(ctx, map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": nil})
			}
		}
		if envelope.ID == nil || *envelope.ID != id {
			continue
		}
		if envelope.Error != nil {
			return fmt.Errorf("lsp %s: %s", s.Command.Language, string(*envelope.Error))
		}
		if result != nil && len(envelope.Result) > 0 {
			return json.Unmarshal(envelope.Result, result)
		}
		return nil
	}
}

func (s *Server) handleNotificationLocked(method string, params json.RawMessage) {
	switch method {
	case "textDocument/publishDiagnostics":
		if len(params) == 0 {
			return
		}
		var payload struct {
			URI         string       `json:"uri"`
			Diagnostics []Diagnostic `json:"diagnostics"`
		}
		if err := json.Unmarshal(params, &payload); err != nil || payload.URI == "" {
			return
		}
		if s.diagnostics == nil {
			s.diagnostics = make(map[string][]Diagnostic)
		}
		s.diagnostics[payload.URI] = payload.Diagnostics
	case "$/progress":
		if len(params) == 0 {
			return
		}
		var payload struct {
			Value json.RawMessage `json:"value"`
		}
		if err := json.Unmarshal(params, &payload); err != nil {
			return
		}
		var value struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(payload.Value, &value); err != nil {
			return
		}
		if value.Kind == "end" {
			s.readyOnce.Do(func() { close(s.ready) })
		}
	}
}

func (s *Server) cachedDiagnostics(path string) []Diagnostic {
	s.mu.Lock()
	defer s.mu.Unlock()
	for uri, diagnostics := range s.diagnostics {
		if sameFileURI(uri, path) {
			return append([]Diagnostic(nil), diagnostics...)
		}
	}
	return nil
}

func (s *Server) readMessageLocked() ([]byte, error) {
	var length int
	for {
		line, err := s.reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		if strings.HasPrefix(strings.ToLower(line), "content-length:") {
			_, _ = fmt.Sscanf(line, "Content-Length: %d", &length)
		}
	}
	if length <= 0 {
		return nil, fmt.Errorf("missing content length")
	}
	buf := make([]byte, length)
	_, err := io.ReadFull(s.reader, buf)
	return buf, err
}

func (s *Server) wait(cmd *exec.Cmd, exited chan struct{}) {
	_ = cmd.Wait()
	s.mu.Lock()
	if s.cmd == cmd {
		s.running = false
		s.initialized = false
		s.cmd = nil
		s.stdin = nil
		s.reader = nil
	}
	s.mu.Unlock()
	close(exited)
}

func fileURI(path string) string {
	return FileURI(path)
}
