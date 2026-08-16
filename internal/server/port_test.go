package server

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/storage"
)

// getFreePort asks the OS for an available TCP port.
func getFreePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("getFreePort: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

func TestPortFileWrittenAfterBind(t *testing.T) {
	tmpDir := t.TempDir()
	knDir := filepath.Join(tmpDir, ".knowns")
	os.MkdirAll(knDir, 0755)

	store := storage.NewStore(knDir)
	port := getFreePort(t)

	s := &Server{
		store:      store,
		sse:        NewSSEBroker(),
		port:       port,
		shutdownCh: make(chan struct{}, 1),
	}
	s.router = s.buildRouter()

	// Start server in background
	errCh := make(chan error, 1)
	go func() {
		errCh <- s.Start()
	}()

	// Give server time to bind and write port file
	time.Sleep(200 * time.Millisecond)

	// Verify port file exists with correct content
	portFile := filepath.Join(knDir, ".server-port")
	data, err := os.ReadFile(portFile)
	if err != nil {
		t.Fatalf("expected .server-port to exist after bind, got error: %v", err)
	}
	if got := string(data); got != strconv.Itoa(port) {
		t.Fatalf("port file content = %q, want %q", got, strconv.Itoa(port))
	}

	// Trigger shutdown via /api/shutdown
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Post(fmt.Sprintf("http://localhost:%d/api/shutdown", port), "application/json", nil)
	if err != nil {
		t.Fatalf("POST /api/shutdown failed: %v", err)
	}
	resp.Body.Close()

	// Wait for server to exit
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("Start() returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not shut down within 5s")
	}

	// Verify port file is cleaned up
	if _, err := os.Stat(portFile); !os.IsNotExist(err) {
		t.Fatal("expected .server-port to be removed after shutdown")
	}
}

func TestPortFileNotWrittenOnBindFailure(t *testing.T) {
	tmpDir := t.TempDir()
	knDir := filepath.Join(tmpDir, ".knowns")
	os.MkdirAll(knDir, 0755)

	store := storage.NewStore(knDir)

	// Occupy a port first
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to occupy port: %v", err)
	}
	defer l.Close()
	occupiedPort := l.Addr().(*net.TCPAddr).Port

	s := &Server{
		store:      store,
		sse:        NewSSEBroker(),
		port:       occupiedPort,
		shutdownCh: make(chan struct{}, 1),
	}
	s.router = s.buildRouter()

	// Start should fail because port is occupied
	err = s.Start()
	if err == nil {
		t.Fatal("expected Start() to return error for occupied port")
	}

	// Verify no port file was written
	portFile := filepath.Join(knDir, ".server-port")
	if _, statErr := os.Stat(portFile); !os.IsNotExist(statErr) {
		t.Fatal("expected no .server-port file when bind fails")
	}
}
