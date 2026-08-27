package storage

// This file contains the lifecycle layer which sits above the Task05 content
// reconciler. Filesystem Remove/Rename notifications are observations only;
// this resolver proves ownership from the project-local manifest and stable
// canonical identity before it mutates history.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

const (
	LifecycleOperationCreate     = "create"
	LifecycleOperationRename     = "rename"
	LifecycleOperationDelete     = "delete"
	LifecycleOperationRestore    = "restore"
	LifecycleOperationHardDelete = "hard_delete"
	LifecycleOperationUpdate     = "update"
	DefaultLifecycleBatchLimit   = 512
)

// ReconcileHint fields are deliberately content-free. PreviousPath and Event
// let a watcher pass Remove/Rename observations without making them deletes.
// The resolver always rereads the canonical path and manifest.
//
// (The fields live here as an extension to the baseline type in reconciler.go.)

// LifecycleBatch describes one bounded, deterministic import/Git burst.
type LifecycleBatch struct {
	ID     string
	Source string
	Limit  int
	Hints  []ReconcileHint
	Wait   bool
	// ExactEntity* constrains bootstrap/reconciliation to one verified
	// identity and canonical path. It is used by destructive adapters so
	// unrelated moved entries cannot be opportunistically reconciled.
	ExactEntityType string
	ExactEntityID   string
	ExactPath       string
}

// LifecycleOptions controls a lifecycle pass without weakening validation.
type LifecycleOptions struct {
	Source        string
	BatchID       string
	Limit         int
	ObservedPaths []string
	// Wait keeps an execute pass pending until the absence quiet window has
	// elapsed, then retries from durable state. Callers without a scheduler
	// can use this to avoid reporting success while work is pending.
	Wait            bool
	ExactEntityType string
	ExactEntityID   string
	ExactPath       string
}

// RestoreOptions is the expected-state proof for a tombstone restore.
type RestoreOptions struct {
	Path             string
	ExpectedBaseHash string
	Actor            string
	BatchID          string
}

// HardDeleteOptions is intentionally stronger than a normal filesystem
// delete. Callers must arrive from an already authorized adapter and provide
// an explicit confirmation and non-empty reason.
type HardDeleteOptions struct {
	Trusted      bool
	Confirmed    bool
	Reason       string
	Actor        string
	Path         string
	ExpectedHash string
}

// SetLifecycleClock injects the clock used for missing-path quiet-window
// proofs. It is intended for deterministic watcher/startup tests.
func (r *FilesystemReconciler) SetLifecycleClock(now func() time.Time) {
	if now == nil {
		now = time.Now
	}
	r.lifecycleNow = now
}

// SetLifecycleAbsenceGrace changes the required stable absence interval. A
// caller may shorten this only in a controlled test; production defaults to
// ReconcileQuietWindow.
func (r *FilesystemReconciler) SetLifecycleAbsenceGrace(grace time.Duration) {
	if grace < 0 {
		grace = 0
	}
	r.absenceGrace = grace
}

// ReconcileLifecycle resolves startup state and direct filesystem lifecycle
// changes. Reconcile (Task05) remains the strict content-only API; callers
// wanting Remove/Rename semantics use this explicit surface.
func (r *FilesystemReconciler) ReconcileLifecycle(ctx context.Context, execute bool) ([]ReconcileResult, error) {
	return r.ReconcileLifecycleWithOptions(ctx, execute, LifecycleOptions{Source: "filesystem"})
}

func (r *FilesystemReconciler) ReconcileLifecycleWithOptions(ctx context.Context, execute bool, opts LifecycleOptions) ([]ReconcileResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		results, err := r.reconcileLifecycleOnce(ctx, execute, opts)
		if err != nil || !opts.Wait || !execute {
			return results, err
		}
		var retryAt time.Time
		for _, result := range results {
			if result.Pending && (retryAt.IsZero() || result.RetryAt.Before(retryAt)) {
				retryAt = result.RetryAt
			}
		}
		if retryAt.IsZero() {
			return results, nil
		}
		now := time.Now()
		if r.lifecycleNow != nil {
			now = r.lifecycleNow()
			// Injected clocks are advanced by deterministic tests; do not sleep
			// against wall time when the deadline is already reached.
			if !now.Before(retryAt) {
				continue
			}
		}
		delay := retryAt.Sub(now)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return results, ctx.Err()
		case <-timer.C:
		}
	}
}

