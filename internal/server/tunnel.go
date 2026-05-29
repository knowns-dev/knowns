package server

import (
	"fmt"
	"sync"

	"github.com/howznguyen/knowns/internal/server/routes"
	"github.com/howznguyen/knowns/internal/tunnel/cloudflared"
)

// ServerTunnelManager wraps cloudflared.Daemon for use by the server.
// The daemon is lazy-initialized on first Start() call.
type ServerTunnelManager struct {
	mu     sync.Mutex
	daemon *cloudflared.Daemon
	port   int
}


// NewServerTunnelManager creates a tunnel manager for the given local port.
func NewServerTunnelManager(port int) *ServerTunnelManager {
	return &ServerTunnelManager{port: port}
}

// Start starts the tunnel. Returns the public URL or an error.
func (m *ServerTunnelManager) Start() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.daemon != nil && m.daemon.IsHealthy() {
		url, err := m.daemon.PublicURL()
		if err == nil {
			fmt.Printf("  %s  Tunnel active: %s\n", "✓", url)
			return url, nil
		}
	}

	m.daemon = cloudflared.NewDaemon(m.port)
	if err := m.daemon.EnsureRunning(); err != nil {
		return "", err
	}
	url, err := m.daemon.PublicURL()
	if err != nil {
		return "", fmt.Errorf("tunnel started but failed to capture URL: %w", err)
	}
	fmt.Printf("  %s  Tunnel active: %s\n", "✓", url)
	return url, nil
}

// Stop stops the tunnel if it is running. Returns nil if already stopped.
func (m *ServerTunnelManager) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.daemon == nil {
		return nil
	}
	err := m.daemon.Stop()
	if err == nil {
		fmt.Printf("  %s  Tunnel stopped\n", "✗")
	}
	return err
}

// Status returns the current tunnel status.
func (m *ServerTunnelManager) Status() routes.TunnelStatus {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.daemon == nil || !m.daemon.IsHealthy() {
		return routes.TunnelStatus{Running: false}
	}
	url, _ := m.daemon.PublicURL()
	pid, _ := m.daemon.ReadPID()
	return routes.TunnelStatus{
		Running:     true,
		URL:         url,
		PID:         pid,
		StartedByUs: m.daemon.StartedByUs(),
	}
}
