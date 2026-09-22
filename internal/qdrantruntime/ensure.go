package qdrantruntime

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

// Windows bounding how often EnsureRunning does real work for one runtime
// root. They are variables rather than constants so tests can drive the clock
// boundaries without sleeping.
//
// The success window exists because Start issues an HTTP readiness probe on
// every call, even when the process is already healthy. Draining a backlog
// would otherwise pay one probe per job.
//
// The failure window matters more. The daemon runs one job at a time, and a
// failed Start can block for the full readiness timeout, so an unstartable
// backend would stall the whole queue for that timeout once per job. Replaying
// the cached failure keeps the queue moving and leaves the pacing to the job
// retry backoff, which is what governs recovery timing anyway.
var (
	ensureSuccessWindow = 15 * time.Second
	ensureFailureWindow = 5 * time.Second
)

type ensureRecord struct {
	at  time.Time
	err error
}

var (
	ensureMu    sync.Mutex
	ensureCache = map[string]ensureRecord{}
)

// EnsureRunning starts the managed Qdrant process when this configuration owns
// one and it is not already serving.
//
// It is the shared entry point for job paths that are about to talk to Qdrant
// and cannot assume anyone started it. A managed process has no supervisor: it
// dies with a reboot or a kill and nothing restores it, so every semantic
// vector operation has to be able to bring it back. That requirement is set by
// @doc/architecture/patterns/qdrant-vector-store-placement-pattern, which
// allows Qdrant as the default backend only while Knowns manages its lifecycle
// automatically.
//
// Installation is deliberately not part of this. Install reaches the network
// when the local manifest does not match, and a per-edit reconcile path is the
// wrong place to trigger a download. A missing binary surfaces as Start's own
// not-installed error, which names its remediation.
func (m *Manager) EnsureRunning(ctx context.Context) error {
	if !m.ownsManagedProcess() {
		return nil
	}
	key := m.Paths().Root
	now := m.now()
	if err, ok := lookupEnsure(key, now); ok {
		return err
	}
	err := m.startForEnsure(ctx)
	recordEnsure(key, now, err)
	return err
}

// startForEnsure runs Start and completes the one recovery Start declines to
// perform itself: when it finds a live but unhealthy process it stops that
// process and reports, leaving nothing running. Retrying once turns that into
// a real recovery within the same job rather than deferring it to the next.
func (m *Manager) startForEnsure(ctx context.Context) error {
	_, err := m.Start(ctx)
	if errors.Is(err, ErrWedgedProcessStopped) {
		_, err = m.Start(ctx)
	}
	return err
}

// ownsManagedProcess reports whether this configuration has a local process to
// look after. An external endpoint, a non-Qdrant backend, and disabled
// semantic search all own nothing, so they must cost nothing: no probe, no
// cache entry, no error.
func (m *Manager) ownsManagedProcess() bool {
	return m.Config.Enabled &&
		m.Config.Backend == models.SemanticVectorBackendQdrant &&
		m.Config.Mode == models.SemanticVectorStoreModeManaged &&
		!m.isExternal()
}

func lookupEnsure(key string, now time.Time) (error, bool) {
	ensureMu.Lock()
	defer ensureMu.Unlock()
	record, ok := ensureCache[key]
	if !ok {
		return nil, false
	}
	window := ensureSuccessWindow
	if record.err != nil {
		window = ensureFailureWindow
	}
	if now.Sub(record.at) >= window {
		return nil, false
	}
	return record.err, true
}

func recordEnsure(key string, now time.Time, err error) {
	ensureMu.Lock()
	defer ensureMu.Unlock()
	ensureCache[key] = ensureRecord{at: now, err: err}
}

// ResetEnsureCache drops the memoized ensure outcomes. Tests use it to isolate
// cases; production code has no reason to call it, since an operator command
// that changes the process state runs in its own process.
func ResetEnsureCache() {
	ensureMu.Lock()
	defer ensureMu.Unlock()
	ensureCache = map[string]ensureRecord{}
}
