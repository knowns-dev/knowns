//go:build !windows

package lspdaemon

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

func dialEndpoint(ctx context.Context, endpoint TransportEndpoint) (net.Conn, error) {
	if endpoint.Kind != TransportUnixSocket {
		return nil, fmt.Errorf("unsupported LSP daemon transport %q", endpoint.Kind)
	}
	var dialer net.Dialer
	return dialer.DialContext(ctx, "unix", endpoint.Address)
}

func listenEndpoint(paths Paths) (net.Listener, error) {
	endpoint := paths.Endpoint()
	if endpoint.Kind != TransportUnixSocket {
		return nil, fmt.Errorf("unsupported LSP daemon transport %q", endpoint.Kind)
	}
	if err := removeStaleSocket(endpoint.Address); err != nil {
		return nil, err
	}
	return net.Listen("unix", endpoint.Address)
}

func removeStaleSocket(path string) error {
	if path == "" {
		return errors.New("socket path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	conn, err := net.DialTimeout("unix", path, 200*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		return fmt.Errorf("LSP daemon socket already active: %s", path)
	}
	if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		return removeErr
	}
	return nil
}

func cleanupEndpoint(paths Paths) {
	if paths.SocketPath != "" {
		_ = os.Remove(paths.SocketPath)
	}
}
