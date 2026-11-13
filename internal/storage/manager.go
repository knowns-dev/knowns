// Package storage — Manager provides thread-safe runtime project switching.
// It wraps a Store and a Registry, allowing workspace API handlers to swap
// the active project without restarting the server.
package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/howznguyen/knowns/internal/registry"
)

// Manager coordinates runtime project switching. All route handlers call
// GetStore() to obtain the currently active Store.
type Manager struct {
	active *Store
	reg    *registry.Registry
	mu     sync.RWMutex
}

// NewManager creates a Manager with the given initial store and registry.
func NewManager(initialStore *Store, reg *registry.Registry) *Manager {
	return &Manager{
		active: initialStore,
		reg:    reg,
	}
}

// GetStore returns the currently active Store (read-locked).
func (m *Manager) GetStore() *Store {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.active
}

// GetRegistry returns the underlying project registry.
func (m *Manager) GetRegistry() *registry.Registry {
	return m.reg
}

// Switch changes the active project to the one at projectPath. A project
// linked to a store opens its store folder; otherwise the project must have an
// in-repo .knowns/ directory. The registry's active project is updated.
func (m *Manager) Switch(projectPath string) (*Store, error) {
	absPath, err := filepath.Abs(projectPath)
	if err != nil {
		return nil, fmt.Errorf("resolve path: %w", err)
	}

	var newStore *Store
	if m.reg != nil {
		if p := m.reg.FindStoreLinked(absPath); p != nil && m.reg.IsValid(*p) {
			newStore = NewStoreWithProjectRoot(m.reg.KnowledgeRoot(*p), p.Path)
		}
	}
	if newStore == nil {
		// The manager's registry was loaded at startup; a store link made since
		// then is only in the machine registry on disk.
		if loc, err := LocateProjectAt(absPath); err == nil && loc.Store != nil {
			newStore = loc.Open()
		}
	}
	if newStore == nil {
		knDir := filepath.Join(absPath, ".knowns")
		if info, err := os.Stat(knDir); err != nil || !info.IsDir() {
			return nil, fmt.Errorf("no .knowns/ directory at %s", absPath)
		}
		newStore = NewStore(knDir)
	}

	// Update registry: add if new, then set active.
	if m.reg != nil {
		p, err := m.reg.Add(absPath)
		if err == nil && p != nil {
			_ = m.reg.SetActive(p.ID)
		}
	}

	m.mu.Lock()
	m.active = newStore
	m.mu.Unlock()

	return newStore, nil
}

// ActiveProjectRoot returns the code repository root for the
// currently active store. Returns empty string when no store is active.
func (m *Manager) ActiveProjectRoot() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.active == nil {
		return ""
	}
	return m.active.ProjectRoot
}