func (r *FilesystemReconciler) reconcileLifecycleOnce(ctx context.Context, execute bool, opts LifecycleOptions) ([]ReconcileResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if strings.TrimSpace(opts.Source) == "" {
		opts.Source = "filesystem"
	}
	manifest, err := r.readManifest()
	if err != nil {
		return nil, err
	}
	recovered, recoverErr := r.recoverDocDeleteTransactions(ctx, execute)
	if recoverErr != nil {
		return recovered, recoverErr
	}
	paths, err := r.canonicalFiles()
	if err != nil {
		return nil, err
	}
	observed := make(map[string]struct{}, len(opts.ObservedPaths))
	for _, p := range opts.ObservedPaths {
		if abs, e := filepath.Abs(p); e == nil {
			observed[r.relative(abs)] = struct{}{}
		} else {
			observed[filepath.ToSlash(p)] = struct{}{}
		}
	}
	// Keep the complete canonical inventory. A platform may report only the
	// old side of a rename; seeing the new stable ID is required to avoid a
	// false delete. ObservedPaths limits which identities are mutated below.
	byPath := make(map[string]struct{}, len(paths))
	byIdentity := make(map[string]string, len(paths))
	results := make([]ReconcileResult, 0, len(paths)+len(manifest.Entries)+len(recovered))
	results = append(results, recovered...)
	results = append(results, r.flushLifecycleIntents()...)
	for _, path := range paths {
		byPath[r.relative(path)] = struct{}{}
		kind, id, _, resolveErr := r.resolveCanonicalHint(ctx, path)
		if resolveErr != nil {
			results = append(results, ReconcileResult{Path: r.relative(path), Diagnostic: resolveErr.Error()})
			continue
		}
		key := manifestKey(kind, id)
		if prior, exists := byIdentity[key]; exists && prior != path {
			results = append(results, ReconcileResult{EntityType: kind, EntityID: id, Path: r.relative(path), Diagnostic: fmt.Sprintf("%v: duplicate stable identity %q", ErrReconcileUnsafe, id)})
			continue
		}
		byIdentity[key] = path
	}

	// First resolve every manifest-owned path. This makes rename-before-create
	// and create-before-remove converge to the same proof: one old owner and one
	// final canonical file with the same stable ID.
	keys := make([]string, 0, len(manifest.Entries))
	for key := range manifest.Entries {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	deletes := make([]string, 0)
	upserts := make(map[string]manifestEntry)
	batchID := opts.BatchID
	if batchID == "" {
		batchKeys := make([]string, 0, len(keys)+len(byIdentity))
		batchKeys = append(batchKeys, keys...)
		for identity, currentPath := range byIdentity {
			batchKeys = append(batchKeys, identity+"\x00"+r.relative(currentPath))
		}
		batchID = lifecycleBatchID(r.storeRoot, opts.Source, batchKeys)
	}
	for _, key := range keys {
		entry := manifest.Entries[key]
		if opts.ExactEntityID != "" && (entry.EntityType != opts.ExactEntityType || entry.EntityID != opts.ExactEntityID) {
			continue
		}
		if opts.ExactEntityID != "" && opts.ExactPath != "" {
			if currentPath, exists := byIdentity[key]; (!exists || filepath.Clean(r.relative(currentPath)) != filepath.Clean(opts.ExactPath)) && filepath.Clean(entry.Path) != filepath.Clean(opts.ExactPath) {
				continue
			}
		}
		if len(observed) > 0 {
			if _, wasObserved := observed[filepath.ToSlash(entry.Path)]; !wasObserved {
				currentPath, hasCurrent := byIdentity[key]
				if !hasCurrent || filepath.Clean(entry.Path) == filepath.Clean(r.relative(currentPath)) {
					continue
				}
			}
		}
		if opts.Limit > 0 && lifecycleResultCount(results) >= opts.Limit {
			results = append(results, ReconcileResult{EntityType: entry.EntityType, EntityID: entry.EntityID, Path: entry.Path, Diagnostic: "lifecycle batch limit reached; hint remains retryable"})
			continue
		}
		current, exists := byIdentity[key]
		if exists {
			currentRel := r.relative(current)
			if filepath.Clean(entry.Path) == filepath.Clean(currentRel) {
				// Same-path edits still need the content reconciler. Suppress its
				// callback so the lifecycle result can carry operation/batch data.
				result, next, reconcileErr := r.reconcileLifecycleContent(ctx, current, entry, execute, opts.Source, batchID)
				if reconcileErr != nil {
					results = append(results, ReconcileResult{EntityType: entry.EntityType, EntityID: entry.EntityID, Path: currentRel, Diagnostic: reconcileErr.Error()})
					continue
				}
				results = append(results, result)
				if execute {
					upserts[key] = next
				}
				continue
			}
			// A second file at the old owned path is an ambiguous copy, even
			// when both files carry the same ID.
			if _, oldExists := byPath[entry.Path]; oldExists {
				results = append(results, ReconcileResult{EntityType: entry.EntityType, EntityID: entry.EntityID, Path: currentRel, Diagnostic: fmt.Sprintf("%v: old and new canonical paths both exist", ErrReconcileUnsafe)})
				delete(byIdentity, key)
				continue
			}
			if batchID == "" {
				batchID = lifecycleBatchID(r.storeRoot, opts.Source, []string{key + "\x00" + currentRel})
			}
			result, next, reconcileErr := r.reconcileLifecycleFile(ctx, current, entry, execute, opts.Source, batchID, LifecycleOperationRename)
			if reconcileErr != nil {
				results = append(results, ReconcileResult{EntityType: entry.EntityType, EntityID: entry.EntityID, Path: currentRel, Diagnostic: reconcileErr.Error()})
				continue
			}
			results = append(results, result)
			if execute {
				upserts[key] = next
			}
			delete(byIdentity, key)
			continue
		}

		// Missing owned path: confirm absence twice before creating a tombstone.
		owned := filepath.Join(r.storeRoot, filepath.FromSlash(filepath.Clean(entry.Path)))
		if _, pathPresent := byPath[entry.Path]; pathPresent {
			// Same-path replacement by a different stable ID is a delete of the
			// old owner plus a create for the new owner. Never infer the old
			// content from the replacement bytes.
			if _, _, _, resolveErr := r.resolveCanonicalHint(ctx, owned); resolveErr != nil {
				results = append(results, ReconcileResult{EntityType: entry.EntityType, EntityID: entry.EntityID, Path: entry.Path, Diagnostic: resolveErr.Error()})
				continue
			}
			if batchID == "" {
				batchID = lifecycleBatchID(r.storeRoot, opts.Source, []string{key + "\x00replace"})
			}
			result, tombErr := r.appendLifecycleTombstone(ctx, entry, execute, opts.Source, batchID)
			if tombErr != nil {
				results = append(results, ReconcileResult{EntityType: entry.EntityType, EntityID: entry.EntityID, Path: entry.Path, Diagnostic: tombErr.Error()})
				continue
			}
			results = append(results, result)
			if execute {
				deletes = append(deletes, key)
			}
			continue
		}
		if transientSibling(owned) {
			results = append(results, ReconcileResult{EntityType: entry.EntityType, EntityID: entry.EntityID, Path: entry.Path, Diagnostic: fmt.Sprintf("%v: transient editor replacement is still settling", ErrReconcileUnsafe)})
			continue
		}
		stable, pendingUntil, absenceErr := r.confirmStableAbsent(owned, execute)
		if absenceErr != nil {
			results = append(results, ReconcileResult{EntityType: entry.EntityType, EntityID: entry.EntityID, Path: entry.Path, Diagnostic: absenceErr.Error()})
			continue
		}
		if !stable {
			results = append(results, ReconcileResult{EntityType: entry.EntityType, EntityID: entry.EntityID, Path: entry.Path, Pending: true, RetryAt: pendingUntil, Diagnostic: fmt.Sprintf("%v: owned path absence pending until %s", ErrReconcileUnsafe, pendingUntil.UTC().Format(time.RFC3339Nano))})
			continue
		}
		if batchID == "" {
			batchID = lifecycleBatchID(r.storeRoot, opts.Source, []string{key + "\x00delete"})
		}
		result, tombErr := r.appendLifecycleTombstone(ctx, entry, execute, opts.Source, batchID)
		if tombErr != nil {
			results = append(results, ReconcileResult{EntityType: entry.EntityType, EntityID: entry.EntityID, Path: entry.Path, Diagnostic: tombErr.Error()})
			continue
		}
		results = append(results, result)
		if execute {
			deletes = append(deletes, key)
		}
	}

	// New IDs and same-path replacement IDs are reconciled only after old
	// ownership has been proven and tombstoned. This prevents implicit reuse.
	remaining := make([]string, 0, len(byIdentity))
	for key := range byIdentity {
		remaining = append(remaining, key)
	}
	sort.Strings(remaining)
	for _, key := range remaining {
		path := byIdentity[key]
		if opts.ExactEntityID != "" {
			if key != manifestKey(opts.ExactEntityType, opts.ExactEntityID) || (opts.ExactPath != "" && filepath.Clean(r.relative(path)) != filepath.Clean(opts.ExactPath)) {
				continue
			}
		}
		if len(observed) > 0 {
			if _, ok := observed[r.relative(path)]; !ok {
				continue
			}
		}
		if opts.Limit > 0 && lifecycleResultCount(results) >= opts.Limit {
			results = append(results, ReconcileResult{Path: r.relative(path), Diagnostic: "lifecycle batch limit reached; hint remains retryable"})
			continue
		}
		// The baseline reconciler remains the source of content parsing/delta
		// selection. Its callback is replayed below with the batch metadata.
		savedIndex := r.index
		savedBatch, savedSource, savedOperation := r.activeBatchID, r.activeSource, r.activeOperation
		savedPrevious, savedCurrent := r.activePreviousPath, r.activeCurrentPath
		r.index = nil
		r.activeBatchID, r.activeSource, r.activeOperation = batchID, opts.Source, LifecycleOperationCreate
		r.activePreviousPath, r.activeCurrentPath = "", r.relative(path)
		result, next, reconcileErr := r.reconcileFile(ctx, path, execute)
		r.index = savedIndex
		r.activeBatchID, r.activeSource, r.activeOperation = savedBatch, savedSource, savedOperation
		r.activePreviousPath, r.activeCurrentPath = savedPrevious, savedCurrent
		if reconcileErr != nil {
			results = append(results, ReconcileResult{Path: r.relative(path), Diagnostic: reconcileErr.Error()})
			continue
		}
		if result.Operation == "" {
			result.Operation = LifecycleOperationCreate
		}
		if batchID == "" {
			batchID = lifecycleBatchID(r.storeRoot, opts.Source, []string{key + "\x00" + r.relative(path)})
		}
		result.BatchID = batchID
		result.CurrentPath, result.NewHash = result.Path, result.Hash
		results = append(results, result)
		if execute {
			next.Path = r.relative(path)
			next.EntityType, next.EntityID = result.EntityType, result.EntityID
			next.Hash = result.Hash
			upserts[key] = next
		}
	}
	if execute {
		// Stage content-free intents before ownership activation. The flush
		// gate below will deliver them only after the manifest reflects the
		// result, making a crash between the two phases recoverable.
		for _, result := range results {
			if result.Diagnostic != "" || r.index == nil {
				continue
			}
			if result.Changed || result.Operation == LifecycleOperationCreate || result.Operation == LifecycleOperationUpdate || result.Operation == LifecycleOperationRename || result.Operation == LifecycleOperationDelete || result.Operation == LifecycleOperationRestore || result.Operation == LifecycleOperationHardDelete {
				if err := r.queueLifecycleIntent(result); err != nil {
					results = append(results, ReconcileResult{EntityType: result.EntityType, EntityID: result.EntityID, Path: result.Path, Diagnostic: err.Error()})
					return results, nil
				}
			}
		}
	}
	if execute && (len(upserts) > 0 || len(deletes) > 0) {
		if err := r.writeManifestMutations(upserts, deletes); err != nil {
			return results, err
		}
	}
	if execute {
		results = append(results, r.flushLifecycleIntents()...)
	}
	sort.SliceStable(results, func(i, j int) bool { return results[i].Path < results[j].Path })
	return results, nil
}

func lifecycleResultCount(results []ReconcileResult) int {
	count := 0
	for _, result := range results {
		if result.Operation != "" && result.Diagnostic == "" {
			count++
		}
	}
	return count
}

// ReconcileLifecycleBatch applies one bounded project-local burst. Hints are
// coalesced by stable identity and selected deterministically before any
// history mutation, so hundreds of raw fs events cannot fan out work.
func (r *FilesystemReconciler) ReconcileLifecycleBatch(ctx context.Context, batch LifecycleBatch, execute bool) ([]ReconcileResult, error) {
	if batch.Limit <= 0 {
		batch.Limit = DefaultLifecycleBatchLimit
	}
	if batch.Source == "" {
		batch.Source = "filesystem-batch"
	}
	resolved, diagnostics := r.ResolveHints(ctx, batch.Hints)
	if len(resolved) > batch.Limit {
		resolved = resolved[:batch.Limit]
	}
	keys := make([]string, 0, len(resolved))
	for _, hint := range resolved {
		keys = append(keys, hint.EntityType+":"+hint.EntityID+"\x00"+r.relative(filepath.Clean(hint.Path))+"\x00"+hint.Hash)
	}
	// Removed paths cannot be resolved by ResolveHints, but remain valid
	// observations for the manifest-owned tombstone decision. Bound both the
	// identity set and the observed path set before entering the coordinator.
	observedPaths := make([]string, 0, len(batch.Hints))
	seenPaths := make(map[string]struct{}, len(batch.Hints))
	for _, hint := range batch.Hints {
		p := filepath.Clean(hint.Path)
		if _, ok := seenPaths[p]; !ok {
			seenPaths[p] = struct{}{}
			observedPaths = append(observedPaths, p)
		}
	}
	sort.Strings(observedPaths)
	if len(observedPaths) > batch.Limit {
		for _, skipped := range observedPaths[batch.Limit:] {
			diagnostics = append(diagnostics, ReconcileResult{Path: skipped, Diagnostic: "lifecycle batch limit reached; observation remains retryable"})
		}
		observedPaths = observedPaths[:batch.Limit]
	}
	if len(keys) == 0 {
		for _, p := range observedPaths {
			keys = append(keys, "path\x00"+r.relative(p))
		}
	}
	if batch.ID == "" {
		batch.ID = lifecycleBatchID(r.storeRoot, batch.Source, keys)
	}
	results, err := r.ReconcileLifecycleWithOptions(ctx, execute, LifecycleOptions{Source: batch.Source, BatchID: batch.ID, Limit: batch.Limit, ObservedPaths: observedPaths, Wait: batch.Wait, ExactEntityType: batch.ExactEntityType, ExactEntityID: batch.ExactEntityID, ExactPath: batch.ExactPath})
	// Preserve malformed/ambiguous hint diagnostics so bounded work remains
	// diagnosable and retryable. ResolveHints intentionally filters only the
	// expected missing old side of Remove/Rename observations.
	results = append(diagnostics, results...)
	return results, err
}

// ReconcileLifecycleBatchWithOptions is retained as a small adapter for
// schedulers that prefer an explicit wait argument.
func (r *FilesystemReconciler) ReconcileLifecycleBatchWithOptions(ctx context.Context, batch LifecycleBatch, execute, wait bool) ([]ReconcileResult, error) {
	batch.Wait = wait
	return r.ReconcileLifecycleBatch(ctx, batch, execute)
}

// ReconcileBulk is a compatibility alias for import/Git coordinators.
func (r *FilesystemReconciler) ReconcileBulk(ctx context.Context, batch LifecycleBatch, execute bool) ([]ReconcileResult, error) {
	return r.ReconcileLifecycleBatch(ctx, batch, execute)
}

func lifecycleBatchID(root, source string, keys []string) string {
	sort.Strings(keys)
	h := sha256.New()
	_, _ = h.Write([]byte(filepath.Clean(root)))
	_, _ = h.Write([]byte("\x00" + source + "\x00"))
	for _, key := range keys {
		_, _ = h.Write([]byte(key + "\x00"))
	}
	return "batch-" + hex.EncodeToString(h.Sum(nil))[:24]
}

func (r *FilesystemReconciler) missingStatePath() string {
	return filepath.Join(r.storeRoot, "history", "state", "missing-since.json")
}

func (r *FilesystemReconciler) loadMissingSince() (map[string]time.Time, error) {
	if r.missingSince != nil {
		return r.missingSince, nil
	}
	values := map[string]string{}
	if err := readJSON(r.missingStatePath(), &values); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	r.missingSince = make(map[string]time.Time, len(values))
	for path, value := range values {
		if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
			r.missingSince[path] = parsed
		}
	}
	return r.missingSince, nil
}

