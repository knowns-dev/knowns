package storage

import (
	"context"
	"path/filepath"
	"strings"
)

// WithSyncLocks runs fn while holding every lock a local mutation of the
// entities behind relPaths holds, so a sync that rewrites those files never
// interleaves with a mutation (store spec D8, D10, FR-11). relPaths are
// relative to the knowledge root, as Git reports them inside a project folder.
//
// Locks are taken in the order existing writers use: Doc mutation locks
// (sorted), then the task lifecycle lock, then the decision lifecycle lock.
// Paths outside tasks, archive, docs and decisions (config, templates) are
// written atomically and need no entity lock.
func (s *Store) WithSyncLocks(ctx context.Context, relPaths []string, fn func() error) error {
	var docs []string
	needTasks, needDecisions := false, false
	for _, rel := range relPaths {
		rel = filepath.ToSlash(strings.TrimSpace(rel))
		switch {
		case strings.HasPrefix(rel, "docs/"):
			docs = append(docs, strings.TrimPrefix(rel, "docs/"))
		case strings.HasPrefix(rel, "tasks/"), strings.HasPrefix(rel, "archive/"):
			needTasks = true
		case strings.HasPrefix(rel, "decisions/"):
			needDecisions = true
		}
	}

	withDecisions := func() error {
		if !needDecisions || s.Decisions == nil || s.Decisions.lifecycleLock == nil {
			return fn()
		}
		return s.Decisions.lifecycleLock.with(ctx, fn)
	}
	withTasks := func() error {
		if !needTasks {
			return withDecisions()
		}
		return s.taskLifecycleLock.with(ctx, withDecisions)
	}
	if len(docs) == 0 {
		return withTasks()
	}
	return s.withDocMutationLocks(ctx, docs, withTasks)
}
