package lsp

import (
	"context"
	"fmt"
	"log/slog"
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
}

func NewManager(root string, cfg Config) *Manager {
	registry := NewRegistry(nil)
	return &Manager{
		root:     root,
		registry: registry,
		detector: NewDetector(registry),
		config:   cfg,
		servers:  make(map[string]*Server),
		adapters: make(map[string]LanguageAdapter),
		status:   make(map[string]ServerStatus),
	}
}

// RegisterAdapter registers a language adapter with the manager.
func (m *Manager) RegisterAdapter(adapter LanguageAdapter) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.adapters[adapter.ID()] = adapter
}

func (m *Manager) SetDetector(detector *Detector) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if detector != nil {
		m.detector = detector
	}
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
			return nil, false, err
		}
		m.mu.Lock()
		m.status[lang.ID] = StatusRunning
		m.mu.Unlock()
		return srv, true, nil
	}

	if srv != nil {
		if err := srv.Start(ctx); err != nil {
			return nil, false, err
		}
		return srv, true, nil
	}
	commands, err := m.detector.Detect(ctx, m.root, m.config)
	if err != nil {
		return nil, false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, cmd := range commands {
		if _, exists := m.servers[cmd.Language]; !exists {
			m.servers[cmd.Language] = NewServer(m.root, cmd)
		}
	}

	srv = m.servers[lang.ID]
	if srv == nil {
		return nil, false, nil
	}
	return srv, true, srv.Start(ctx)
}

func primaryBinaryName(adapter LanguageAdapter) string {
	binaries := adapter.Binaries()
	if len(binaries) == 0 {
		return adapter.Name()
	}
	return binaries[0].Name
}

func (m *Manager) WithFile(ctx context.Context, path string, fn func(*Server) error) error {
	srv, ok, err := m.ServerForPath(ctx, path)
	if err != nil || !ok {
		return err
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
		if _, exists := m.servers[cmd.Language]; !exists {
			m.servers[cmd.Language] = NewServer(m.root, cmd)
		}
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
		if m.status[langID] != StatusDisabled {
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
		if _, ok := detector.resolve(context.Background(), lang, cfg.BinaryOverride(lang.ID)); ok {
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

func (m *Manager) startDetected(ctx context.Context) error {
	commands, err := m.detector.Detect(ctx, m.root, m.config)
	if err != nil {
		return err
	}
	var servers []*Server
	m.mu.Lock()
	for _, cmd := range commands {
		srv := m.servers[cmd.Language]
		if srv == nil {
			srv = NewServer(m.root, cmd)
			m.servers[cmd.Language] = srv
		}
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