func (r *FilesystemReconciler) saveMissingSince(values map[string]time.Time) error {
	encoded := make(map[string]string, len(values))
	for path, value := range values {
		encoded[path] = value.UTC().Format(time.RFC3339Nano)
	}
	r.missingSince = values
	return durableWriteJSON(r.missingStatePath(), encoded)
}

// confirmStableAbsent is a temporal proof, not a pair of immediate stats.
// The first absence is persisted as a pending observation; only a later pass
// after the quiet window may append a tombstone.
func (r *FilesystemReconciler) confirmStableAbsent(path string, execute bool) (bool, time.Time, error) {
	if _, err := os.Lstat(path); err == nil {
		values, loadErr := r.loadMissingSince()
		if loadErr != nil {
			return false, time.Time{}, loadErr
		}
		if _, pending := values[path]; pending && execute {
			delete(values, path)
			if err := r.saveMissingSince(values); err != nil {
				return false, time.Time{}, err
			}
		}
		return false, time.Time{}, nil
	} else if !os.IsNotExist(err) {
		return false, time.Time{}, err
	}
	values, err := r.loadMissingSince()
	if err != nil {
		return false, time.Time{}, err
	}
	now := time.Now()
	if r.lifecycleNow != nil {
		now = r.lifecycleNow()
	}
	since, ok := values[path]
	if !ok {
		since = now
		if execute {
			values[path] = since
			if err := r.saveMissingSince(values); err != nil {
				return false, since, err
			}
		}
		return false, since.Add(r.absenceGrace), nil
	}
	grace := r.absenceGrace
	if grace <= 0 {
		grace = ReconcileQuietWindow
	}
	if now.Before(since.Add(grace)) {
		return false, since.Add(grace), nil
	}
	if execute {
		delete(values, path)
		if err := r.saveMissingSince(values); err != nil {
			return false, since.Add(grace), err
		}
	}
	return true, since.Add(grace), nil
}

func transientSibling(path string) bool {
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		return false
	}
	base := filepath.Base(path)
	for _, entry := range entries {
		name := entry.Name()
		if name == base {
			continue
		}
		lower := strings.ToLower(name)
		if strings.HasPrefix(name, ".") || strings.HasSuffix(lower, ".tmp") || strings.HasSuffix(lower, ".swp") || strings.HasSuffix(lower, "~") || strings.Contains(lower, ".autosave") {
			return true
		}
	}
	return false
}

func (r *FilesystemReconciler) reconcileLifecycleFile(ctx context.Context, path string, previous manifestEntry, execute bool, source, batchID, operation string) (ReconcileResult, manifestEntry, error) {
	data, err := stableRead(path)
	if err != nil {
		return ReconcileResult{}, manifestEntry{}, fmt.Errorf("%w: unstable canonical file", ErrReconcileUnsafe)
	}
	kind, id, hash, err := r.resolveCanonicalHint(ctx, path)
	if err != nil {
		return ReconcileResult{}, manifestEntry{}, err
	}
	if kind != previous.EntityType || id != previous.EntityID {
		return ReconcileResult{}, manifestEntry{}, fmt.Errorf("%w: lifecycle identity changed", ErrReconcileUnsafe)
	}
	var snapshot map[string]any
	if kind == "task" {
		task, e := parseTaskContent(string(data))
		if e != nil {
			return ReconcileResult{}, manifestEntry{}, e
		}
		snapshot = TaskToSnapshot(task)
	} else {
		rel, _ := filepath.Rel(filepath.Join(r.storeRoot, "docs"), path)
		doc, e := parseDocContent(string(data), strings.TrimSuffix(filepath.ToSlash(rel), ".md"), filepath.Dir(rel), false, "")
		if e != nil {
			return ReconcileResult{}, manifestEntry{}, e
		}
		snapshot = DocToSnapshot(doc)
	}
	stream, err := r.history.Read(ctx, kind, id)
	if err != nil {
		return ReconcileResult{}, manifestEntry{}, err
	}
	result := ReconcileResult{EntityType: kind, EntityID: id, Path: r.relative(path), Hash: hash, Operation: operation, BatchID: batchID, PreviousPath: previous.Path, CurrentPath: r.relative(path), BaseHash: previous.HeadHash, NewHash: hash}
	entry := manifestEntry{EntityType: kind, EntityID: id, Path: r.relative(path), Hash: hash}
	if len(stream.Records) > 0 {
		last := stream.Records[len(stream.Records)-1]
		if last.Operation == operation && last.CurrentPath == r.relative(path) && last.NewHash == hash {
			entry.Revision, entry.HeadHash = last.Revision, last.NewHash
			result.Revision, result.Changed = last.Revision, false
			return result, entry, nil
		}
	}
	if !execute {
		if len(stream.Records) == 0 {
			result.Changed, result.Revision = true, 1
		} else {
			result.Revision = stream.Records[len(stream.Records)-1].Revision + 1
			result.Changed = true
		}
		return result, entry, nil
	}
	base := ""
	rev := 1
	if len(stream.Records) > 0 {
		base = stream.Records[len(stream.Records)-1].NewHash
		rev = stream.Records[len(stream.Records)-1].Revision + 1
	}
	record := r.filesystemRecord(kind, id, base, hash, snapshot, stream.Records)
	record.Operation, record.BatchID, record.Source = operation, batchID, source
	record.PreviousPath, record.CurrentPath = previous.Path, r.relative(path)
	if err := r.appendHistoryRecord(ctx, record); err != nil {
		return result, entry, err
	}
	entry.Revision, entry.HeadHash = rev, hash
	result.Revision, result.Changed = rev, true
	return result, entry, nil
}

