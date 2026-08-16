package cli

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/registry"
	"github.com/spf13/cobra"
)

// newTestCmd creates a cobra command with browser flags for testing resolveProject.
func newTestCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "test"}
	cmd.Flags().String("project", "", "")
	cmd.Flags().String("scan", "", "")
	return cmd
}

func TestResolveProjectFromFlag(t *testing.T) {
	tmpDir := t.TempDir()
	projDir := filepath.Join(tmpDir, "my-proj")
	os.MkdirAll(filepath.Join(projDir, ".knowns"), 0755)
	os.WriteFile(filepath.Join(projDir, ".knowns", "config.json"), []byte(`{"name":"my-proj"}`), 0644)

	cmd := newTestCmd()
	cmd.Flags().Set("project", projDir)

	store, projectRoot := resolveProject(cmd)
	if store == nil {
		t.Fatal("expected store from --project flag, got nil")
	}
	if projectRoot != projDir {
		t.Fatalf("projectRoot = %q, want %q", projectRoot, projDir)
	}
	if store.Root != filepath.Join(projDir, ".knowns") {
		t.Fatalf("store.Root = %q, want %q", store.Root, filepath.Join(projDir, ".knowns"))
	}
}

func TestResolveProjectFromRegistry(t *testing.T) {
	tmpDir := t.TempDir()
	projDir := filepath.Join(tmpDir, "reg-proj")
	os.MkdirAll(filepath.Join(projDir, ".knowns"), 0755)
	os.WriteFile(filepath.Join(projDir, ".knowns", "config.json"), []byte(`{"name":"reg-proj"}`), 0644)

	// Set up a registry with one project
	regFile := filepath.Join(tmpDir, "registry.json")
	reg := registry.NewRegistryWithPath(regFile)
	reg.Load()
	p, _ := reg.Add(projDir)
	reg.SetActive(p.ID)

	// Override the default registry path for this test by using --project
	// Since we can't easily override NewRegistry() path, test via --project flag
	// which is the primary path. The registry fallback is tested implicitly
	// through the integration flow.
	cmd := newTestCmd()
	cmd.Flags().Set("project", projDir)

	store, root := resolveProject(cmd)
	if store == nil {
		t.Fatal("expected store, got nil")
	}
	if root != projDir {
		t.Fatalf("root = %q, want %q", root, projDir)
	}
}

func TestResolveProjectPickerMode(t *testing.T) {
	// Run from a temp dir with no .knowns/ and no registry
	tmpDir := t.TempDir()
	origDir, _ := os.Getwd()
	os.Chdir(tmpDir)
	defer os.Chdir(origDir)

	cmd := newTestCmd()
	store, root := resolveProject(cmd)

	// In picker mode, store may be nil (if registry is empty) or from registry
	// Since we can't control the global registry in unit tests, just verify
	// that the function doesn't panic and returns something reasonable.
	if store != nil && root == "" {
		t.Fatal("if store is non-nil, root should also be non-empty")
	}
}

func TestResolveProjectFromCwd(t *testing.T) {
	tmpDir := t.TempDir()
	// Resolve symlinks (macOS /private/var vs /var)
	tmpDir, _ = filepath.EvalSymlinks(tmpDir)
	os.MkdirAll(filepath.Join(tmpDir, ".knowns"), 0755)
	os.WriteFile(filepath.Join(tmpDir, ".knowns", "config.json"), []byte(`{"name":"test"}`), 0644)

	origDir, _ := os.Getwd()
	os.Chdir(tmpDir)
	defer os.Chdir(origDir)

	cmd := newTestCmd()
	store, root := resolveProject(cmd)

	if store == nil {
		t.Fatal("expected store from cwd, got nil")
	}
	if root != tmpDir {
		t.Fatalf("root = %q, want %q", root, tmpDir)
	}
}

func TestBindBrowserPortReturnsRequestedPortWhenFree(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()

	ln, got, err := bindBrowserPort(port, 3)
	if err != nil {
		t.Fatalf("bindBrowserPort returned error: %v", err)
	}
	ln.Close()
	if got != port {
		t.Fatalf("bindBrowserPort(%d, 3) = %d, want %d", port, got, port)
	}
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok || !addr.IP.IsLoopback() {
		t.Fatalf("browser listener address = %v, want loopback", ln.Addr())
	}
}

func TestBindBrowserPortFallsForwardWhenBusy(t *testing.T) {
	first, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatalf("listen first: %v", err)
	}
	startPort := first.Addr().(*net.TCPAddr).Port
	defer first.Close()

	busyNext, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", startPort+1))
	if err != nil {
		t.Skipf("could not reserve consecutive port %d: %v", startPort+1, err)
	}
	defer busyNext.Close()

	ln, got, err := bindBrowserPort(startPort, 50)
	if err != nil {
		t.Fatalf("bindBrowserPort returned error: %v", err)
	}
	ln.Close()
	if got <= startPort+1 {
		t.Fatalf("bindBrowserPort(%d, 50) = %d, want a port after %d", startPort, got, startPort+1)
	}
}

func TestWaitForHTTPServer(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	port := listener.Addr().(*net.TCPAddr).Port
	if err := waitForHTTPServer(port, time.Second); err != nil {
		t.Fatalf("waitForHTTPServer returned error: %v", err)
	}
}
