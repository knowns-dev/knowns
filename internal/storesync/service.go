package storesync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/howznguyen/knowns/internal/registry"
	"github.com/howznguyen/knowns/internal/storage"
)

// Store spec D3 intervals.
const (
	DefaultDebounce      = 3 * time.Second
	DefaultFetchInterval = 30 * time.Second
	DefaultTick          = time.Second
)

// Pause causes recorded in StoreState.PauseCause.
const (
	PauseCredentials    = "credentials"
	PausePushContention = "push-contention"
)

// maxPushAttempts bounds optimistic push retries in one cycle (FR-8).
const maxPushAttempts = 3

// Config tells a Service where to find stores and how often to act.
type Config struct {
	// RegistryPath is the machine registry listing store-linked projects.
	RegistryPath string
	// StateDir receives one <store>.json state file per store.
	StateDir string
	// Debounce is how long local changes must stay quiet before a commit.
	Debounce time.Duration
	// FetchInterval is how often each store is fetched.
	FetchInterval time.Duration
	// Tick is how often the loop looks at every store.
	Tick time.Duration
	// GitTimeout bounds each Git invocation.
	GitTimeout time.Duration
	// Now is the clock; nil means time.Now.
	Now func() time.Time
	// OnSynced receives, per project folder, the paths (relative to that
	// folder) that arrived through an integration, so they can be reconciled
	// into local history and reindexed (FR-20). Called without sync locks held.
	OnSynced func(ctx context.Context, knowledgeRoot string, relPaths []string)
}

// DefaultConfig uses the machine registry and the given runtime state
// directory with the D3 intervals.
func DefaultConfig(stateDir string) Config {
	return Config{
		RegistryPath:  filepath.Join(storage.GlobalRootPath(), "registry.json"),
		StateDir:      stateDir,
		Debounce:      durationFromEnv("KNOWNS_STORE_DEBOUNCE_MS", DefaultDebounce),
		FetchInterval: durationFromEnv("KNOWNS_STORE_FETCH_INTERVAL_MS", DefaultFetchInterval),
		Tick:          DefaultTick,
		GitTimeout:    DefaultGitTimeout,
	}
}

// StoreState is what the runtime knows about one store. It is persisted for
// `knowns store status`.
type StoreState struct {
	Store         string    `json:"store"`
	Clone         string    `json:"clone"`
	Remote        string    `json:"remote,omitempty"`
	Projects      []string  `json:"projects"`
	LastCommit    time.Time `json:"lastCommit,omitempty"`
	LastPush      time.Time `json:"lastPush,omitempty"`
	LastFetch     time.Time `json:"lastFetch,omitempty"`
	QueuedCommits int       `json:"queuedCommits"`
	Paused        bool      `json:"paused"`
	PauseCause    string    `json:"pauseCause,omitempty"`
	PauseMessage  string    `json:"pauseMessage,omitempty"`
	PausedSince   time.Time `json:"pausedSince,omitempty"`
	// PushRejected and Diverged mark states the rebase path resolves.
	PushRejected bool `json:"pushRejected,omitempty"`
	Diverged     bool `json:"diverged,omitempty"`
	// Conflicts are projects paused by a rebase conflict (D2). Their files
	// keep the local content in the working tree and are left out of commits
	// until resolved; every other project keeps syncing.
	Conflicts []Conflict `json:"conflicts,omitempty"`
	LastError string     `json:"lastError,omitempty"`
	UpdatedAt time.Time  `json:"updatedAt"`
}

// Conflict is one project paused by a rebase conflict.
type Conflict struct {
	Project string    `json:"project"`
	Paths   []string  `json:"paths"`
	Since   time.Time `json:"since"`
	// Remote is the upstream commit whose version of Paths is in history.
	Remote string `json:"remote"`
}

type storeRuntime struct {
	state        StoreState
	changeSig    string
	lastChangeAt time.Time
	nextFetch    time.Time
	// rejections counts consecutive rejected pushes across attempts.
	rejections int
}

// Service syncs every store clone the registry links to.
type Service struct {
	cfg    Config
	mu     sync.Mutex
	stores map[string]*storeRuntime
	// beforePush lets tests simulate another machine winning the push race.
	beforePush func()
}

