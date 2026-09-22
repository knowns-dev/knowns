package qdrantruntime

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

// ensureManager builds a manager over a temp root with a fake process
// controller and a healthy probe, which is the shape every case here starts
// from. Cases that need a sick backend override HealthCheck afterwards.
func ensureManager(t *testing.T) (*Manager, *fakeProcessController) {
	t.Helper()
	ResetEnsureCache()
	t.Cleanup(ResetEnsureCache)

	root := filepath.Join(t.TempDir(), "runtime", "qdrant")
	mgr := NewManager(Config{
		Enabled: true,
		Backend: models.SemanticVectorBackendQdrant,
		Mode:    models.SemanticVectorStoreModeManaged,
		Root:    root,
	})
	fake := &fakeProcessController{pid: 4321, alive: map[int]bool{}}
	mgr.Controller = fake
	mgr.HealthCheck = func(context.Context, string) error { return nil }
	mgr.ReadinessTimeout = 50 * time.Millisecond
	if err := mgr.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}
	if err := os.WriteFile(mgr.Paths().BinaryPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write fake binary: %v", err)
	}
	return mgr, fake
}

func TestEnsureRunningStartsAStoppedManagedQdrant(t *testing.T) {
	// The incident this exists for: the process is simply gone and nothing
	// restores it, so every job that needs Qdrant fails until an operator runs
	// a command by hand.
	mgr, fake := ensureManager(t)

	if err := mgr.EnsureRunning(context.Background()); err != nil {
		t.Fatalf("EnsureRunning: %v", err)
	}
	if !fake.started {
		t.Fatal("a stopped managed Qdrant was not started")
	}
	if data, err := os.ReadFile(mgr.Paths().PIDPath); err != nil || string(data) != "4321" {
		t.Fatalf("pid file = %q, err=%v, want the new pid recorded", data, err)
	}
}

func TestEnsureRunningRecoversFromAStalePIDFile(t *testing.T) {
	// A killed Qdrant leaves its pid file behind, which is the state a reboot
	// produces. Recovery must not require `knowns qdrant cleanup` first.
	mgr, fake := ensureManager(t)
	if err := os.WriteFile(mgr.Paths().PIDPath, []byte("9999"), 0o644); err != nil {
		t.Fatalf("write stale pid: %v", err)
	}

	if got := mgr.statusWithMessage(""); got.State != StatusStale {
		t.Fatalf("fixture state = %q, want the stale-pid state this case is about", got.State)
	}
	if err := mgr.EnsureRunning(context.Background()); err != nil {
		t.Fatalf("EnsureRunning over a stale pid: %v", err)
	}
	if !fake.started {
		t.Fatal("a stale pid file blocked the restart")
	}
	if data, err := os.ReadFile(mgr.Paths().PIDPath); err != nil || string(data) != "4321" {
		t.Fatalf("pid file = %q, err=%v, want the stale pid overwritten", data, err)
	}
}

func TestEnsureRunningLeavesAHealthyProcessAlone(t *testing.T) {
	mgr, fake := ensureManager(t)
	if err := mgr.EnsureRunning(context.Background()); err != nil {
		t.Fatalf("first EnsureRunning: %v", err)
	}
	fake.started = false

	// Past the success window, so this is a real second call rather than a
	// cache hit: it must still not spawn a second process.
	ResetEnsureCache()
	if err := mgr.EnsureRunning(context.Background()); err != nil {
		t.Fatalf("second EnsureRunning: %v", err)
	}
	if fake.started {
		t.Fatal("a second process was spawned over a healthy one")
	}
}

func TestEnsureRunningRestartsAWedgedProcessWithinOneCall(t *testing.T) {
	// Start stops a live-but-unhealthy process and reports without replacing
	// it. Left at that, the first job kills the wedged process and fails, and
	// only the next job gets a working backend.
	mgr, fake := ensureManager(t)
	fake.alive[7777] = true
	if err := os.WriteFile(mgr.Paths().PIDPath, []byte("7777"), 0o644); err != nil {
		t.Fatalf("write live pid: %v", err)
	}
	probes := 0
	mgr.HealthCheck = func(context.Context, string) error {
		probes++
		if probes == 1 {
			return errors.New("unhealthy")
		}
		return nil
	}

	if err := mgr.EnsureRunning(context.Background()); err != nil {
		t.Fatalf("EnsureRunning over a wedged process: %v", err)
	}
	if len(fake.stopped) != 1 || fake.stopped[0] != 7777 {
		t.Fatalf("stopped = %v, want the wedged pid stopped exactly once", fake.stopped)
	}
	if !fake.started {
		t.Fatal("the wedged process was stopped but never replaced")
	}
}