func (r *FilesystemReconciler) reconcileLifecycleContent(ctx context.Context, path string, previous manifestEntry, execute bool, source, batchID string) (ReconcileResult, manifestEntry, error) {
	savedIndex := r.index
	savedBatch, savedSource, savedOperation := r.activeBatchID, r.activeSource, r.activeOperation
	savedPrevious, savedCurrent := r.activePreviousPath, r.activeCurrentPath
	r.index = nil
	r.activeBatchID, r.activeSource, r.activeOperation = batchID, source, LifecycleOperationUpdate
	r.activePreviousPath, r.activeCurrentPath = previous.Path, r.relative(path)
	result, entry, err := r.reconcileFile(ctx, path, execute)
	r.index = savedIndex
	r.activeBatchID, r.activeSource, r.activeOperation = savedBatch, savedSource, savedOperation
	r.activePreviousPath, r.activeCurrentPath = savedPrevious, savedCurrent
	if err != nil {
		return result, entry, err
	}
	result.Operation, result.BatchID, result.PreviousPath, result.CurrentPath = LifecycleOperationUpdate, batchID, previous.Path, r.relative(path)
	result.BaseHash, result.NewHash = previous.HeadHash, result.Hash
	return result, entry, nil
}

func (r *FilesystemReconciler) appendLifecycleTombstone(ctx context.Context, entry manifestEntry, execute bool, source, batchID string) (ReconcileResult, error) {
	var result ReconcileResult
	err := r.withLifecycleEntityLock(ctx, entry.EntityType, entry.EntityID, func() error {
		var inner error
		result, inner = r.appendLifecycleTombstoneLocked(ctx, entry, execute, source, batchID)
		return inner
	})
	return result, err
}

func (r *FilesystemReconciler) appendLifecycleTombstoneLocked(ctx context.Context, entry manifestEntry, execute bool, source, batchID string) (ReconcileResult, error) {
	stream, err := r.history.Read(ctx, entry.EntityType, entry.EntityID)
	if err != nil {
		return ReconcileResult{}, err
	}
	if len(stream.Records) == 0 {
		return ReconcileResult{}, fmt.Errorf("%w: no verified history for deleted %s %q", ErrReconcileUnsafe, entry.EntityType, entry.EntityID)
	}
	last := stream.Records[len(stream.Records)-1]
	if last.Tombstone && last.Operation == LifecycleOperationDelete {
		result := ReconcileResult{EntityType: entry.EntityType, EntityID: entry.EntityID, Path: entry.Path, Hash: last.NewHash, Operation: LifecycleOperationDelete, BatchID: last.BatchID, PreviousPath: entry.Path, CurrentPath: entry.Path, BaseHash: last.NewHash, NewHash: last.NewHash, Revision: last.Revision}
		return result, nil
	}
	snapshot, err := r.replaySnapshot(entry.EntityType, entry.EntityID, stream.Records)
	if err != nil {
		return ReconcileResult{}, err
	}
	result := ReconcileResult{EntityType: entry.EntityType, EntityID: entry.EntityID, Path: entry.Path, Hash: last.NewHash, Operation: LifecycleOperationDelete, BatchID: batchID, PreviousPath: entry.Path, CurrentPath: entry.Path, BaseHash: last.NewHash, NewHash: last.NewHash, Changed: true, Revision: last.Revision + 1}
	if !execute {
		return result, nil
	}
	record := models.HistoryRecord{EntityType: entry.EntityType, EntityID: entry.EntityID, Source: source, BatchID: batchID, Operation: LifecycleOperationDelete, Tombstone: true, Timestamp: time.Now().UTC(), BaseHash: last.NewHash, NewHash: last.NewHash, Checkpoint: true, CheckpointPayload: snapshot, PreviousPath: entry.Path, CurrentPath: entry.Path}
	if err := r.appendHistoryRecord(ctx, record); err != nil {
		return result, err
	}
	return result, nil
}

// recoverDocDeleteTransactions resolves an interrupted API delete journal.
// Markers are metadata-only and are retained on every ambiguity.
func (r *FilesystemReconciler) recoverDocDeleteTransactions(ctx context.Context, execute bool) ([]ReconcileResult, error) {
	dir := docDeleteTransactionDir(r.storeRoot)
	files, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var results []ReconcileResult
	for _, file := range files {
		if file.IsDir() || filepath.Ext(file.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, file.Name()))
		if err != nil {
			results = append(results, ReconcileResult{Diagnostic: err.Error()})
			continue
		}
		var marker docDeleteTransaction
		if err := json.Unmarshal(data, &marker); err != nil {
			results = append(results, ReconcileResult{Diagnostic: fmt.Sprintf("%v: invalid doc delete transaction marker", ErrReconcileUnsafe)})
			continue
		}
		cleanPath := filepath.ToSlash(filepath.Clean(marker.Path))
		if marker.SchemaVersion != 1 || strings.TrimSpace(marker.EntityID) == "" || strings.TrimSpace(marker.Hash) == "" || file.Name() != filepath.Base(docDeleteTransactionPath(r.storeRoot, marker.EntityID)) || strings.Contains(marker.Path, "\\") || filepath.IsAbs(marker.Path) || cleanPath != marker.Path || !strings.HasPrefix(cleanPath, "docs/") || strings.Contains(cleanPath, "../") {
			results = append(results, ReconcileResult{Path: marker.Path, Diagnostic: fmt.Sprintf("%v: invalid doc delete transaction marker", ErrReconcileUnsafe)})
			continue
		}
		abs, pathErr := safeMissingDocTransactionPath(r.storeRoot, marker.Path)
		if pathErr != nil {
			results = append(results, ReconcileResult{Path: marker.Path, Diagnostic: pathErr.Error()})
			continue
		}
		result := ReconcileResult{}
		err = r.withLifecycleEntityLock(ctx, "doc", marker.EntityID, func() error {
			stream, e := r.history.Read(ctx, "doc", marker.EntityID)
			if e != nil || len(stream.Records) == 0 {
				return fmt.Errorf("%w: delete transaction has no verified history", ErrReconcileUnsafe)
			}
			last := stream.Records[len(stream.Records)-1]
			_, statErr := os.Stat(abs)
			if statErr == nil {
				if last.Tombstone {
					return fmt.Errorf("%w: tombstoned Doc canonical file is live", ErrReconcileUnsafe)
				}
				if last.NewHash != marker.Hash {
					return fmt.Errorf("%w: delete transaction history hash mismatch", ErrReconcileUnsafe)
				}
				if execute {
					return removeDocDeleteTransaction(r.storeRoot, marker.EntityID)
				}
				return nil
			}
			if !os.IsNotExist(statErr) {
				return statErr
			}
			entry := manifestEntry{EntityType: "doc", EntityID: marker.EntityID, Path: marker.Path, HeadHash: marker.Hash, Revision: last.Revision}
			if last.Tombstone && last.Operation == LifecycleOperationDelete {
				result = ReconcileResult{EntityType: "doc", EntityID: marker.EntityID, Path: marker.Path, Hash: last.NewHash, Operation: LifecycleOperationDelete, PreviousPath: marker.Path, CurrentPath: marker.Path, BaseHash: last.NewHash, NewHash: last.NewHash, Revision: last.Revision}
				if execute {
					return removeDocDeleteTransaction(r.storeRoot, marker.EntityID)
				}
				return nil
			}
			if last.NewHash != marker.Hash {
				return fmt.Errorf("%w: delete transaction history hash mismatch", ErrReconcileUnsafe)
			}
			var appendErr error
			result, appendErr = r.appendLifecycleTombstoneLocked(ctx, entry, execute, marker.Source, marker.BatchID)
			if appendErr != nil {
				return appendErr
			}
			if execute {
				return removeDocDeleteTransaction(r.storeRoot, marker.EntityID)
			}
			return nil
		})
		if err != nil {
			results = append(results, ReconcileResult{EntityType: "doc", EntityID: marker.EntityID, Path: marker.Path, Diagnostic: err.Error()})
		} else if result.EntityID != "" {
			results = append(results, result)
		}
	}
	return results, nil
}

// safeMissingDocTransactionPath validates a journal target without requiring
// the final file to exist. Existing ancestors must remain real directories so
// a corrupted marker cannot seed history that later restores through a
// symlink outside the canonical docs root.
func safeMissingDocTransactionPath(storeRoot, relative string) (string, error) {
	docsRoot, err := filepath.Abs(filepath.Join(storeRoot, "docs"))
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(filepath.Join(storeRoot, filepath.FromSlash(relative)))
	if err != nil {
		return "", err
	}
	if !under(docsRoot, abs) || filepath.Clean(abs) == filepath.Clean(docsRoot) {
		return "", fmt.Errorf("%w: doc delete transaction path outside docs root", ErrReconcileUnsafe)
	}
	if info, statErr := os.Lstat(abs); statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("%w: symlink target in doc delete transaction path", ErrReconcileUnsafe)
		}
		if !info.Mode().IsRegular() {
			return "", fmt.Errorf("%w: non-regular target in doc delete transaction path", ErrReconcileUnsafe)
		}
	} else if !os.IsNotExist(statErr) {
		return "", statErr
	}
	for current := filepath.Dir(abs); under(docsRoot, current); current = filepath.Dir(current) {
		info, statErr := os.Lstat(current)
		if os.IsNotExist(statErr) {
			continue
		}
		if statErr != nil {
			return "", statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("%w: symlink ancestor in doc delete transaction path", ErrReconcileUnsafe)
		}
		if filepath.Clean(current) == filepath.Clean(docsRoot) {
			break
		}
	}
	return abs, nil
}

