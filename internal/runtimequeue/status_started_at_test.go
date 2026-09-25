package runtimequeue

import (
	"testing"
	"time"
)

// The Activity tab marks a dead-lettered error stale when it predates the
// running build. Without the daemon's start time on the wire that could only
// be guessed with a 24h window; this proves the start time round-trips.
func TestLoadStatusReportsWhenTheDaemonStarted(t *testing.T) {
	t.Setenv(EnvRuntimeRoot, t.TempDir())
	if err := writeStatusFile(nil, nil); err != nil {
		t.Fatalf("writeStatusFile: %v", err)
	}
	status, err := LoadStatus()
	if err != nil {
		t.Fatalf("LoadStatus: %v", err)
	}
	if status.StartedAt == nil {
		t.Fatal("status has no daemon start time")
	}
	if !status.StartedAt.Equal(processStartedAt) {
		t.Fatalf("StartedAt = %v, want the process start %v", status.StartedAt, processStartedAt)
	}
	if status.StartedAt.After(time.Now()) {
		t.Fatalf("StartedAt %v is in the future", status.StartedAt)
	}
}
