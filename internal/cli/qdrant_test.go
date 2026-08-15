package cli

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/qdrantruntime"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

type cliQdrantFakeProcess struct {
	started bool
	stopped []int
	alive   map[int]bool
	pid     int
}

func (f *cliQdrantFakeProcess) Start(ctx context.Context, binary string, args []string, env []string, stdout, stderr io.Writer) (int, error) {
	_ = ctx
	_ = binary
	_ = args
	_ = env
	f.started = true
	if f.pid == 0 {
		f.pid = 7007
	}
	if f.alive == nil {
		f.alive = map[int]bool{}
	}
	f.alive[f.pid] = true
	_, _ = io.WriteString(stdout, "started qdrant\n")
	_, _ = io.WriteString(stderr, "ready\n")
	return f.pid, nil
}

func (f *cliQdrantFakeProcess) Stop(pid int, timeout time.Duration) error {
	_ = timeout
	f.stopped = append(f.stopped, pid)
	if f.alive != nil {
		f.alive[pid] = false
	}
	return nil
}

func (f *cliQdrantFakeProcess) Alive(pid int) bool {
	if f.alive == nil {
		return false
	}
	return f.alive[pid]
}

func TestQdrantCommandRegistersRuntimeOperations(t *testing.T) {
	cmd := newQdrantCmd(qdrantCommandDependencies{})
	for _, name := range []string{"status", "start", "stop", "logs", "cleanup"} {
		if _, _, err := cmd.Find([]string{name}); err != nil {
			t.Fatalf("qdrant subcommand %q not registered: %v", name, err)
		}
	}
}

func TestQdrantStatusPlainShowsManagedPaths(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns", "runtime", "qdrant")
	mgr := qdrantruntime.NewManager(qdrantruntime.Config{Enabled: true, Backend: models.SemanticVectorBackendQdrant, Mode: models.SemanticVectorStoreModeManaged, Root: root})
	mgr.HealthCheck = func(context.Context, string) error { return nil }
	out, err := runQdrantTestCommand(t, mgr, "--plain", "qdrant", "status")
	if err != nil {
		t.Fatalf("qdrant status: %v", err)
	}
	got := out.String()
	for _, want := range []string{
		"state\tnot-installed",
		"backend\tqdrant",
		"mode\tmanaged",
		"managed\ttrue",
		"root\t" + root,
		"bin\t" + filepath.Join(root, "bin"),
		"data\t" + filepath.Join(root, "data"),
		"logs\t" + filepath.Join(root, "logs", "qdrant.log"),
		"pidFile\t" + filepath.Join(root, "qdrant.pid"),
		"statusFile\t" + filepath.Join(root, "status.json"),
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in output:\n%s", want, got)
		}
	}
}

func TestQdrantStartAndStopPlainUseManagedController(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime", "qdrant")
	mgr := qdrantruntime.NewManager(qdrantruntime.Config{Enabled: true, Backend: models.SemanticVectorBackendQdrant, Mode: models.SemanticVectorStoreModeManaged, Root: root})
	fake := &cliQdrantFakeProcess{pid: 7007, alive: map[int]bool{}}
	mgr.Controller = fake
	mgr.HealthCheck = func(context.Context, string) error { return nil }
	paths := mgr.Paths()
	if err := mgr.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}
	if err := os.WriteFile(paths.BinaryPath, []byte("fake"), 0o755); err != nil {
		t.Fatalf("write fake qdrant binary: %v", err)
	}

	out, err := runQdrantTestCommand(t, mgr, "--plain", "qdrant", "start")
	if err != nil {
		t.Fatalf("qdrant start: %v", err)
	}
	if !fake.started {
		t.Fatal("qdrant start did not invoke process controller")
	}
	if !strings.Contains(out.String(), "state\trunning") || !strings.Contains(out.String(), "pid\t7007") {
		t.Fatalf("start output missing running state/pid:\n%s", out.String())
	}

	out, err = runQdrantTestCommand(t, mgr, "--plain", "qdrant", "stop")
	if err != nil {
		t.Fatalf("qdrant stop: %v", err)
	}
	if len(fake.stopped) != 1 || fake.stopped[0] != 7007 {
		t.Fatalf("qdrant stop did not stop managed pid: %#v", fake.stopped)
	}
	if !strings.Contains(out.String(), "state\tstopped") || !strings.Contains(out.String(), "running\tfalse") {
		t.Fatalf("stop output missing stopped state:\n%s", out.String())
	}
}