func (r *FilesystemReconciler) replaySnapshot(kind, id string, records []models.HistoryRecord) (map[string]any, error) {
	if kind == "task" {
		h, err := taskHistoryFromRecords(id, records)
		if err != nil || len(h.Versions) == 0 {
			return nil, err
		}
		return cloneMap(h.Versions[len(h.Versions)-1].Snapshot), nil
	}
	path := ""
	for _, rec := range records {
		path = firstNonEmpty(rec.CurrentPath, rec.PreviousPath, path)
	}
	h, err := docHistoryFromRecords(path, records)
	if err != nil || len(h.Versions) == 0 {
		return nil, err
	}
	return cloneMap(h.Versions[len(h.Versions)-1].Snapshot), nil
}

// Restore recreates the canonical file from the verified tombstone state and
// appends one restore revision. Existing canonical content or stale expected
// hashes fail closed and produce no history/manifest mutation.
func (r *FilesystemReconciler) withLifecycleEntityLock(ctx context.Context, entityType, entityID string, fn func() error) error {
	// Prefix the lock identity so the lifecycle coordinator lock is distinct
	// from HistoryStore's actual entity lock acquired by Read/Append. This
	// avoids non-reentrant deadlocks while serializing proof through activation.
	return r.history.withEntityLock(ctx, entityType, "__lifecycle__:"+entityID, fn)
}

func (r *FilesystemReconciler) Restore(ctx context.Context, entityType, entityID string, opts RestoreOptions) (ReconcileResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	var result ReconcileResult
	err := r.withLifecycleEntityLock(ctx, entityType, entityID, func() error {
		var err error
		result, err = r.restoreLocked(ctx, entityType, entityID, opts)
		return err
	})
	return result, err
}

func (r *FilesystemReconciler) restoreLocked(ctx context.Context, entityType, entityID string, opts RestoreOptions) (ReconcileResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	manifest, err := r.readManifest()
	if err != nil {
		return ReconcileResult{}, err
	}
	stream, err := r.history.Read(ctx, entityType, entityID)
	if err != nil {
		return ReconcileResult{}, err
	}
	if len(stream.Records) == 0 || (!stream.Records[len(stream.Records)-1].Tombstone && stream.Records[len(stream.Records)-1].Operation != LifecycleOperationRestore) {
		return ReconcileResult{}, fmt.Errorf("%w: entity is not tombstoned", ErrReconcileUnsafe)
	}
	last := stream.Records[len(stream.Records)-1]
	if opts.ExpectedBaseHash != "" && opts.ExpectedBaseHash != last.NewHash {
		return ReconcileResult{}, fmt.Errorf("%w: restore base hash mismatch", ErrHistoryConflict)
	}
	entry, ok := manifest.Entries[manifestKey(entityType, entityID)]
	path := opts.Path
	if strings.TrimSpace(opts.Path) != "" && filepath.IsAbs(filepath.FromSlash(opts.Path)) {
		return ReconcileResult{}, fmt.Errorf("%w: absolute restore path", ErrReconcileUnsafe)
	}
	if path == "" && ok {
		path = entry.Path
	}
	if path == "" {
		path = last.CurrentPath
	}
	path = filepath.ToSlash(strings.TrimPrefix(filepath.Clean(filepath.FromSlash(path)), "/"))
	if entityType == "doc" && !strings.HasSuffix(path, ".md") {
		path += ".md"
	}
	if entityType == "task" && !strings.HasSuffix(path, ".md") {
		path += ".md"
	}
	if filepath.IsAbs(path) || path == "." || strings.HasPrefix(path, "../") || path == ".." || !under(filepath.Join(r.storeRoot), filepath.Join(r.storeRoot, filepath.FromSlash(path))) {
		return ReconcileResult{}, fmt.Errorf("%w: restore path outside project root", ErrReconcileUnsafe)
	}
	wantRoot := entityType + "s" + string(filepath.Separator)
	if !strings.HasPrefix(filepath.FromSlash(path), filepath.FromSlash(wantRoot)) {
		return ReconcileResult{}, fmt.Errorf("%w: restore path outside %s root", ErrReconcileUnsafe, entityType)
	}
	if opts.BatchID == "" {
		opts.BatchID = lifecycleBatchID(r.storeRoot, "restore", []string{entityType + ":" + entityID + "\x00" + path})
	}
	abs := filepath.Join(r.storeRoot, filepath.FromSlash(path))
	// A restore head is only idempotent for the exact canonical path that was
	// already restored. The content hash intentionally excludes the path, so
	// ExpectedBaseHash alone cannot distinguish a competing restore to another
	// path. Re-scan ownership while the lifecycle-entity lock is held before
	// touching the requested path; this also covers a crash after the canonical
	// write/history append but before manifest activation.
	if last.Operation == LifecycleOperationRestore {
		if ok && entry.Path != path {
			return ReconcileResult{}, fmt.Errorf("%w: entity already restored at %s", ErrHistoryConflict, entry.Path)
		}
		paths, scanErr := r.canonicalIdentityPaths(ctx, entityType, entityID)
		if scanErr != nil {
			return ReconcileResult{}, scanErr
		}
		for _, existingPath := range paths {
			if existingPath != path {
				return ReconcileResult{}, fmt.Errorf("%w: entity already restored at %s", ErrHistoryConflict, existingPath)
			}
		}
	}
	if info, statErr := os.Lstat(abs); statErr == nil {
		// An interrupted restore may have durable history and canonical bytes
		// already present. A spurious tombstone reaches the same shape: the
		// head says deleted while the canonical file never left. Both are
		// identified by the content hash below, so read first and let the hash
		// decide rather than refusing every head that is not already a restore
		// — that refusal made a spurious tombstone unrepairable, because
		// reconciliation also reports the entity unchanged whenever the file
		// hash still matches the tombstone's.
		data, readErr := stableRead(abs)
		if readErr != nil {
			return ReconcileResult{}, readErr
		}
		_ = info
		var currentHash string
		if entityType == "task" {
			task, e := parseTaskContent(string(data))
			if e != nil {
				return ReconcileResult{}, e
			}
			currentHash = CanonicalTaskHash(task)
		} else {
			rel, _ := filepath.Rel(filepath.Join(r.storeRoot, "docs"), abs)
			doc, e := parseDocContent(string(data), strings.TrimSuffix(filepath.ToSlash(rel), ".md"), filepath.Dir(rel), false, "")
			if e != nil {
				return ReconcileResult{}, e
			}
			currentHash = CanonicalDocHash(doc)
		}
		if currentHash != last.NewHash {
			if last.Operation != LifecycleOperationRestore {
				// A different entity's bytes occupy the path. Reactivating
				// would adopt content this identity never owned.
				return ReconcileResult{}, fmt.Errorf("%w: restore path already exists", ErrReconcileUnsafe)
			}
			return ReconcileResult{}, fmt.Errorf("%w: interrupted restore hash mismatch", ErrHistoryConflict)
		}
		if last.Operation != LifecycleOperationRestore {
			// The head is a tombstone but the canonical file is present and
			// carries exactly the content the tombstone recorded, so the
			// deletion never happened on disk. Reactivating ownership alone
			// would leave history asserting the entity is deleted, which still
			// authorizes removal of its indexed vectors; append a durable
			// restore so the stream stops contradicting the filesystem.
			return r.reactivateTombstonedEntity(ctx, entityType, entityID, path, abs, currentHash, last, stream, opts)
		}
		result := ReconcileResult{EntityType: entityType, EntityID: entityID, Path: path, Hash: currentHash, Operation: LifecycleOperationRestore, BatchID: last.BatchID, CurrentPath: path, Changed: false, Revision: last.Revision, NewHash: currentHash}
		if r.index != nil {
			if err := r.queueLifecycleIntent(result); err != nil {
				return result, err
			}
		}
		next := manifestEntry{EntityType: entityType, EntityID: entityID, Path: path, Hash: currentHash, Revision: last.Revision, HeadHash: currentHash}
		if err := r.writeManifestMutations(map[string]manifestEntry{manifestKey(entityType, entityID): next}, nil); err != nil {
			return ReconcileResult{}, err
		}
		if r.index != nil {
			if pending := r.flushLifecycleIntents(); len(pending) > 0 && pending[0].Diagnostic != "" {
				return pending[0], errors.New(pending[0].Diagnostic)
			}
		}
		return result, nil
	} else if !os.IsNotExist(statErr) {
		return ReconcileResult{}, statErr
	}
	snapshot, err := r.replaySnapshot(entityType, entityID, stream.Records[:len(stream.Records)-1])
	if err != nil {
		snapshot = cloneMap(last.CheckpointPayload)
	}
	if snapshot == nil || len(snapshot) == 0 {
		return ReconcileResult{}, fmt.Errorf("%w: tombstone has no replayable state", ErrReconcileUnsafe)
	}
	var content []byte
	if entityType == "task" {
		var task models.Task
		if err := mapToStruct(snapshot, &task); err != nil {
			return ReconcileResult{}, err
		}
		task.ID = entityID
		content = []byte(renderTask(&task))
	} else {
		var doc models.Doc
		if err := mapToStruct(snapshot, &doc); err != nil {
			return ReconcileResult{}, err
		}
		doc.ID = entityID
		doc.Path = strings.TrimSuffix(filepath.ToSlash(strings.TrimPrefix(path, "docs/")), ".md")
		snapshot = cloneMap(snapshot)
		snapshot["id"], snapshot["path"] = doc.ID, doc.Path
		content = []byte(renderDoc(&doc))
	}
	var hash string
	operation := LifecycleOperationRestore
	restoreCanonical := func() error {
		if info, statErr := os.Lstat(abs); statErr == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%w: restore path is symlink", ErrReconcileUnsafe)
			}
			return fmt.Errorf("%w: restore path already exists", ErrReconcileUnsafe)
		} else if !os.IsNotExist(statErr) {
			return statErr
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return err
		}
		if err := atomicWrite(abs, content); err != nil {
			return err
		}
		data, err := stableRead(abs)
		if err != nil {
			_ = os.Remove(abs)
			return err
		}
		if entityType == "task" {
			task, e := parseTaskContent(string(data))
			if e != nil {
				_ = os.Remove(abs)
				return e
			}
			hash = CanonicalTaskHash(task)
		} else {
			rel, _ := filepath.Rel(filepath.Join(r.storeRoot, "docs"), abs)
			doc, e := parseDocContent(string(data), strings.TrimSuffix(filepath.ToSlash(rel), ".md"), filepath.Dir(rel), false, "")
			if e != nil {
				_ = os.Remove(abs)
				return e
			}
			hash = CanonicalDocHash(doc)
		}
		record := models.HistoryRecord{EntityType: entityType, EntityID: entityID, Source: "restore", Operation: operation, BatchID: opts.BatchID, Timestamp: time.Now().UTC(), BaseHash: last.NewHash, NewHash: hash, Checkpoint: true, CheckpointPayload: snapshot, PreviousPath: last.CurrentPath, CurrentPath: path}
		if err := r.appendHistoryRecord(ctx, record); err != nil {
			_ = os.Remove(abs)
			return err
		}
		return nil
	}
	if entityType == "doc" {
		publicPath := strings.TrimPrefix(filepath.ToSlash(path), "docs/")
		if err := NewStore(r.storeRoot).withDocMutationLocks(ctx, []string{publicPath}, restoreCanonical); err != nil {
			return ReconcileResult{}, err
		}
	} else if err := restoreCanonical(); err != nil {
		return ReconcileResult{}, err
	}
	result := ReconcileResult{EntityType: entityType, EntityID: entityID, Path: path, Hash: hash, Operation: operation, BatchID: opts.BatchID, PreviousPath: last.CurrentPath, CurrentPath: path, Changed: true, Revision: last.Revision + 1, BaseHash: last.NewHash, NewHash: hash}
	if r.index != nil {
		if err := r.queueLifecycleIntent(result); err != nil {
			return result, err
		}
	}
	next := manifestEntry{EntityType: entityType, EntityID: entityID, Path: path, Hash: hash, Revision: last.Revision + 1, HeadHash: hash}
	if err := r.writeManifestMutations(map[string]manifestEntry{manifestKey(entityType, entityID): next}, nil); err != nil {
		return ReconcileResult{}, err
	}
	if r.index != nil {
		if pending := r.flushLifecycleIntents(); len(pending) > 0 && pending[0].Diagnostic != "" {
			return pending[0], errors.New(pending[0].Diagnostic)
		}
	}
	return result, nil
}

