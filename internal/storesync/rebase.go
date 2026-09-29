package storesync

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/storage"
)

// syncedPathspec is every path of the clone except projects paused by a
// conflict, whose local content waits in the working tree for resolution.
func (s *Service) syncedPathspec(rt *storeRuntime) []string {
	spec := []string{"."}
	for _, c := range rt.state.Conflicts {
		spec = append(spec, ":(exclude)"+c.Project)
	}
	return spec
}

// cleanForIntegration reports whether nothing outside paused projects is
// waiting to be committed; integrating over pending changes could collide.
func (s *Service) cleanForIntegration(ctx context.Context, rt *storeRuntime) bool {
	status, err := s.git(ctx, rt.state.Clone, append([]string{"status", "--porcelain", "--untracked-files=all", "--"}, s.syncedPathspec(rt)...)...)
	return err == nil && strings.TrimSpace(status) == ""
}

// integrate brings upstream into the clone: fast-forward when strictly
// behind, rebase local commits when diverged. It holds the mutation locks of
// every entity the operation can rewrite, checks for pending changes only
// under those locks, and sets paused projects' local content aside and back
// inside them (D8, FR-11). Entities that arrived are then handed to OnSynced
// for reconciliation and indexing, after the locks are released (FR-20).
func (s *Service) integrate(ctx context.Context, rt *storeRuntime) bool {
	clone := rt.state.Clone
	if !s.hasUpstream(ctx, clone) {
		return true
	}
	behind := s.count(ctx, clone, "HEAD..@{u}")
	ahead := s.count(ctx, clone, "@{u}..HEAD")
	rt.state.Diverged = behind > 0 && ahead > 0
	if behind == 0 {
		return true
	}

	incoming := s.changedPaths(ctx, clone, "HEAD...@{u}")
	touched := append([]string{}, incoming...)
	if ahead > 0 {
		touched = append(touched, s.changedPaths(ctx, clone, "@{u}...HEAD")...)
	}
	for _, c := range rt.state.Conflicts {
		touched = append(touched, c.Paths...)
		if status, err := s.git(ctx, clone, "status", "--porcelain", "--untracked-files=all", "--", c.Project); err == nil {
			for _, line := range strings.Split(status, "\n") {
				if p := statusPath(line); p != "" {
					touched = append(touched, p)
				}
			}
		}
	}

	integrated := false
	err := s.withEntityLocks(ctx, clone, uniqueSorted(touched), func() error {
		if !s.cleanForIntegration(ctx, rt) {
			return nil // pending changes commit first; integrate on a later tick
		}
		restore, err := s.setAsidePaused(ctx, rt)
		if err != nil {
			return err
		}
		defer restore()
		if ahead == 0 {
			if _, err := s.git(ctx, clone, "merge", "--ff-only", "--quiet", "@{u}"); err != nil {
				return err
			}
			integrated = true
			return nil
		}
		integrated = s.rebase(ctx, rt)
		return nil
	})
	if err != nil {
		rt.state.LastError = err.Error()
		return false
	}
	if !integrated {
		return false
	}
	rt.state.Diverged = false
	s.notifySynced(ctx, clone, incoming)
	return true
}

// withEntityLocks holds, project by project in sorted order, the locks every
// local mutation of the entities behind paths (relative to the clone) holds.
func (s *Service) withEntityLocks(ctx context.Context, clone string, paths []string, fn func() error) error {
	byProject := map[string][]string{}
	for _, p := range paths {
		parts := strings.SplitN(filepath.ToSlash(p), "/", 2)
		if len(parts) == 2 {
			byProject[parts[0]] = append(byProject[parts[0]], parts[1])
		}
	}
	projects := make([]string, 0, len(byProject))
	for project := range byProject {
		projects = append(projects, project)
	}
	sort.Strings(projects)
	var run func(i int) error
	run = func(i int) error {
		if i == len(projects) {
			return fn()
		}
		store := storage.NewStoreWithProjectRoot(filepath.Join(clone, projects[i]), "")
		return store.WithSyncLocks(ctx, byProject[projects[i]], func() error { return run(i + 1) })
	}
	return run(0)
}

