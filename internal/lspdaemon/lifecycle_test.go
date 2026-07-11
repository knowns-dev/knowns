package lspdaemon

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestEnsureClientDisabledByEnv(t *testing.T) {
	t.Setenv(EnvDaemonMode, "0")
	_, err := EnsureClient(context.Background(), t.TempDir())
	if !errors.Is(err, ErrDisabledByEnv) {
		t.Fatalf("EnsureClient error = %v, want ErrDisabledByEnv", err)
	}

	statuses := AnnotateLocalStatuses([]lsp.LanguageRuntimeStatus{{ID: "go"}}, DaemonStateDisabledByEnv)
	if statuses[0].Owner != "local" || statuses[0].DaemonState != DaemonStateDisabledByEnv {
		t.Fatalf("disabled status annotation = %#v", statuses[0])
	}
}

func TestIsGoTestBinaryRecognizesWindowsExe(t *testing.T) {
	tests := map[string]bool{
		"/tmp/lspdaemon.test":            true,
		`C:\Temp\lspdaemon.test.exe`:     true,
		"/tmp/lspdaemon.test.exe":        true,
		"/tmp/lspdaemon-test.exe":        false,
		"/tmp/lspdaemon.test-helper.exe": false,
	}
	for path, want := range tests {
		if got := isGoTestBinary(path); got != want {
			t.Fatalf("isGoTestBinary(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestClientRecoversOnceAfterSocketFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix socket test")
	}
	isolateHome(t)
	client, err := NewClient(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	first, err := net.Listen("unix", client.paths.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	go func() {
		conn, err := first.Accept()
		if err == nil {
			_ = conn.Close()
		}
	}()

	recoveries := 0
	client.recover = func(context.Context) error {
		recoveries++
		_ = first.Close()
		_ = os.Remove(client.paths.SocketPath)
		serveOneDaemonResponse(t, client, Response{
			Statuses: []lsp.LanguageRuntimeStatus{{ID: "go", Owner: "daemon", DaemonState: DaemonStateRunning}},
		})
		return nil
	}

	statuses, err := client.RuntimeStatuses(context.Background())
	if err != nil {
		t.Fatalf("RuntimeStatuses after recovery: %v", err)
	}
	if recoveries != 1 {
		t.Fatalf("recoveries = %d, want 1", recoveries)
	}
	if len(statuses) != 1 || statuses[0].Owner != "daemon" {
		t.Fatalf("statuses = %#v", statuses)
	}
}

func TestClientRecoveryFailureReturnsDaemonError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix socket test")
	}
	isolateHome(t)
	client, err := NewClient(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	client.recover = func(context.Context) error {
		return errors.New("spawn blocked")
	}

	_, err = client.RuntimeStatuses(context.Background())
	var daemonErr *DaemonError
	if !errors.As(err, &daemonErr) {
		t.Fatalf("RuntimeStatuses error = %T %v, want DaemonError", err, err)
	}
	if daemonErr.LogPath == "" || daemonErr.StatePath == "" {
		t.Fatalf("daemon error missing guidance paths: %#v", daemonErr)
	}
}

func TestRunExitsAfterIdleTimeout(t *testing.T) {
	root := daemonProjectRoot(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		errCh <- RunWithOptions(ctx, root, RunOptions{IdleTimeout: 100 * time.Millisecond})
	}()

	client, err := NewClient(root)
	if err != nil {
		t.Fatal(err)
	}
	waitForPing(t, client)

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("daemon exited with error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for idle daemon shutdown")
	}
}

func TestLeaseKeepsDaemonAlivePastIdleTimeout(t *testing.T) {
	root := daemonProjectRoot(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		errCh <- RunWithOptions(ctx, root, RunOptions{IdleTimeout: 100 * time.Millisecond})
	}()

	client, err := NewClient(root)
	if err != nil {
		t.Fatal(err)
	}
	waitForPing(t, client)
	// Keep the lease comfortably beyond any scheduler stalls while the full
	// test suite is running. The behavior under test is idle suppression, not
	// lease expiry timing.
	statuses, err := client.AcquireLease(context.Background(), "webui", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	if len(statuses) == 0 || statuses[0].DaemonLeaseCount != 1 || !slices.Contains(statuses[0].DaemonLeaseOwners, "webui") || statuses[0].DaemonIdleDeadline == "" {
		t.Fatalf("lease status missing lifecycle metadata: %#v", statuses)
	}

	time.Sleep(160 * time.Millisecond)
	if err := client.Ping(context.Background()); err != nil {
		t.Fatalf("daemon stopped despite active lease: %v", err)
	}
	if err := client.ReleaseLease(context.Background(), "webui"); err != nil {
		t.Fatalf("release lease: %v", err)
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("daemon exited with error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for idle daemon shutdown after lease release")
	}
}

func serveOneDaemonResponse(t *testing.T, client *Client, resp Response) {
	t.Helper()
	listener, err := net.Listen("unix", client.paths.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = listener.Close()
		_ = os.Remove(client.paths.SocketPath)
	})
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		var req Request
		if err := json.NewDecoder(conn).Decode(&req); err != nil {
			return
		}
		_ = json.NewEncoder(conn).Encode(resp)
	}()
}

func daemonProjectRoot(t *testing.T) string {
	t.Helper()
	isolateHome(t)
	root := t.TempDir()
	store := storage.NewStore(filepath.Join(root, ".knowns"))
	project := &models.Project{
		Name:      "daemon-lifecycle-test",
		ID:        "daemon-lifecycle-test",
		CreatedAt: time.Now().UTC(),
		Settings:  models.DefaultProjectSettings(),
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save config: %v", err)
	}
	return root
}