func mapToStruct(input map[string]any, output any) error {
	data, err := json.Marshal(input)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, output)
}

func (r *FilesystemReconciler) canonicalIdentityPaths(ctx context.Context, entityType, entityID string) ([]string, error) {
	paths, err := r.canonicalFiles()
	if err != nil {
		return nil, err
	}
	matched := make([]string, 0, 1)
	for _, path := range paths {
		kind, id, _, resolveErr := r.resolveCanonicalHint(ctx, path)
		if resolveErr != nil {
			continue
		}
		if kind == entityType && id == entityID {
			matched = append(matched, r.relative(path))
		}
	}
	sort.Strings(matched)
	return matched, nil
}

// HardDelete is the reconciler-level Doc/Task purge boundary. It is not
// reachable from filesystem observations; adapters must set Trusted,
// Confirmed, and Reason and provide an exact path/hash proof.
func (r *FilesystemReconciler) HardDelete(ctx context.Context, entityType, entityID string, opts HardDeleteOptions) error {
	if ctx == nil {
		ctx = context.Background()
	}
	return r.withLifecycleEntityLock(ctx, entityType, entityID, func() error {
		return r.hardDeleteLocked(ctx, entityType, entityID, opts)
	})
}

func (r *FilesystemReconciler) hardDeleteLocked(ctx context.Context, entityType, entityID string, opts HardDeleteOptions) error {
	if !opts.Trusted || !opts.Confirmed || strings.TrimSpace(opts.Reason) == "" {
		return errors.New("hard delete requires trusted authorization, confirmation, and reason")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	manifest, err := r.readManifest()
	if err != nil {
		return err
	}
	key := manifestKey(entityType, entityID)
	entry, ok := manifest.Entries[key]
	reservation := r.purgeReservationPath(entityType, entityID)
	if _, markerErr := os.Stat(reservation); markerErr == nil {
		var marker map[string]any
		if err := readJSON(reservation, &marker); err != nil {
			return err
		}
		if markerKind, _ := marker["entityType"].(string); markerKind != "" && markerKind != entityType {
			return fmt.Errorf("%w: purge marker entity mismatch", ErrReconcileUnsafe)
		}
		if markerID, _ := marker["entityId"].(string); markerID != "" && markerID != entityID {
			return fmt.Errorf("%w: purge marker entity mismatch", ErrReconcileUnsafe)
		}
		markerPath, _ := marker["path"].(string)
		markerHash, _ := marker["hash"].(string)
		if entry.Path != "" && markerPath != "" && filepath.Clean(entry.Path) != filepath.Clean(markerPath) {
			return fmt.Errorf("%w: purge marker path mismatch", ErrReconcileUnsafe)
		}
		if markerPath == "" {
			markerPath = entry.Path
		}
		paths, scanErr := r.canonicalIdentityPaths(ctx, entityType, entityID)
		if scanErr != nil {
			return scanErr
		}
		for _, currentPath := range paths {
			if markerPath == "" || filepath.Clean(currentPath) != filepath.Clean(markerPath) {
				return fmt.Errorf("%w: stable identity moved while purge reservation was pending", ErrReconcileUnsafe)
			}
		}
		if markerPath != "" {
			abs := filepath.Join(r.storeRoot, filepath.FromSlash(markerPath))
			if !under(r.storeRoot, abs) || filepath.Ext(abs) != ".md" {
				return fmt.Errorf("%w: purge marker path outside canonical roots", ErrReconcileUnsafe)
			}
			removeMarkerCanonical := func() error {
				if info, statErr := os.Lstat(abs); statErr == nil {
					if info.Mode()&os.ModeSymlink != 0 {
						return fmt.Errorf("%w: purge marker canonical symlink", ErrReconcileUnsafe)
					}
					data, readErr := stableRead(abs)
					if readErr != nil {
						return readErr
					}
					kind, id, hash, parseErr := r.resolveCanonicalHint(ctx, abs)
					if parseErr != nil || kind != entityType || id != entityID {
						return fmt.Errorf("%w: purge marker identity mismatch", ErrReconcileUnsafe)
					}
					if markerHash != "" && markerHash != hash {
						return fmt.Errorf("%w: purge marker hash mismatch", ErrHistoryConflict)
					}
					_ = data
					if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
						return err
					}
					return r.setPurgePhase(entityType, entityID, "canonical_removed", marker)
				} else if !os.IsNotExist(statErr) {
					return statErr
				} else {
					paths, scanErr := r.canonicalIdentityPaths(ctx, entityType, entityID)
					if scanErr != nil {
						return scanErr
					}
					for _, currentPath := range paths {
						if filepath.Clean(currentPath) != filepath.Clean(markerPath) {
							return fmt.Errorf("%w: stable identity moved during purge retry", ErrReconcileUnsafe)
						}
					}
				}
				return nil
			}
			if entityType == "doc" {
				publicPath := strings.TrimPrefix(filepath.ToSlash(markerPath), "docs/")
				if err := NewStore(r.storeRoot).withDocMutationLocks(ctx, []string{publicPath}, removeMarkerCanonical); err != nil {
					return err
				}
			} else if err := removeMarkerCanonical(); err != nil {
				return err
			}
		}
		// Recheck after the locked canonical phase and before any history
		// cleanup. A marker retry must never purge a stream while the stable
		// identity has reappeared at another (or even the same) path.
		if remaining, scanErr := r.canonicalIdentityPaths(ctx, entityType, entityID); scanErr != nil {
			return scanErr
		} else if len(remaining) > 0 {
			return fmt.Errorf("%w: stable identity remains after purge canonical phase", ErrReconcileUnsafe)
		}
		// A crash can happen after the canonical phase marker was written but
		// before legacy/history cleanup. Re-run only exact, verified targets.
		for _, target := range r.history.PreviewLegacyCleanup(entityType, entityID).Targets {
			if target.Verified {
				if err := r.history.ConfirmLegacyCleanup(ctx, target, true); err != nil {
					return err
				}
			}
		}
		if err := r.setPurgePhase(entityType, entityID, "legacy_removed", marker); err != nil {
			return err
		}
		if r.index != nil {
			entry := manifest.Entries[key]
			if entry.Path == "" {
				if value, ok := marker["path"].(string); ok {
					entry.Path = value
				}
				if stream, readErr := r.history.Read(ctx, entityType, entityID); readErr == nil && len(stream.Records) > 0 {
					last := stream.Records[len(stream.Records)-1]
					entry.Path = firstNonEmpty(last.CurrentPath, last.PreviousPath)
				}
			}
			batchID := ""
			if value, ok := marker["batchId"].(string); ok {
				batchID = value
			}
			if batchID == "" {
				batchID = lifecycleBatchID(r.storeRoot, "hard-delete", []string{key + "\x00" + entry.Path})
			}
			intent := ReconcileResult{EntityType: entityType, EntityID: entityID, Path: entry.Path, Operation: LifecycleOperationHardDelete, PreviousPath: entry.Path, BatchID: batchID}
			if value, ok := marker["hash"].(string); ok {
				intent.Hash, intent.BaseHash, intent.NewHash = value, value, value
			}
			if err := r.queueLifecycleIntent(intent); err != nil {
				return err
			}
		}
		if err := r.history.Delete(ctx, entityType, entityID); err != nil {
			return err
		}
		if err := r.setPurgePhase(entityType, entityID, "history_removed", marker); err != nil {
			return err
		}
		if err := r.writeManifestMutations(nil, []string{key}); err != nil {
			return err
		}
		pending := r.flushLifecycleIntents()
		if len(pending) > 0 && pending[0].Diagnostic != "" {
			return errors.New(pending[0].Diagnostic)
		}
		return nil
	} else if !os.IsNotExist(markerErr) {
		return markerErr
	}
	stream, err := r.history.Read(ctx, entityType, entityID)
	if err != nil {
		return err
	}
	if len(stream.Records) == 0 {
		if !ok {
			return nil
		}
		return fmt.Errorf("%w: missing verified history", ErrReconcileUnsafe)
	}
	last := stream.Records[len(stream.Records)-1]
	if !ok {
		if !last.Tombstone {
			return fmt.Errorf("%w: manifest ownership missing", ErrReconcileUnsafe)
		}
		entry = manifestEntry{EntityType: entityType, EntityID: entityID, Path: firstNonEmpty(last.CurrentPath, last.PreviousPath)}
		ok = true
	}
	if opts.Path != "" && filepath.Clean(opts.Path) != filepath.Clean(entry.Path) {
		return fmt.Errorf("%w: hard-delete path proof mismatch", ErrReconcileUnsafe)
	}
	if opts.ExpectedHash != "" && opts.ExpectedHash != last.NewHash {
		return fmt.Errorf("%w: hard-delete hash proof mismatch", ErrHistoryConflict)
	}
	abs := filepath.Join(r.storeRoot, filepath.FromSlash(entry.Path))
	if !under(r.storeRoot, abs) || filepath.Ext(abs) != ".md" {
		return fmt.Errorf("%w: hard-delete path outside canonical roots", ErrReconcileUnsafe)
	}
	if info, statErr := os.Lstat(abs); statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: canonical path is symlink", ErrReconcileUnsafe)
		}
		data, readErr := stableRead(abs)
		if readErr != nil {
			return readErr
		}
		kind, id, _, parseErr := r.resolveCanonicalHint(ctx, abs)
		if parseErr != nil || kind != entityType || id != entityID {
			return fmt.Errorf("%w: exact canonical identity proof failed", ErrReconcileUnsafe)
		}
		_ = data
	} else if !os.IsNotExist(statErr) {
		return statErr
	} else {
		paths, scanErr := r.canonicalIdentityPaths(ctx, entityType, entityID)
		if scanErr != nil {
			return scanErr
		}
		if len(paths) > 0 {
			return fmt.Errorf("%w: stable identity moved from missing manifest path", ErrReconcileUnsafe)
		}
		if !last.Tombstone {
			return fmt.Errorf("%w: active manifest path is missing without tombstone", ErrReconcileUnsafe)
		}
	}
	// Reserve the authorized purge before every irreversible phase.
	if opts.Path == "" {
		opts.Path = entry.Path
	}
	if opts.ExpectedHash == "" {
		opts.ExpectedHash = last.NewHash
	}
	batchID := lifecycleBatchID(r.storeRoot, "hard-delete", []string{key + "\x00" + opts.Path})
	marker := map[string]any{"entityType": entityType, "entityId": entityID, "path": opts.Path, "hash": opts.ExpectedHash, "batchId": batchID, "actor": opts.Actor, "reason": opts.Reason, "purgedAt": time.Now().UTC()}
	removeCanonical := func() error {
		// Re-read under the same cross-process document mutation lock used by
		// public Doc writes. The earlier proof is only a cheap preflight.
		if info, statErr := os.Lstat(abs); statErr == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%w: canonical path is symlink", ErrReconcileUnsafe)
			}
			if _, readErr := stableRead(abs); readErr != nil {
				return readErr
			}
			kind, id, currentHash, parseErr := r.resolveCanonicalHint(ctx, abs)
			if parseErr != nil || kind != entityType || id != entityID {
				return fmt.Errorf("%w: exact canonical identity proof failed", ErrReconcileUnsafe)
			}
			if opts.ExpectedHash != "" && currentHash != opts.ExpectedHash {
				return fmt.Errorf("%w: canonical hash changed during purge", ErrHistoryConflict)
			}
		} else if !os.IsNotExist(statErr) {
			return statErr
		} else {
			paths, scanErr := r.canonicalIdentityPaths(ctx, entityType, entityID)
			if scanErr != nil {
				return scanErr
			}
			if len(paths) > 0 {
				return fmt.Errorf("%w: stable identity moved during purge", ErrReconcileUnsafe)
			}
			if !last.Tombstone {
				return fmt.Errorf("%w: active canonical disappeared during purge", ErrReconcileUnsafe)
			}
		}
		if err := r.writePurgeReservation(entityType, entityID, opts); err != nil {
			return err
		}
		if r.failureHooks.BeforeCanonicalRemove != nil {
			if err := r.failureHooks.BeforeCanonicalRemove(entityType, entityID, opts.Path); err != nil {
				return err
			}
		}
		if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
			return err
		}
		return r.setPurgePhase(entityType, entityID, "canonical_removed", marker)
	}
	if entityType == "doc" {
		publicPath := strings.TrimPrefix(filepath.ToSlash(entry.Path), "docs/")
		if err := NewStore(r.storeRoot).withDocMutationLocks(ctx, []string{publicPath}, removeCanonical); err != nil {
			return err
		}
	} else if err := removeCanonical(); err != nil {
		return err
	}
	if remaining, scanErr := r.canonicalIdentityPaths(ctx, entityType, entityID); scanErr != nil {
		return scanErr
	} else if len(remaining) > 0 {
		return fmt.Errorf("%w: stable identity remains after purge canonical phase", ErrReconcileUnsafe)
	}
	// Verify and remove only legacy successors whose immutable provenance binds
	// them to this exact JSONL stream. Unverified copies are intentionally left.
	for _, target := range r.history.PreviewLegacyCleanup(entityType, entityID).Targets {
		if target.Verified {
			if err := r.history.ConfirmLegacyCleanup(ctx, target, true); err != nil {
				return err
			}
		}
	}
	if err := r.setPurgePhase(entityType, entityID, "legacy_removed", marker); err != nil {
		return err
	}
	if err := r.history.Delete(ctx, entityType, entityID); err != nil {
		return err
	}
	if err := r.setPurgePhase(entityType, entityID, "history_removed", marker); err != nil {
		return err
	}
	if r.index != nil {
		result := ReconcileResult{EntityType: entityType, EntityID: entityID, Path: entry.Path, Operation: LifecycleOperationHardDelete, PreviousPath: entry.Path, BatchID: batchID, Hash: opts.ExpectedHash, BaseHash: opts.ExpectedHash, NewHash: opts.ExpectedHash}
		if err := r.queueLifecycleIntent(result); err != nil {
			return err
		}
		if err := r.writeManifestMutations(nil, []string{key}); err != nil {
			return err
		}
		pending := r.flushLifecycleIntents()
		if len(pending) > 0 && pending[0].Diagnostic != "" {
			return errors.New(pending[0].Diagnostic)
		}
		return nil
	}
	return r.writeManifestMutations(nil, []string{key})
}