func TestQdrantExternalModeBypassesLocalProcessInCLI(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime", "qdrant")
	mgr := qdrantruntime.NewManager(qdrantruntime.Config{Enabled: true, Backend: models.SemanticVectorBackendQdrant, Mode: models.SemanticVectorStoreModeExternal, ExternalURL: "https://qdrant.example", Root: root})
	fake := &cliQdrantFakeProcess{alive: map[int]bool{}}
	mgr.Controller = fake

	out, err := runQdrantTestCommand(t, mgr, "--plain", "qdrant", "start")
	if err != nil {
		t.Fatalf("qdrant start external: %v", err)
	}
	if fake.started || len(fake.stopped) != 0 {
		t.Fatalf("external qdrant command touched process controller: %#v", fake)
	}
	got := out.String()
	for _, want := range []string{"state\texternal", "mode\texternal", "managed\tfalse", "endpoint\thttps://qdrant.example", "externalURL\thttps://qdrant.example"} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in external output:\n%s", want, got)
		}
	}
}

func TestQdrantLogsCommandTailsManagedLog(t *testing.T) {
	root := filepath.Join(t.TempDir(), "runtime", "qdrant")
	mgr := qdrantruntime.NewManager(qdrantruntime.Config{Enabled: true, Backend: models.SemanticVectorBackendQdrant, Mode: models.SemanticVectorStoreModeManaged, Root: root})
	paths := mgr.Paths()
	if err := os.MkdirAll(filepath.Dir(paths.LogPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.LogPath, []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := runQdrantTestCommand(t, mgr, "--plain", "qdrant", "logs", "--tail", "2")
	if err != nil {
		t.Fatalf("qdrant logs: %v", err)
	}
	got := out.String()
	if strings.Contains(got, "one") || !strings.Contains(got, "two") || !strings.Contains(got, "three") {
		t.Fatalf("tail output wrong:\n%s", got)
	}
}

func TestQdrantManagerFromStoreResolvesExternalURL(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("qdrant-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	cfg, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	cfg.Settings.SemanticSearch = &models.SemanticSearchSettings{
		Enabled:    true,
		Model:      "qwen3-embedding:0.6b",
		Provider:   "ollama",
		Dimensions: 1024,
		VectorStore: &models.SemanticVectorStoreSettings{
			Backend:     models.SemanticVectorBackendQdrant,
			Mode:        models.SemanticVectorStoreModeExternal,
			ExternalURL: "https://qdrant.example",
		},
	}
	if err := store.Config.Save(cfg); err != nil {
		t.Fatalf("save config: %v", err)
	}
	mgr, err := qdrantManagerFromStore(store)
	if err != nil {
		t.Fatalf("qdrantManagerFromStore: %v", err)
	}
	status, err := mgr.Status(context.Background())
	if err != nil {
		t.Fatalf("manager status: %v", err)
	}
	if status.State != qdrantruntime.StatusExternal || status.ExternalURL != "https://qdrant.example" || status.Managed {
		t.Fatalf("resolved status = %#v, want external no managed ownership", status)
	}
}

func runQdrantTestCommand(t *testing.T, mgr *qdrantruntime.Manager, args ...string) (*bytes.Buffer, error) {
	t.Helper()
	root := &cobra.Command{Use: "knowns"}
	root.PersistentFlags().Bool("plain", false, "Plain output")
	root.PersistentFlags().Bool("json", false, "JSON output")
	root.AddCommand(newQdrantCmd(qdrantCommandDependencies{
		findStore: func() (*storage.Store, error) { return nil, nil },
		newManager: func(*storage.Store) (*qdrantruntime.Manager, error) {
			return mgr, nil
		},
	}))
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs(args)
	_, err := root.ExecuteC()
	return &out, err
}
