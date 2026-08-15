package qdrantruntime

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

type fakeProcessController struct {
	started bool
	stopped []int
	alive   map[int]bool
	pid     int
	env     []string
	binary  string
}

func (f *fakeProcessController) Start(ctx context.Context, binary string, args []string, env []string, stdout, stderr io.Writer) (int, error) {
	_ = ctx
	_ = args
	f.started = true
	f.binary = binary
	f.env = append([]string(nil), env...)
	if f.pid == 0 {
		f.pid = 4242
	}
	if f.alive == nil {
		f.alive = map[int]bool{}
	}
	f.alive[f.pid] = true
	_, _ = io.WriteString(stdout, "qdrant fake stdout\n")
	_, _ = io.WriteString(stderr, "qdrant fake stderr\n")
	return f.pid, nil
}

func (f *fakeProcessController) Stop(pid int, timeout time.Duration) error {
	_ = timeout
	f.stopped = append(f.stopped, pid)
	if f.alive != nil {
		f.alive[pid] = false
	}
	return nil
}

func (f *fakeProcessController) Alive(pid int) bool {
	if f.alive == nil {
		return false
	}
	return f.alive[pid]
}

func TestPathsForRootUsesManagedQdrantLayout(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns", "runtime", "qdrant")
	paths := PathsForRoot(root)
	want := map[string]string{
		"root":      root,
		"bin":       filepath.Join(root, "bin"),
		"data":      filepath.Join(root, "data"),
		"logs":      filepath.Join(root, "logs"),
		"log":       filepath.Join(root, "logs", "qdrant.log"),
		"pid":       filepath.Join(root, "qdrant.pid"),
		"status":    filepath.Join(root, "status.json"),
		"snapshots": filepath.Join(root, "snapshots"),
	}
	if paths.Root != want["root"] || paths.BinDir != want["bin"] || paths.DataDir != want["data"] || paths.LogsDir != want["logs"] || paths.LogPath != want["log"] || paths.PIDPath != want["pid"] || paths.StatusPath != want["status"] || paths.SnapshotsDir != want["snapshots"] {
		t.Fatalf("paths = %#v, want %#v", paths, want)
	}
	if !strings.HasPrefix(paths.BinaryPath, paths.BinDir) || strings.Contains(paths.BinaryPath, ".knowns/.search") {
		t.Fatalf("binary path = %q, want under managed bin dir only", paths.BinaryPath)
	}
}

func TestManagerStartStopCleanupAndLogsManagedRuntime(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime", "qdrant")
	mgr := NewManager(Config{Enabled: true, Backend: models.SemanticVectorBackendQdrant, Mode: models.SemanticVectorStoreModeManaged, Root: root})
	fake := &fakeProcessController{pid: 4321, alive: map[int]bool{}}
	mgr.Controller = fake
	mgr.HealthCheck = func(context.Context, string) error { return nil }
	mgr.Now = func() time.Time { return time.Date(2026, 8, 13, 10, 30, 0, 0, time.UTC) }

	paths := mgr.Paths()
	if err := mgr.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}
	for _, dir := range []string{paths.Root, paths.BinDir, paths.DataDir, paths.LogsDir, paths.SnapshotsDir} {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			t.Fatalf("expected dir %s to exist (info=%v err=%v)", dir, info, err)
		}
	}
	if err := os.WriteFile(paths.BinaryPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write fake binary: %v", err)
	}

	status, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !fake.started || fake.binary != paths.BinaryPath {
		t.Fatalf("fake start not invoked with binary: started=%v binary=%q", fake.started, fake.binary)
	}
	if !status.Running || status.PID != 4321 || status.State != StatusRunning || !status.Installed {
		t.Fatalf("start status = %#v", status)
	}
	pidData, err := os.ReadFile(paths.PIDPath)
	if err != nil || strings.TrimSpace(string(pidData)) != "4321" {
		t.Fatalf("pid file = %q err=%v", pidData, err)
	}
	statusData, err := os.ReadFile(paths.StatusPath)
	if err != nil || !strings.Contains(string(statusData), `"state": "running"`) {
		t.Fatalf("status file missing running state: %s err=%v", statusData, err)
	}
	for _, want := range []string{
		"QDRANT__STORAGE__STORAGE_PATH=" + paths.DataDir,
		"QDRANT__STORAGE__SNAPSHOTS_PATH=" + paths.SnapshotsDir,
		"QDRANT__SERVICE__HTTP_PORT=6333",
		"QDRANT__SERVICE__GRPC_PORT=6334",
		"QDRANT__TELEMETRY_DISABLED=true",
	} {
		if !contains(fake.env, want) {
			t.Fatalf("start env missing %q in %#v", want, fake.env)
		}
	}
	var logOut bytes.Buffer
	if err := mgr.TailLog(&logOut, 5); err != nil {
		t.Fatalf("TailLog: %v", err)
	}
	if !strings.Contains(logOut.String(), "qdrant fake stdout") || !strings.Contains(logOut.String(), "qdrant fake stderr") {
		t.Fatalf("log output missing fake process logs: %q", logOut.String())
	}

	stopped, err := mgr.Stop(context.Background())
	if err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if len(fake.stopped) != 1 || fake.stopped[0] != 4321 {
		t.Fatalf("fake stopped = %#v", fake.stopped)
	}
	if stopped.Running || stopped.PID != 0 || stopped.State != StatusStopped {
		t.Fatalf("stop status = %#v", stopped)
	}
	if _, err := os.Stat(paths.PIDPath); !os.IsNotExist(err) {
		t.Fatalf("pid file should be removed after stop, err=%v", err)
	}

	if err := os.WriteFile(paths.PIDPath, []byte("9999"), 0o644); err != nil {
		t.Fatalf("write stale pid: %v", err)
	}
	cleaned, err := mgr.Cleanup(context.Background())
	if err != nil {
		t.Fatalf("Cleanup: %v", err)
	}
	if cleaned.PID != 0 || cleaned.State != StatusStopped || !strings.Contains(cleaned.Message, "stale") {
		t.Fatalf("cleanup status = %#v", cleaned)
	}
	if _, err := os.Stat(paths.PIDPath); !os.IsNotExist(err) {
		t.Fatalf("stale pid file should be removed, err=%v", err)
	}
}