func (r *FilesystemReconciler) purgeReservationPath(kind, id string) string {
	return filepath.Join(r.storeRoot, "history", "purged", safeHistoryID(kind+"-"+id)+".json")
}

func (r *FilesystemReconciler) writePurgeReservation(kind, id string, opts HardDeleteOptions) error {
	path := r.purgeReservationPath(kind, id)
	payload := map[string]any{"entityType": kind, "entityId": id, "path": opts.Path, "hash": opts.ExpectedHash, "phase": "authorized", "actor": opts.Actor, "reason": opts.Reason, "purgedAt": time.Now().UTC()}
	return durableWriteJSON(path, payload)
}

func (r *FilesystemReconciler) setPurgePhase(kind, id, phase string, marker map[string]any) error {
	if marker == nil {
		marker = map[string]any{}
	}
	marker["entityType"], marker["entityId"], marker["phase"] = kind, id, phase
	marker["updatedAt"] = time.Now().UTC()
	return durableWriteJSON(r.purgeReservationPath(kind, id), marker)
}

// durableWriteJSON is used for recovery markers and outbox state. An atomic
// rename alone does not make either the file bytes or its directory entry
// durable across a crash.
func durableWriteJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".lifecycle-durable-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	return syncDirectory(dir)
}

func (r *FilesystemReconciler) lifecycleIntentPath() string {
	return filepath.Join(r.storeRoot, "history", "state", "lifecycle-intents.json")
}