// notifySynced records who wrote each arrived file (so a stale local write
// can be explained, FR-13) and hands the paths to OnSynced, per project.
func (s *Service) notifySynced(ctx context.Context, clone string, paths []string) {
	if len(paths) == 0 {
		return
	}
	s.recordArrivals(ctx, clone, paths)
	if s.cfg.OnSynced == nil {
		return
	}
	byProject := map[string][]string{}
	for _, p := range paths {
		parts := strings.SplitN(filepath.ToSlash(p), "/", 2)
		if len(parts) == 2 {
			byProject[parts[0]] = append(byProject[parts[0]], parts[1])
		}
	}
	projects := make([]string, 0, len(byProject))
	for project := range byProject {
		projects = append(projects, project)
	}
	sort.Strings(projects)
	for _, project := range projects {
		s.cfg.OnSynced(ctx, filepath.Join(clone, project), byProject[project])
	}
}

// recordArrivals stores, per project folder, the Git author and commit of
// the last change to each arrived path.
func (s *Service) recordArrivals(ctx context.Context, clone string, paths []string) {
	now := s.cfg.Now().UTC()
	byProject := map[string][]storage.SyncArrival{}
	for _, p := range paths {
		parts := strings.SplitN(filepath.ToSlash(p), "/", 2)
		if len(parts) != 2 {
			continue
		}
		out, err := s.git(ctx, clone, "log", "-1", "--format=%an <%ae>%x1f%H", "--", p)
		if err != nil {
			continue
		}
		fields := strings.SplitN(strings.TrimSpace(out), "\x1f", 2)
		arrival := storage.SyncArrival{Path: parts[1], Author: fields[0], ArrivedAt: now}
		if len(fields) == 2 {
			arrival.Commit = fields[1]
		}
		byProject[parts[0]] = append(byProject[parts[0]], arrival)
	}
	for project, arrivals := range byProject {
		if err := storage.RecordSyncArrivals(filepath.Join(clone, project), arrivals); err != nil {
			log.Printf("[storesync] record arrivals for %s: %v", project, err)
		}
	}
}

func (s *Service) changedPaths(ctx context.Context, clone, rangeSpec string) []string {
	out, err := s.git(ctx, clone, "diff", "--name-only", rangeSpec)
	if err != nil {
		return nil
	}
	var paths []string
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			paths = append(paths, line)
		}
	}
	return paths
}

// rebase replays local commits on upstream. A textual conflict pauses only
// the projects that own the conflicting paths (D2).
func (s *Service) rebase(ctx context.Context, rt *storeRuntime) bool {
	clone := rt.state.Clone
	env := identityEnv(ctx, s, clone)
	if _, err := s.gitWithEnv(ctx, clone, env, "rebase", "--quiet", "@{u}"); err == nil {
		return true
	} else if !isConflict(ctx, s, clone) {
		_, _ = s.git(ctx, clone, "rebase", "--abort")
		rt.state.LastError = err.Error()
		return false
	}
	conflicts := s.conflictedPaths(ctx, clone)
	if _, err := s.git(ctx, clone, "rebase", "--abort"); err != nil {
		rt.state.LastError = "rebase --abort: " + err.Error()
		return false
	}
	return s.pauseConflicts(ctx, rt, conflicts, env)
}