func TestManagerStartReportsMissingManagedBinary(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime", "qdrant")
	mgr := NewManager(Config{Enabled: true, Backend: models.SemanticVectorBackendQdrant, Mode: models.SemanticVectorStoreModeManaged, Root: root})
	status, err := mgr.Start(context.Background())
	if err == nil {
		t.Fatal("Start without binary succeeded, want error")
	}
	if status.State != StatusNotInstalled || !strings.Contains(status.Message, "not installed") {
		t.Fatalf("status = %#v, want not-installed", status)
	}
}

func TestManagerStartWaitsForHealthAndCleansFailedProcess(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime", "qdrant")
	mgr := NewManager(Config{Enabled: true, Backend: models.SemanticVectorBackendQdrant, Mode: models.SemanticVectorStoreModeManaged, Root: root})
	fake := &fakeProcessController{pid: 7331, alive: map[int]bool{}}
	mgr.Controller = fake
	mgr.ReadinessTimeout = 30 * time.Millisecond
	checks := 0
	mgr.HealthCheck = func(ctx context.Context, endpoint string) error { checks++; return context.DeadlineExceeded }
	if err := mgr.EnsureDirs(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mgr.Paths().BinaryPath, []byte("fake"), 0o755); err != nil {
		t.Fatal(err)
	}
	status, err := mgr.Start(context.Background())
	if err == nil || !strings.Contains(err.Error(), "healthz") || !strings.Contains(err.Error(), "knowns qdrant logs") {
		t.Fatalf("status=%#v err=%v", status, err)
	}
	if checks == 0 || len(fake.stopped) != 1 || fake.stopped[0] != 7331 {
		t.Fatalf("checks=%d stopped=%v", checks, fake.stopped)
	}
	if _, statErr := os.Stat(mgr.Paths().PIDPath); !os.IsNotExist(statErr) {
		t.Fatalf("pid file remained: %v", statErr)
	}
}

func TestDefaultHealthCheckUsesHealthzAndRequires200(t *testing.T) {
	path := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { path = r.URL.Path; w.WriteHeader(http.StatusOK) }))
	defer srv.Close()
	if err := defaultHealthCheck(context.Background(), srv.URL); err != nil {
		t.Fatal(err)
	}
	if path != "/healthz" {
		t.Fatalf("path=%q", path)
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "warming", http.StatusServiceUnavailable) }))
	defer bad.Close()
	if err := defaultHealthCheck(context.Background(), bad.URL); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("err=%v", err)
	}
}

func TestExternalModeBypassesManagedProcessOwnership(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime", "qdrant")
	fake := &fakeProcessController{alive: map[int]bool{}}
	mgr := NewManager(Config{Enabled: true, Backend: models.SemanticVectorBackendQdrant, Mode: models.SemanticVectorStoreModeExternal, ExternalURL: "https://qdrant.example", Root: root})
	mgr.Controller = fake

	status, err := mgr.Start(context.Background())
	if err != nil {
		t.Fatalf("external Start: %v", err)
	}
	if fake.started {
		t.Fatal("external Start should not spawn a managed process")
	}
	if status.Managed || status.State != StatusExternal || status.Endpoint != "https://qdrant.example" || status.ExternalURL != "https://qdrant.example" {
		t.Fatalf("external status = %#v", status)
	}
	stopped, err := mgr.Stop(context.Background())
	if err != nil {
		t.Fatalf("external Stop: %v", err)
	}
	if len(fake.stopped) != 0 || stopped.Managed || stopped.State != StatusExternal {
		t.Fatalf("external Stop touched managed process or wrong status: stopped=%#v fake=%#v", stopped, fake)
	}
	cleaned, err := mgr.Cleanup(context.Background())
	if err != nil {
		t.Fatalf("external Cleanup: %v", err)
	}
	if cleaned.Managed || cleaned.State != StatusExternal || !strings.Contains(cleaned.Message, "bypassed") {
		t.Fatalf("external cleanup status = %#v", cleaned)
	}
}

func TestTailLogMissingIsNonFatal(t *testing.T) {
	mgr := NewManager(Config{Root: filepath.Join(t.TempDir(), "runtime", "qdrant")})
	var out bytes.Buffer
	if err := mgr.TailLog(&out, 10); err != nil {
		t.Fatalf("TailLog missing: %v", err)
	}
	if !strings.Contains(out.String(), "no log yet") {
		t.Fatalf("missing log message = %q", out.String())
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