// NewService creates a Service; zero intervals take the D3 defaults.
func NewService(cfg Config) *Service {
	if cfg.Debounce <= 0 {
		cfg.Debounce = DefaultDebounce
	}
	if cfg.FetchInterval <= 0 {
		cfg.FetchInterval = DefaultFetchInterval
	}
	if cfg.Tick <= 0 {
		cfg.Tick = DefaultTick
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Service{cfg: cfg, stores: map[string]*storeRuntime{}}
}

// Run syncs until ctx ends.
func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.Tick)
	defer ticker.Stop()
	for {
		s.Tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// HasStores reports whether the last tick found any linked store; the runtime
// uses it to stay alive with no client connected.
func (s *Service) HasStores() bool {
	if len(discoverStores(s.cfg.RegistryPath)) > 0 {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.stores) > 0
}

// Tick runs one pass over every linked store.
func (s *Service) Tick(ctx context.Context) {
	for _, found := range discoverStores(s.cfg.RegistryPath) {
		if ctx.Err() != nil {
			return
		}
		s.mu.Lock()
		rt := s.stores[found.Store]
		if rt == nil {
			rt = &storeRuntime{state: s.restoredState(found.Store)}
			s.stores[found.Store] = rt
		}
		s.mu.Unlock()
		rt.state.Clone, rt.state.Remote, rt.state.Projects = found.Clone, found.Remote, found.Projects
		s.applyResolutions(rt)
		s.syncStore(ctx, rt)
		rt.state.UpdatedAt = s.cfg.Now().UTC()
		s.persist(rt.state)
	}
}

// restoredState starts a store from its persisted state, so conflicts and
// pauses survive a runtime restart: a project paused by a conflict must never
// resume committing its local content just because the daemon restarted.
func (s *Service) restoredState(store string) StoreState {
	state := StoreState{Store: store}
	if s.cfg.StateDir == "" {
		return state
	}
	persisted, err := LoadState(s.cfg.StateDir, store)
	if err != nil {
		return state
	}
	state.Conflicts = persisted.Conflicts
	state.Paused, state.PauseCause, state.PauseMessage, state.PausedSince = persisted.Paused, persisted.PauseCause, persisted.PauseMessage, persisted.PausedSince
	state.LastCommit, state.LastPush, state.LastFetch = persisted.LastCommit, persisted.LastPush, persisted.LastFetch
	return state
}

// State returns the current state of a store, if known.
func (s *Service) State(store string) (StoreState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rt, ok := s.stores[store]
	if !ok {
		return StoreState{}, false
	}
	return rt.state, true
}

func (s *Service) syncStore(ctx context.Context, rt *storeRuntime) {
	now := s.cfg.Now()
	clone := rt.state.Clone
	if info, err := os.Stat(filepath.Join(clone, ".git")); err != nil || !info.IsDir() {
		rt.state.LastError = fmt.Sprintf("%s is not a Git clone", clone)
		return
	}
	if _, err := storage.EnsureStoreGitignore(clone); err != nil {
		rt.state.LastError = err.Error()
		return
	}

	// A store paused for credentials or push contention only retries on the
	// fetch interval; local commits keep accumulating meanwhile.
	fetchDue := !now.Before(rt.nextFetch)
	s.commitWhenQuiet(ctx, rt, now)
	if rt.state.Paused && !fetchDue {
		rt.state.QueuedCommits = s.aheadCount(ctx, clone)
		return
	}

	if fetchDue {
		rt.nextFetch = now.Add(s.cfg.FetchInterval)
		if !s.fetch(ctx, rt, now) {
			rt.state.QueuedCommits = s.aheadCount(ctx, clone)
			return
		}
		if rt.state.Paused && rt.state.PauseCause == PauseCredentials {
			s.resume(rt)
		}
	}
	// Integration needs no network: it runs every tick, so a fetch that
	// arrived while local changes were pending is applied once they commit.
	s.integrate(ctx, rt)

	s.pushWithRetry(ctx, rt, now)
	rt.state.QueuedCommits = s.aheadCount(ctx, clone)
}

func (s *Service) fetch(ctx context.Context, rt *storeRuntime, now time.Time) bool {
	if _, err := s.git(ctx, rt.state.Clone, "fetch", "--prune", "origin"); err != nil {
		if ctx.Err() == nil { // a runtime shutting down is not a remote failure
			s.remoteFailed(rt, "fetch", err)
		}
		return false
	}
	rt.state.LastFetch = now.UTC()
	return true
}

// commitWhenQuiet commits the working tree once it has not changed for the
// debounce period.
func (s *Service) commitWhenQuiet(ctx context.Context, rt *storeRuntime, now time.Time) {
	clone := rt.state.Clone
	pathspec := s.syncedPathspec(rt)
	status, err := s.git(ctx, clone, append([]string{"status", "--porcelain", "--untracked-files=all", "--"}, pathspec...)...)
	if err != nil {
		rt.state.LastError = err.Error()
		return
	}
	if strings.TrimSpace(status) == "" {
		rt.changeSig, rt.lastChangeAt = "", time.Time{}
		return
	}
	sig := changeSignature(clone, status)
	if sig != rt.changeSig {
		rt.changeSig, rt.lastChangeAt = sig, now
		return
	}
	if now.Sub(rt.lastChangeAt) < s.cfg.Debounce {
		return
	}
	if _, err := s.git(ctx, clone, append([]string{"add", "-A", "--"}, pathspec...)...); err != nil {
		rt.state.LastError = err.Error()
		return
	}
	message := fmt.Sprintf("knowns: sync %s", strings.Join(changedProjects(status), ", "))
	if _, err := s.gitWithEnv(ctx, clone, identityEnv(ctx, s, clone), "commit", "--quiet", "--no-verify", "-m", message); err != nil {
		rt.state.LastError = err.Error()
		return
	}
	rt.state.LastCommit = now.UTC()
	rt.changeSig, rt.lastChangeAt = "", time.Time{}
}

func (s *Service) remoteFailed(rt *storeRuntime, op string, err error) {
	msg := err.Error()
	switch ClassifyFailure(msg) {
	case FailureCredential:
		if !rt.state.Paused || rt.state.PauseCause != PauseCredentials {
			rt.state.PausedSince = s.cfg.Now().UTC()
		}
		rt.state.Paused = true
		rt.state.PauseCause = PauseCredentials
		rt.state.PauseMessage = fmt.Sprintf("store %q paused: %s to %s was refused for lack of a working credential (Knowns uses your ssh-agent or Git credential helper and never prompts): %s", rt.state.Store, op, rt.state.Remote, firstLine(msg))
		log.Printf("[storesync] %s", rt.state.PauseMessage)
	case FailureRejected:
		rt.state.PushRejected = true
		rt.state.LastError = firstLine(msg)
	default:
		rt.state.LastError = fmt.Sprintf("%s to %s failed, will retry: %s", op, rt.state.Remote, firstLine(msg))
	}
}

func (s *Service) resume(rt *storeRuntime) {
	if rt.state.Paused {
		rt.state.Paused, rt.state.PauseCause, rt.state.PauseMessage, rt.state.PausedSince = false, "", "", time.Time{}
	}
	rt.state.LastError = ""
}

func (s *Service) hasUpstream(ctx context.Context, clone string) bool {
	_, err := s.git(ctx, clone, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
	return err == nil
}

func (s *Service) count(ctx context.Context, clone, rangeSpec string) int {
	out, err := s.git(ctx, clone, "rev-list", "--count", rangeSpec)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(out))
	return n
}

func (s *Service) aheadCount(ctx context.Context, clone string) int {
	if s.hasUpstream(ctx, clone) {
		return s.count(ctx, clone, "@{u}..HEAD")
	}
	return s.count(ctx, clone, "HEAD")
}

func (s *Service) git(ctx context.Context, dir string, args ...string) (string, error) {
	return Git(ctx, dir, s.cfg.GitTimeout, nil, args...)
}

func (s *Service) gitWithEnv(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	return Git(ctx, dir, s.cfg.GitTimeout, env, args...)
}

func (s *Service) persist(state StoreState) {
	if s.cfg.StateDir == "" {
		return
	}
	if err := os.MkdirAll(s.cfg.StateDir, 0o755); err != nil {
		return
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return
	}
	tmp := filepath.Join(s.cfg.StateDir, "."+state.Store+".json.tmp")
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, filepath.Join(s.cfg.StateDir, state.Store+".json"))
}