// pauseConflicts completes the rebase with upstream's version of every
// conflicting path in history, puts the local content back in the working
// tree, and records the owning projects as paused. Local content is never
// discarded: it stays in the working tree and a copy is saved beside the
// runtime state.
func (s *Service) pauseConflicts(ctx context.Context, rt *storeRuntime, paths []string, env []string) bool {
	clone := rt.state.Clone
	local := map[string][]byte{}
	for _, p := range paths {
		if data, err := os.ReadFile(filepath.Join(clone, p)); err == nil {
			local[p] = data
		}
	}
	s.saveConflictCopies(rt.state.Store, local)

	if _, err := s.gitWithEnv(ctx, clone, env, "rebase", "--quiet", "-X", "ours", "@{u}"); err != nil {
		_, _ = s.git(ctx, clone, "rebase", "--abort")
		rt.state.LastError = "rebase preferring upstream: " + err.Error()
		return false
	}
	upstream, _ := s.git(ctx, clone, "rev-parse", "@{u}")
	upstream = strings.TrimSpace(upstream)
	for _, p := range paths {
		if _, err := s.git(ctx, clone, "cat-file", "-e", "@{u}:"+p); err == nil {
			_, _ = s.git(ctx, clone, "checkout", "@{u}", "--", p)
		} else {
			_, _ = s.git(ctx, clone, "rm", "--quiet", "--ignore-unmatch", "--", p)
		}
	}
	if staged, _ := s.git(ctx, clone, "diff", "--cached", "--name-only"); strings.TrimSpace(staged) != "" {
		msg := "knowns: keep remote version of " + strings.Join(paths, ", ") + " until resolved"
		if _, err := s.gitWithEnv(ctx, clone, env, "commit", "--quiet", "--no-verify", "-m", msg); err != nil {
			rt.state.LastError = err.Error()
			return false
		}
	}
	for p, data := range local {
		_ = os.MkdirAll(filepath.Dir(filepath.Join(clone, p)), 0o755)
		_ = os.WriteFile(filepath.Join(clone, p), data, 0o644)
	}
	for _, p := range paths {
		if _, kept := local[p]; !kept {
			_ = os.Remove(filepath.Join(clone, p))
		}
	}
	s.recordConflicts(rt, paths, upstream)
	return true
}

func (s *Service) recordConflicts(rt *storeRuntime, paths []string, upstream string) {
	byProject := map[string][]string{}
	for _, p := range paths {
		project := strings.SplitN(filepath.ToSlash(p), "/", 2)[0]
		byProject[project] = append(byProject[project], p)
	}
	now := s.cfg.Now().UTC()
	for project, ps := range byProject {
		merged := false
		for i := range rt.state.Conflicts {
			if rt.state.Conflicts[i].Project == project {
				rt.state.Conflicts[i].Paths = uniqueSorted(append(rt.state.Conflicts[i].Paths, ps...))
				rt.state.Conflicts[i].Remote = upstream
				merged = true
			}
		}
		if !merged {
			rt.state.Conflicts = append(rt.state.Conflicts, Conflict{Project: project, Paths: uniqueSorted(ps), Since: now, Remote: upstream})
		}
		log.Printf("[storesync] store %q project %q paused by a conflict in %s", rt.state.Store, project, strings.Join(ps, ", "))
	}
	sort.Slice(rt.state.Conflicts, func(i, j int) bool { return rt.state.Conflicts[i].Project < rt.state.Conflicts[j].Project })
}

// setAsidePaused resets paused projects to HEAD for the duration of an
// integration and returns a function that puts their local content back.
func (s *Service) setAsidePaused(ctx context.Context, rt *storeRuntime) (func(), error) {
	clone := rt.state.Clone
	if len(rt.state.Conflicts) == 0 {
		return func() {}, nil
	}
	saved := map[string][]byte{}
	var removed []string
	for _, c := range rt.state.Conflicts {
		status, err := s.git(ctx, clone, "status", "--porcelain", "--untracked-files=all", "--", c.Project)
		if err != nil {
			return nil, err
		}
		for _, line := range strings.Split(status, "\n") {
			p := statusPath(line)
			if p == "" {
				continue
			}
			if data, err := os.ReadFile(filepath.Join(clone, p)); err == nil {
				saved[p] = data
			} else if errors.Is(err, os.ErrNotExist) {
				removed = append(removed, p)
			}
		}
		if _, err := s.git(ctx, clone, "checkout", "HEAD", "--", c.Project); err != nil {
			return nil, err
		}
		if _, err := s.git(ctx, clone, "clean", "-fdq", "--", c.Project); err != nil {
			return nil, err
		}
	}
	return func() {
		for p, data := range saved {
			_ = os.MkdirAll(filepath.Dir(filepath.Join(clone, p)), 0o755)
			_ = os.WriteFile(filepath.Join(clone, p), data, 0o644)
		}
		for _, p := range removed {
			_ = os.Remove(filepath.Join(clone, p))
		}
	}, nil
}