func (r *FilesystemReconciler) withLifecycleIntentLock(fn func() error) error {
	lockPath := filepath.Join(r.storeRoot, "history", "state", "lifecycle-intents.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := lockTaskLifecycleFile(context.Background(), file); err != nil {
		return err
	}
	defer unlockTaskLifecycleFile(file)
	return fn()
}

func lifecycleIntentKey(result ReconcileResult) string {
	return manifestKey(result.EntityType, result.EntityID) + "\x00" + result.Operation + "\x00" + result.Path
}

func (r *FilesystemReconciler) queueLifecycleIntent(result ReconcileResult) error {
	return r.withLifecycleIntentLock(func() error {
		intents := map[string]ReconcileResult{}
		if err := readJSON(r.lifecycleIntentPath(), &intents); err != nil && !os.IsNotExist(err) {
			return err
		}
		key := lifecycleIntentKey(result)
		if existing, ok := intents[key]; ok && existing.Revision > result.Revision {
			return nil
		}
		// One identity has one current lifecycle handoff. Remove superseded
		// rename/update/delete intents so a rename-back cannot replay stale
		// ownership or index work after restart.
		for existingKey, existing := range intents {
			if existingKey == key || existing.EntityType != result.EntityType || existing.EntityID != result.EntityID {
				continue
			}
			if existing.Revision <= result.Revision || result.Operation == LifecycleOperationHardDelete {
				delete(intents, existingKey)
			}
		}
		intents[key] = result
		return durableWriteJSON(r.lifecycleIntentPath(), intents)
	})
}

func (r *FilesystemReconciler) flushLifecycleIntents() []ReconcileResult {
	var results []ReconcileResult
	if err := r.withLifecycleIntentLock(func() error { results = r.flushLifecycleIntentsLocked(); return nil }); err != nil {
		return []ReconcileResult{{Diagnostic: err.Error()}}
	}
	return results
}

func (r *FilesystemReconciler) flushLifecycleIntentsLocked() []ReconcileResult {
	if r.index == nil {
		return nil
	}
	intents := map[string]ReconcileResult{}
	if err := readJSON(r.lifecycleIntentPath(), &intents); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return []ReconcileResult{{Diagnostic: err.Error()}}
	}
	results := make([]ReconcileResult, 0)
	keys := make([]string, 0, len(intents))
	for key := range intents {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		result := intents[key]
		manifest, manifestErr := r.readManifest()
		if manifestErr != nil {
			result.Diagnostic = manifestErr.Error()
			results = append(results, result)
			continue
		}
		if result.Operation != LifecycleOperationDelete && result.Operation != LifecycleOperationHardDelete {
			entry, ok := manifest.Entries[manifestKey(result.EntityType, result.EntityID)]
			if !ok || filepath.Clean(entry.Path) != filepath.Clean(result.Path) {
				// A newer durable history head supersedes this intent (for
				// example rename A->B followed by B->C). Keep an intent only
				// when its exact revision is still recoverable after a crash.
				stream, historyErr := r.history.Read(context.Background(), result.EntityType, result.EntityID)
				if historyErr != nil || len(stream.Records) == 0 || stream.Records[len(stream.Records)-1].Revision > result.Revision {
					delete(intents, key)
				}
				continue
			}
		} else if _, ok := manifest.Entries[manifestKey(result.EntityType, result.EntityID)]; ok {
			// A delete intent is expected to see the old manifest while a
			// crash-retry is in flight. If a later restore/recreate head is
			// durable, this intent is conclusively superseded and must not
			// survive forever.
			stream, historyErr := r.history.Read(context.Background(), result.EntityType, result.EntityID)
			if historyErr != nil || len(stream.Records) == 0 || stream.Records[len(stream.Records)-1].Revision > result.Revision || stream.Records[len(stream.Records)-1].Operation == LifecycleOperationRestore {
				delete(intents, key)
			}
			continue
		}
		if err := r.index(result); err != nil {
			result.Diagnostic = fmt.Sprintf("lifecycle handoff failed after durable ownership: %v", err)
			results = append(results, result)
			continue
		}
		delete(intents, key)
	}
	if err := durableWriteJSON(r.lifecycleIntentPath(), intents); err != nil {
		results = append(results, ReconcileResult{Diagnostic: err.Error()})
	}
	return results
}

func (r *FilesystemReconciler) writeManifestMutations(upserts map[string]manifestEntry, deletes []string) error {
	lockPath := filepath.Join(filepath.Dir(r.manifestPath()), "manifest.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return err
	}
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := lockTaskLifecycleFile(context.Background(), lock); err != nil {
		return err
	}
	defer unlockTaskLifecycleFile(lock)
	m, err := r.readManifest()
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if m.Entries == nil {
		m.Entries = map[string]manifestEntry{}
	}
	for key, entry := range upserts {
		m.Entries[key] = entry
	}
	for _, key := range deletes {
		delete(m.Entries, key)
	}
	m.SchemaVersion = 1
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Dir(r.manifestPath())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".manifest-lifecycle-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, r.manifestPath()); err != nil {
		return err
	}
	return syncDirectory(dir)
}

// reactivateTombstonedEntity repairs an entity whose durable history head is a
// tombstone while its canonical file is still present with exactly the content
// that tombstone recorded — the shape a spurious deletion leaves behind, for
// example a watcher startup pass that observed the file as missing while it was
// briefly absent. Ordinary reconciliation cannot repair this: it compares the
// file hash against the head's and reports the entity unchanged, so the
// contradiction between history and filesystem persists forever.
//
// The canonical bytes are already correct, so no file is written. Only a
// durable restore record and the reactivated manifest ownership are needed.
func (r *FilesystemReconciler) reactivateTombstonedEntity(ctx context.Context, entityType, entityID, path, abs, currentHash string, last models.HistoryRecord, stream models.HistoryReadResult, opts RestoreOptions) (ReconcileResult, error) {
	if info, statErr := os.Lstat(abs); statErr != nil {
		return ReconcileResult{}, statErr
	} else if info.Mode()&os.ModeSymlink != 0 {
		return ReconcileResult{}, fmt.Errorf("%w: restore path is symlink", ErrReconcileUnsafe)
	}
	snapshot, err := r.replaySnapshot(entityType, entityID, stream.Records[:len(stream.Records)-1])
	if err != nil || len(snapshot) == 0 {
		snapshot = cloneMap(last.CheckpointPayload)
	}
	if len(snapshot) == 0 {
		return ReconcileResult{}, fmt.Errorf("%w: tombstone has no replayable state", ErrReconcileUnsafe)
	}
	record := models.HistoryRecord{EntityType: entityType, EntityID: entityID, Source: "restore", Operation: LifecycleOperationRestore, BatchID: opts.BatchID, Timestamp: time.Now().UTC(), BaseHash: last.NewHash, NewHash: currentHash, Checkpoint: true, CheckpointPayload: snapshot, PreviousPath: last.CurrentPath, CurrentPath: path}
	appendRecord := func() error { return r.appendHistoryRecord(ctx, record) }
	if entityType == "doc" {
		publicPath := strings.TrimPrefix(filepath.ToSlash(path), "docs/")
		if err := NewStore(r.storeRoot).withDocMutationLocks(ctx, []string{publicPath}, appendRecord); err != nil {
			return ReconcileResult{}, err
		}
	} else if err := appendRecord(); err != nil {
		return ReconcileResult{}, err
	}
	result := ReconcileResult{EntityType: entityType, EntityID: entityID, Path: path, Hash: currentHash, Operation: LifecycleOperationRestore, BatchID: opts.BatchID, PreviousPath: last.CurrentPath, CurrentPath: path, Changed: true, Revision: last.Revision + 1, BaseHash: last.NewHash, NewHash: currentHash}
	if r.index != nil {
		if err := r.queueLifecycleIntent(result); err != nil {
			return result, err
		}
	}
	next := manifestEntry{EntityType: entityType, EntityID: entityID, Path: path, Hash: currentHash, Revision: last.Revision + 1, HeadHash: currentHash}
	if err := r.writeManifestMutations(map[string]manifestEntry{manifestKey(entityType, entityID): next}, nil); err != nil {
		return ReconcileResult{}, err
	}
	if r.index != nil {
		if pending := r.flushLifecycleIntents(); len(pending) > 0 && pending[0].Diagnostic != "" {
			return pending[0], errors.New(pending[0].Diagnostic)
		}
	}
	return result, nil
}