// LoadState reads the persisted state of a store.
func LoadState(stateDir, store string) (StoreState, error) {
	var state StoreState
	data, err := os.ReadFile(filepath.Join(stateDir, store+".json"))
	if err != nil {
		return state, err
	}
	err = json.Unmarshal(data, &state)
	return state, err
}

// identityEnv supplies a commit identity only when the clone has none, so a
// fresh machine never stalls sync on `git config user.email`.
func identityEnv(ctx context.Context, s *Service, clone string) []string {
	if out, err := s.git(ctx, clone, "config", "user.email"); err == nil && strings.TrimSpace(out) != "" {
		return nil
	}
	name := "knowns"
	if u, err := user.Current(); err == nil && u.Username != "" {
		name = u.Username
	}
	host, _ := os.Hostname()
	if host == "" {
		host = "localhost"
	}
	email := name + "@" + host
	return []string{
		"GIT_AUTHOR_NAME=" + name, "GIT_AUTHOR_EMAIL=" + email,
		"GIT_COMMITTER_NAME=" + name, "GIT_COMMITTER_EMAIL=" + email,
	}
}

// changeSignature fingerprints the changed paths with their size and mtime,
// so a file that keeps changing restarts the debounce even when its status
// line does not.
func changeSignature(clone, status string) string {
	h := sha256.New()
	h.Write([]byte(status))
	for _, line := range strings.Split(status, "\n") {
		path := statusPath(line)
		if path == "" {
			continue
		}
		if info, err := os.Stat(filepath.Join(clone, path)); err == nil {
			fmt.Fprintf(h, "%s|%d|%d\n", path, info.Size(), info.ModTime().UnixNano())
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

func statusPath(line string) string {
	if len(line) < 4 {
		return ""
	}
	path := strings.TrimSpace(line[3:])
	if i := strings.Index(path, " -> "); i >= 0 {
		path = path[i+4:]
	}
	return strings.Trim(path, `"`)
}

func changedProjects(status string) []string {
	seen := map[string]bool{}
	var out []string
	for _, line := range strings.Split(status, "\n") {
		path := statusPath(line)
		if path == "" {
			continue
		}
		project := strings.SplitN(filepath.ToSlash(path), "/", 2)[0]
		if !seen[project] {
			seen[project] = true
			out = append(out, project)
		}
	}
	sort.Strings(out)
	return out
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

type foundStore struct {
	Store    string
	Clone    string
	Remote   string
	Projects []string
}

// discoverStores groups the registry's store-linked projects by store.
func discoverStores(registryPath string) []foundStore {
	reg := registry.NewRegistryWithPath(registryPath)
	if err := reg.LoadReadOnly(); err != nil {
		return nil
	}
	byName := map[string]*foundStore{}
	var names []string
	for _, p := range reg.Projects {
		if p.Store == nil {
			continue
		}
		fs := byName[p.Store.Name]
		if fs == nil {
			fs = &foundStore{Store: p.Store.Name, Clone: filepath.Join(reg.StoresRoot(), p.Store.Name), Remote: p.Store.Remote}
			byName[p.Store.Name] = fs
			names = append(names, p.Store.Name)
		}
		fs.Projects = append(fs.Projects, p.Store.Project)
	}
	sort.Strings(names)
	out := make([]foundStore, 0, len(names))
	for _, name := range names {
		sort.Strings(byName[name].Projects)
		out = append(out, *byName[name])
	}
	return out
}

func durationFromEnv(key string, fallback time.Duration) time.Duration {
	if raw := strings.TrimSpace(os.Getenv(key)); raw != "" {
		if ms, err := strconv.Atoi(raw); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return fallback
}