// pushWithRetry pushes optimistically; the remote's atomic non-fast-forward
// rejection is the collision check (D7). A rejection fetches, integrates and
// retries, at most maxPushAttempts times, then pauses the store for push
// contention until the next fetch interval. It never forces.
func (s *Service) pushWithRetry(ctx context.Context, rt *storeRuntime, now time.Time) {
	clone := rt.state.Clone
	rt.rejections = 0
	for attempt := 1; attempt <= maxPushAttempts; attempt++ {
		args := []string{"push", "--quiet", "origin", "HEAD"}
		if s.hasUpstream(ctx, clone) {
			if s.count(ctx, clone, "@{u}..HEAD") == 0 {
				rt.state.PushRejected = false
				return
			}
		} else {
			if _, err := s.git(ctx, clone, "rev-parse", "--verify", "--quiet", "HEAD"); err != nil {
				return // nothing committed yet
			}
			args = []string{"push", "--quiet", "--set-upstream", "origin", "HEAD"}
		}
		if s.beforePush != nil {
			s.beforePush()
		}
		_, err := s.git(ctx, clone, args...)
		if err == nil {
			rt.state.LastPush = now.UTC()
			rt.state.PushRejected = false
			rt.rejections = 0
			if rt.state.Paused && rt.state.PauseCause == PausePushContention {
				s.resume(rt)
			}
			return
		}
		if ctx.Err() != nil {
			return // the runtime is shutting down
		}
		if ClassifyFailure(err.Error()) != FailureRejected {
			s.remoteFailed(rt, "push", err)
			return
		}
		rt.rejections++
		rt.state.PushRejected = true
		if !s.fetch(ctx, rt, now) || !s.integrate(ctx, rt) {
			return
		}
	}
	if !rt.state.Paused {
		rt.state.PausedSince = s.cfg.Now().UTC()
	}
	rt.state.Paused = true
	rt.state.PauseCause = PausePushContention
	rt.state.PauseMessage = fmt.Sprintf("store %q paused: push to %s was rejected %d times in a row because another machine kept pushing first; retrying at the next fetch interval", rt.state.Store, rt.state.Remote, maxPushAttempts)
	log.Printf("[storesync] %s", rt.state.PauseMessage)
}

func (s *Service) conflictedPaths(ctx context.Context, clone string) []string {
	out, err := s.git(ctx, clone, "diff", "--name-only", "--diff-filter=U")
	if err != nil {
		return nil
	}
	var paths []string
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			paths = append(paths, line)
		}
	}
	return uniqueSorted(paths)
}

func isConflict(ctx context.Context, s *Service, clone string) bool {
	return len(s.conflictedPaths(ctx, clone)) > 0
}

// saveConflictCopies keeps a copy of the local side of every conflict next to
// the runtime state, as a second guard against losing local content.
func (s *Service) saveConflictCopies(store string, local map[string][]byte) {
	if s.cfg.StateDir == "" || len(local) == 0 {
		return
	}
	dir := filepath.Join(s.cfg.StateDir, store+"-conflicts", s.cfg.Now().UTC().Format("20060102T150405Z"))
	for p, data := range local {
		dst := filepath.Join(dir, p)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err == nil {
			_ = os.WriteFile(dst, data, 0o644)
		}
	}
}

func uniqueSorted(values []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}