func TestEnsureRunningReportsAnUnstartableBackend(t *testing.T) {
	// A backend that cannot come up must fail the job with the manager's own
	// message rather than letting the caller proceed as if Qdrant were up.
	mgr, _ := ensureManager(t)
	if err := os.Remove(mgr.Paths().BinaryPath); err != nil {
		t.Fatalf("remove binary: %v", err)
	}

	err := mgr.EnsureRunning(context.Background())
	if err == nil {
		t.Fatal("a missing binary reported success")
	}
	if got := err.Error(); !strings.Contains(got, "not found") {
		t.Fatalf("error = %q, want the manager's not-installed message", got)
	}
}

func TestEnsureRunningSkipsConfigurationsThatOwnNoProcess(t *testing.T) {
	for _, tc := range []struct {
		name string
		cfg  Config
	}{
		{"external endpoint", Config{Enabled: true, Backend: models.SemanticVectorBackendQdrant, Mode: models.SemanticVectorStoreModeExternal, ExternalURL: "http://example.invalid:6333"}},
		{"semantic search disabled", Config{Enabled: false, Backend: models.SemanticVectorBackendQdrant, Mode: models.SemanticVectorStoreModeManaged}},
		{"non-qdrant backend", Config{Enabled: true, Backend: models.SemanticVectorBackendSQLite, Mode: models.SemanticVectorStoreModeManaged}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ResetEnsureCache()
			t.Cleanup(ResetEnsureCache)
			cfg := tc.cfg
			cfg.Root = filepath.Join(t.TempDir(), "runtime", "qdrant")
			mgr := NewManager(cfg)
			fake := &fakeProcessController{alive: map[int]bool{}}
			mgr.Controller = fake
			mgr.HealthCheck = func(context.Context, string) error {
				t.Fatal("a configuration that owns no managed process still probed for readiness")
				return nil
			}

			if err := mgr.EnsureRunning(context.Background()); err != nil {
				t.Fatalf("EnsureRunning: %v", err)
			}
			if fake.started {
				t.Fatal("a configuration that owns no managed process started one")
			}
			// Start refuses these three on its own, so the assertions above
			// hold with or without the guard in EnsureRunning. What the guard
			// uniquely buys is costing nothing at all: no memo entry recorded
			// for a root whose process this configuration does not own.
			ensureMu.Lock()
			cached := len(ensureCache)
			ensureMu.Unlock()
			if cached != 0 {
				t.Fatalf("memo entries = %d, want none for a configuration that owns no process", cached)
			}
		})
	}
}

func TestEnsureRunningMemoizesBothOutcomesWithinTheirWindows(t *testing.T) {
	// Start probes for readiness on every call, and a failing Start can block
	// for the whole readiness timeout. The daemon runs one job at a time, so
	// without memoization a long queue pays either cost once per job.
	mgr, _ := ensureManager(t)
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	mgr.Now = func() time.Time { return now }
	probes := 0
	healthy := true
	mgr.HealthCheck = func(context.Context, string) error {
		probes++
		if healthy {
			return nil
		}
		return errors.New("connection refused")
	}

	if err := mgr.EnsureRunning(context.Background()); err != nil {
		t.Fatalf("first EnsureRunning: %v", err)
	}
	after := probes
	now = now.Add(ensureSuccessWindow - time.Second)
	if err := mgr.EnsureRunning(context.Background()); err != nil {
		t.Fatalf("cached EnsureRunning: %v", err)
	}
	if probes != after {
		t.Fatalf("probes = %d, want no new probe inside the success window (was %d)", probes, after)
	}

	now = now.Add(2 * time.Second) // past the success window
	if err := mgr.EnsureRunning(context.Background()); err != nil {
		t.Fatalf("EnsureRunning past the success window: %v", err)
	}
	if probes == after {
		t.Fatal("the success window never expired, so a dead backend would go unnoticed")
	}

	// A failure is replayed too, so an unstartable backend fails fast instead
	// of blocking the queue for the readiness timeout once per job.
	ResetEnsureCache()
	healthy = false
	firstErr := mgr.EnsureRunning(context.Background())
	if firstErr == nil {
		t.Fatal("an unhealthy backend reported success")
	}
	after = probes
	now = now.Add(ensureFailureWindow - time.Second)
	cachedErr := mgr.EnsureRunning(context.Background())
	if cachedErr == nil {
		t.Fatal("the replayed failure reported success")
	}
	if probes != after {
		t.Fatalf("probes = %d, want the failure replayed without a new probe (was %d)", probes, after)
	}

	now = now.Add(2 * time.Second) // past the failure window
	if err := mgr.EnsureRunning(context.Background()); err == nil {
		t.Fatal("expected a fresh attempt past the failure window")
	}
	if probes == after {
		t.Fatal("the failure window never expired, so recovery could never be retried")
	}
}
