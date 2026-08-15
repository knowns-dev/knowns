package storage

// Filesystem reconciliation deliberately lives below the watcher. Filesystem
// events are hints only; this package rereads and validates canonical files,
// then serializes history and manifest effects through the existing stores.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

const (
	ReconcileQuietWindow  = 3 * time.Second
	ReconcileFlushCeiling = 30 * time.Second
)

var ErrReconcileUnsafe = errors.New("filesystem reconciliation refused unsafe canonical input")

// ReconcileHint is the small, content-free boundary passed from watchers.
type ReconcileHint struct {
	Path         string
	PreviousPath string
	Event        string
	At           time.Time
	EntityType   string
	EntityID     string
	Hash         string
}

// ResolveHints is the single resolver stage between filesystem events and
// serialized reconciliation. It performs stable reads/parsing once, then
// groups equivalent identity/hash hints without exposing content.
func (r *FilesystemReconciler) ResolveHints(ctx context.Context, hints []ReconcileHint) ([]ReconcileHint, []ReconcileResult) {
	if ctx == nil {
		ctx = context.Background()
	}
	groups := make(map[string]ReconcileHint)
	diagnostics := make([]ReconcileResult, 0)
	pathsByIdentity := make(map[string][]string)
	for _, hint := range hints {
		path, err := r.validateCanonicalPath(hint.Path)
		if err != nil {
			if (hint.Event == "remove" || hint.Event == "rename") && os.IsNotExist(err) {
				continue
			}
			diagnostics = append(diagnostics, ReconcileResult{Path: hint.Path, Diagnostic: err.Error()})
			continue
		}
		kind, id, hash, err := r.resolveCanonicalHint(ctx, path)
		if err != nil {
			if (hint.Event == "remove" || hint.Event == "rename") && os.IsNotExist(err) {
				continue
			}
			diagnostics = append(diagnostics, ReconcileResult{Path: path, Diagnostic: err.Error()})
			continue
		}
		identity := kind + ":" + id
		knownPaths := pathsByIdentity[identity]
		alreadyPath := false
		for _, knownPath := range knownPaths {
			if knownPath == path {
				alreadyPath = true
				break
			}
		}
		if !alreadyPath {
			pathsByIdentity[identity] = append(knownPaths, path)
		}
		key := identity + "\x00" + hash
		groups[key] = ReconcileHint{Path: path, PreviousPath: hint.PreviousPath, Event: hint.Event, At: hint.At, EntityType: kind, EntityID: id, Hash: hash}
	}
	// Multiple final paths for one stable identity are ambiguous; do not hand
	// either path to the mutating reconciler (rename/delete belongs to Task06).
	for identity, paths := range pathsByIdentity {
		if len(paths) < 2 {
			continue
		}
		for _, path := range paths {
			diagnostics = append(diagnostics, ReconcileResult{Path: path, Diagnostic: fmt.Sprintf("%v: ambiguous identity %s", ErrReconcileUnsafe, identity)})
		}
		for key := range groups {
			if strings.HasPrefix(key, identity+"\x00") {
				delete(groups, key)
			}
		}
	}
	resolved := make([]ReconcileHint, 0, len(groups))
	for _, hint := range groups {
		resolved = append(resolved, hint)
	}
	sort.Slice(resolved, func(i, j int) bool {
		if resolved[i].EntityType != resolved[j].EntityType {
			return resolved[i].EntityType < resolved[j].EntityType
		}
		if resolved[i].EntityID != resolved[j].EntityID {
			return resolved[i].EntityID < resolved[j].EntityID
		}
		return resolved[i].Hash < resolved[j].Hash
	})
	return resolved, diagnostics
}

// ReconcileResult is safe for logs and CLI output: it contains no entity text.
type ReconcileResult struct {
	EntityType   string
	EntityID     string
	Path         string
	Hash         string
	Changed      bool
	Revision     int
	Diagnostic   string
	Operation    string
	BatchID      string
	PreviousPath string
	CurrentPath  string
	BaseHash     string
	NewHash      string
	Pending      bool
	RetryAt      time.Time
}

type manifestEntry struct {
	EntityType string `json:"entityType"`
	EntityID   string `json:"entityId"`
	Path       string `json:"path"`
	Hash       string `json:"hash"`
	Revision   int    `json:"revision,omitempty"`
	HeadHash   string `json:"headHash,omitempty"`
}

type reconcileManifest struct {
	SchemaVersion int                      `json:"schemaVersion"`
	Entries       map[string]manifestEntry `json:"entries"`
}

// FilesystemReconciler owns all mutating work after watcher hints are queued.
type FilesystemReconciler struct {
	storeRoot string // .knowns, never the user project root
	history   *HistoryStore
	mu        sync.Mutex
	index     func(ReconcileResult) error
	// allowArchive is private and enabled only by the authorized Task purge
	// coordinator. Generic watcher/startup reconciliation must retain the
	// Task05 tasks+docs scope and never observe .knowns/archive.
	allowArchive bool
	// lifecycle metadata is set only while the serialized lifecycle resolver
	// invokes the baseline content reconciler.
	activeBatchID      string
	activeSource       string
	activeOperation    string
	activePreviousPath string
	activeCurrentPath  string
	// lifecycleNow and absenceGrace make watcher quiet-window proofs
	// deterministic in tests while retaining the three-second production
	// contract. missingSince is persisted under the project-local state dir.
	lifecycleNow func() time.Time
	absenceGrace time.Duration
	missingSince map[string]time.Time
	failureHooks LifecycleFailureHooks
}

// LifecycleFailureHooks is a test-only fault-injection seam for proving
// recovery ordering. Hooks never come from filesystem or public requests.
type LifecycleFailureHooks struct {
	BeforeCanonicalRemove func(entityType, entityID, path string) error
}

func (r *FilesystemReconciler) SetLifecycleFailureHooks(hooks LifecycleFailureHooks) {
	r.failureHooks = hooks
}

func NewFilesystemReconciler(storeRoot string, indexIntent ...func(ReconcileResult) error) (*FilesystemReconciler, error) {
	return newFilesystemReconciler(storeRoot, false, indexIntent...)
}

func newFilesystemReconciler(storeRoot string, allowArchive bool, indexIntent ...func(ReconcileResult) error) (*FilesystemReconciler, error) {
	root, err := filepath.Abs(storeRoot)
	if err != nil {
		return nil, fmt.Errorf("reconcile root: %w", err)
	}
	if info, statErr := os.Lstat(root); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: store root is a symlink", ErrReconcileUnsafe)
	}
	if len(indexIntent) > 0 {
		return &FilesystemReconciler{storeRoot: root, history: NewHistoryStore(root), index: indexIntent[0], allowArchive: allowArchive, lifecycleNow: time.Now, absenceGrace: ReconcileQuietWindow}, nil
	}
	return &FilesystemReconciler{storeRoot: root, history: NewHistoryStore(root), allowArchive: allowArchive, lifecycleNow: time.Now, absenceGrace: ReconcileQuietWindow}, nil
}

func (r *FilesystemReconciler) manifestPath() string {
	return filepath.Join(r.storeRoot, "history", "state", "manifest.json")
}

// Reconcile performs a startup/explicit pass. Without Execute it is entirely
// read-only, including no manifest creation.
func (r *FilesystemReconciler) Reconcile(ctx context.Context, execute bool) ([]ReconcileResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	paths, err := r.canonicalFiles()
	if err != nil {
		return nil, err
	}
	manifest, err := r.readManifest()
	if err != nil {
		return nil, err
	}
	results := make([]ReconcileResult, 0, len(paths))
	dirty := make(map[string]manifestEntry)
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return results, err
		}
		kind, id, _, identityErr := r.resolveCanonicalHint(ctx, path)
		if identityErr != nil {
			results = append(results, ReconcileResult{Path: path, Diagnostic: identityErr.Error()})
			continue
		}
		if diagnostic := manifestPathConflict(manifest, kind, id, r.relative(path)); diagnostic != "" {
			results = append(results, ReconcileResult{EntityType: kind, EntityID: id, Path: r.relative(path), Diagnostic: diagnostic})
			continue
		}
		result, entry, err := r.reconcileFile(ctx, path, execute)
		if err != nil {
			// A malformed or ambiguous file is an actionable, content-free result;
			// other files may still be safely reconciled in the same pass.
			results = append(results, ReconcileResult{Path: path, Diagnostic: err.Error()})
			continue
		}
		results = append(results, result)
		if execute {
			if result.Diagnostic == "" && !result.Changed {
				previous := manifest.Entries[manifestKey(entry.EntityType, entry.EntityID)]
				if previous.Hash != entry.Hash || previous.HeadHash != entry.HeadHash || previous.Revision != entry.Revision {
					if r.index != nil {
						if err := r.index(result); err != nil {
							results[len(results)-1].Diagnostic = fmt.Sprintf("indexing handoff failed: %v", err)
							continue
						}
					}
				}
			}
			manifest.Entries[manifestKey(entry.EntityType, entry.EntityID)] = entry
			dirty[manifestKey(entry.EntityType, entry.EntityID)] = entry
		}
	}
	if execute {
		hasSuccess := false
		for _, result := range results {
			if result.Diagnostic == "" {
				hasSuccess = true
				break
			}
		}
		if hasSuccess {
			if err := r.writeManifestEntries(dirty); err != nil {
				return results, err
			}
		}
	}
	sort.Slice(results, func(i, j int) bool { return results[i].Path < results[j].Path })
	return results, nil
}

func (r *FilesystemReconciler) ReconcileHints(ctx context.Context, hints []ReconcileHint, execute bool) ([]ReconcileResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	resolvedHints, diagnostics := r.ResolveHints(ctx, hints)
	results := append([]ReconcileResult(nil), diagnostics...)
	hints = resolvedHints
	seen := make(map[string]struct{}, len(hints))
	paths := make([]string, 0, len(hints))
	for _, hint := range hints {
		path, err := r.validateCanonicalPath(hint.Path)
		if err != nil {
			paths = append(paths, hint.Path)
			continue
		}
		if _, ok := seen[path]; !ok {
			seen[path] = struct{}{}
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	manifest, err := r.readManifest()
	if err != nil {
		return nil, err
	}
	dirty := make(map[string]manifestEntry)
	for _, path := range paths {
		if _, err := os.Lstat(path); err != nil {
			results = append(results, ReconcileResult{Path: path, Diagnostic: fmt.Sprintf("filesystem hint unresolved: %v", err)})
			continue
		}
		kind, id, _, identityErr := r.resolveCanonicalHint(ctx, path)
		if identityErr != nil {
			results = append(results, ReconcileResult{Path: path, Diagnostic: identityErr.Error()})
			continue
		}
		if diagnostic := manifestPathConflict(manifest, kind, id, r.relative(path)); diagnostic != "" {
			results = append(results, ReconcileResult{EntityType: kind, EntityID: id, Path: r.relative(path), Diagnostic: diagnostic})
			continue
		}
		result, entry, err := r.reconcileFile(ctx, path, execute)
		if err != nil {
			results = append(results, ReconcileResult{Path: path, Diagnostic: err.Error()})
			continue
		}
		results = append(results, result)
		if execute {
			if result.Diagnostic == "" && !result.Changed {
				previous := manifest.Entries[manifestKey(entry.EntityType, entry.EntityID)]
				if previous.Hash != entry.Hash || previous.HeadHash != entry.HeadHash || previous.Revision != entry.Revision {
					if r.index != nil {
						if err := r.index(result); err != nil {
							results[len(results)-1].Diagnostic = fmt.Sprintf("indexing handoff failed: %v", err)
							continue
						}
					}
				}
			}
			manifest.Entries[manifestKey(entry.EntityType, entry.EntityID)] = entry
			dirty[manifestKey(entry.EntityType, entry.EntityID)] = entry
		}
	}
	if execute {
		hasSuccess := false
		for _, result := range results {
			if result.Diagnostic == "" {
				hasSuccess = true
				break
			}
		}
		if hasSuccess {
			if err := r.writeManifestEntries(dirty); err != nil {
				return results, err
			}
		}
	}
	return results, nil
}

func (r *FilesystemReconciler) reconcileFile(ctx context.Context, path string, execute bool) (ReconcileResult, manifestEntry, error) {
	data, err := stableRead(path)
	if err != nil {
		return ReconcileResult{}, manifestEntry{}, fmt.Errorf("%w: %s: %v", ErrReconcileUnsafe, filepath.Base(path), err)
	}
	entityType := "doc"
	if under(filepath.Join(r.storeRoot, "tasks"), path) || (r.allowArchive && under(filepath.Join(r.storeRoot, "archive"), path)) {
		entityType = "task"
	}
	var entityID, hash string
	var snapshot map[string]any
	var taskEntity *models.Task
	var docEntity *models.Doc
	if entityType == "task" {
		task, parseErr := parseTaskContent(string(data))
		if parseErr != nil || strings.TrimSpace(task.ID) == "" {
			if parseErr == nil {
				parseErr = errors.New("missing stable Task id")
			}
			return ReconcileResult{}, manifestEntry{}, fmt.Errorf("%w: %s: %v", ErrReconcileUnsafe, filepath.Base(path), parseErr)
		}
		task.Archived = under(filepath.Join(r.storeRoot, "archive"), path)
		entityID, hash, snapshot = task.ID, CanonicalTaskHash(task), TaskToSnapshot(task)
		taskEntity = task
	} else {
		rel, _ := filepath.Rel(filepath.Join(r.storeRoot, "docs"), path)
		doc, parseErr := parseDocContent(string(data), strings.TrimSuffix(filepath.ToSlash(rel), ".md"), filepath.Dir(rel), false, "")
		if parseErr != nil || strings.TrimSpace(doc.ID) == "" {
			if parseErr == nil {
				parseErr = errors.New("missing stable Doc id")
			}
			return ReconcileResult{}, manifestEntry{}, fmt.Errorf("%w: %s: %v", ErrReconcileUnsafe, filepath.Base(path), parseErr)
		}
		entityID, hash, snapshot = doc.ID, CanonicalDocHash(doc), DocToSnapshot(doc)
		docEntity = doc
	}
	if err := r.uniqueIdentity(entityType, entityID, path); err != nil {
		return ReconcileResult{}, manifestEntry{}, err
	}
	var stream models.HistoryReadResult
	if execute {
		stream, err = r.history.Read(ctx, entityType, entityID)
	} else {
		stream, err = r.history.ReadPreview(entityType, entityID)
	}
	if err != nil {
		return ReconcileResult{}, manifestEntry{}, fmt.Errorf("read %s history: %w", entityType, err)
	}
	entry := manifestEntry{EntityType: entityType, EntityID: entityID, Path: r.relative(path), Hash: hash}
	result := ReconcileResult{EntityType: entityType, EntityID: entityID, Path: r.relative(path), Hash: hash}
	if len(stream.Records) > 0 {
		last := stream.Records[len(stream.Records)-1]
		entry.Revision, entry.HeadHash = last.Revision, last.NewHash
		if last.NewHash == hash {
			return result, entry, nil
		}
		if !execute {
			result.Changed = true
			result.Revision = last.Revision + 1
			return result, entry, nil
		}
		record := r.filesystemRecord(entityType, entityID, last.NewHash, hash, snapshot, stream.Records)
		if r.activeBatchID != "" {
			record.BatchID = r.activeBatchID
		}
		if r.activeSource != "" {
			record.Source = r.activeSource
		}
		if r.activeOperation != "" {
			record.Operation = r.activeOperation
		}
		if r.activeCurrentPath != "" {
			record.CurrentPath = r.activeCurrentPath
		}
		if r.activePreviousPath != "" {
			record.PreviousPath = r.activePreviousPath
		}
		if err := r.history.Append(ctx, record); err != nil {
			return result, entry, err
		}
		entry.Revision, entry.HeadHash = last.Revision+1, hash
		result.Changed, result.Revision = true, entry.Revision
	} else {
		// Legacy-only streams must migrate through VersionStore. A raw JSONL
		// append here would manufacture revision 1 and orphan logical history.
		if execute {
			if migrated, migrateErr := r.appendLegacyAware(ctx, entityType, entityID, hash, snapshot, taskEntity, docEntity); migrated || migrateErr != nil {
				if migrateErr != nil {
					return result, entry, migrateErr
				}
				if migratedStream, streamErr := r.history.Read(ctx, entityType, entityID); streamErr == nil && len(migratedStream.Records) > 0 {
					last := migratedStream.Records[len(migratedStream.Records)-1]
					entry.Revision, entry.HeadHash = last.Revision, last.NewHash
					result.Revision, result.Changed = last.Revision, last.Source == "filesystem"
					if result.Changed && r.index != nil {
						if handoffErr := r.index(result); handoffErr != nil {
							return result, entry, handoffErr
						}
					}
					return result, entry, nil
				}
				if legacyHead, headErr := r.legacyHead(entityType, entityID, hash, docEntity); headErr == nil && legacyHead.Revision > 0 {
					entry.Revision, entry.HeadHash = legacyHead.Revision, legacyHead.NewHash
					result.Revision = entry.Revision
					return result, entry, nil
				}
				entry.Revision = 0
				if history, readErr := r.history.Read(ctx, entityType, entityID); readErr == nil && len(history.Records) > 0 {
					last := history.Records[len(history.Records)-1]
					entry.Revision, entry.HeadHash = last.Revision, last.NewHash
					result.Changed, result.Revision = true, last.Revision
				}
				if result.Changed && r.index != nil {
					if handoffErr := r.index(result); handoffErr != nil {
						return result, entry, handoffErr
					}
				}
				return result, entry, nil
			}
		}
		if !execute {
			legacy, legacyErr := r.legacyHead(entityType, entityID, hash, docEntity)
			if legacyErr == nil && legacy.Revision > 0 {
				entry.Revision, entry.HeadHash = legacy.Revision, legacy.NewHash
				result.Revision = legacy.Revision
				if legacy.NewHash != hash {
					result.Changed, result.Revision = true, legacy.Revision+1
				}
				return result, entry, nil
			}
			result.Changed, result.Revision = true, 1
			return result, entry, nil
		}
		record := r.filesystemRecord(entityType, entityID, "", hash, snapshot, nil)
		if r.activeBatchID != "" {
			record.BatchID = r.activeBatchID
		}
		if r.activeSource != "" {
			record.Source = r.activeSource
		}
		if r.activeOperation != "" {
			record.Operation = r.activeOperation
		}
		if r.activeCurrentPath != "" {
			record.CurrentPath = r.activeCurrentPath
		}
		if r.activePreviousPath != "" {
			record.PreviousPath = r.activePreviousPath
		}
		if err := r.history.Append(ctx, record); err != nil {
			return result, entry, err
		}
		entry.Revision, entry.HeadHash = 1, hash
		result.Changed, result.Revision = true, 1
	}
	if result.Changed && r.index != nil {
		if err := r.index(result); err != nil {
			return result, entry, fmt.Errorf("filesystem revision durable but indexing handoff failed: %w", err)
		}
	}
	return result, entry, nil
}

func (r *FilesystemReconciler) resolveCanonicalHint(ctx context.Context, path string) (string, string, string, error) {
	data, err := stableRead(path)
	if err != nil {
		return "", "", "", fmt.Errorf("%w: %s: %v", ErrReconcileUnsafe, filepath.Base(path), err)
	}
	kind := "doc"
	if under(filepath.Join(r.storeRoot, "tasks"), path) || (r.allowArchive && under(filepath.Join(r.storeRoot, "archive"), path)) {
		kind = "task"
	}
	if kind == "task" {
		entity, parseErr := parseTaskContent(string(data))
		if parseErr != nil || strings.TrimSpace(entity.ID) == "" {
			if parseErr == nil {
				parseErr = errors.New("missing stable Task id")
			}
			return "", "", "", fmt.Errorf("%w: %s: %v", ErrReconcileUnsafe, filepath.Base(path), parseErr)
		}
		entity.Archived = under(filepath.Join(r.storeRoot, "archive"), path)
		if err := r.uniqueIdentity(kind, entity.ID, path); err != nil {
			return "", "", "", err
		}
		return kind, entity.ID, CanonicalTaskHash(entity), nil
	}
	rel, _ := filepath.Rel(filepath.Join(r.storeRoot, "docs"), path)
	entity, parseErr := parseDocContent(string(data), strings.TrimSuffix(filepath.ToSlash(rel), ".md"), filepath.Dir(rel), false, "")
	if parseErr != nil || strings.TrimSpace(entity.ID) == "" {
		if parseErr == nil {
			parseErr = errors.New("missing stable Doc id")
		}
		return "", "", "", fmt.Errorf("%w: %s: %v", ErrReconcileUnsafe, filepath.Base(path), parseErr)
	}
	if err := r.uniqueIdentity(kind, entity.ID, path); err != nil {
		return "", "", "", err
	}
	return kind, entity.ID, CanonicalDocHash(entity), nil
}

func (r *FilesystemReconciler) legacyHead(kind, id, canonicalHash string, doc *models.Doc) (models.HistoryRecord, error) {
	vs := NewStore(r.storeRoot).Versions
	if kind == "task" {
		h, err := r.readTaskHistoryPreview(vs, id)
		if err != nil || len(h.Versions) == 0 {
			return models.HistoryRecord{}, err
		}
		v := h.Versions[len(h.Versions)-1]
		return models.HistoryRecord{Revision: v.Version, NewHash: firstNonEmpty(v.NewHash, taskCanonicalHash(v.Snapshot), canonicalHash)}, nil
	}
	if doc == nil {
		return models.HistoryRecord{}, errors.New("legacy Doc is unavailable")
	}
	h, err := r.readDocHistoryPreview(vs, doc.Path)
	if err != nil || len(h.Versions) == 0 {
		return models.HistoryRecord{}, err
	}
	v := h.Versions[len(h.Versions)-1]
	return models.HistoryRecord{Revision: v.Version, NewHash: firstNonEmpty(v.NewHash, hashSnapshot(v.Snapshot), canonicalHash)}, nil
}

func (r *FilesystemReconciler) readTaskHistoryPreview(vs *VersionStore, id string) (*models.TaskVersionHistory, error) {
	jsonlPath := r.history.EntityPath("task", id)
	if _, err := os.Stat(jsonlPath); err == nil {
		stream, readErr := r.history.ReadPreview("task", id)
		if readErr != nil {
			return nil, readErr
		}
		return taskHistoryFromRecords(id, stream.Records)
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	data, err := os.ReadFile(vs.versionPath(id))
	if os.IsNotExist(err) {
		return &models.TaskVersionHistory{TaskID: id, Versions: []models.TaskVersion{}}, nil
	}
	if err != nil {
		return nil, err
	}
	var history models.TaskVersionHistory
	if err := json.Unmarshal(data, &history); err != nil {
		return nil, err
	}
	if history.Versions == nil {
		history.Versions = []models.TaskVersion{}
	}
	return &history, nil
}

func (r *FilesystemReconciler) readDocHistoryPreview(vs *VersionStore, path string) (*models.DocVersionHistory, error) {
	path = normalizeDocPath(path)
	if history, ok, err := vs.loadStableDocHistoryForPath(path); ok || err != nil {
		return history, err
	}
	if history, ok, err := vs.loadLegacyDocHistory(path); ok || err != nil {
		return history, err
	}
	return &models.DocVersionHistory{DocPath: path, CurrentPath: path, Versions: []models.DocVersion{}}, nil
}

func (r *FilesystemReconciler) appendLegacyAware(ctx context.Context, kind, id, hash string, snapshot map[string]any, task *models.Task, doc *models.Doc) (bool, error) {
	vs := NewStore(r.storeRoot).Versions
	if kind == "task" {
		history, err := vs.GetHistory(id)
		if err != nil {
			return false, nil
		}
		if len(history.Versions) == 0 {
			return false, nil
		}
		old := history.Versions[len(history.Versions)-1]
		if old.NewHash == hash || task == nil {
			return true, nil
		}
		changes := snapshotChanges(old.Snapshot, snapshot)
		taskChanges := make([]models.TaskChange, 0, len(changes))
		for field, values := range changes {
			taskChanges = append(taskChanges, models.TaskChange{Field: field, OldValue: values[0], NewValue: values[1]})
		}
		return true, vs.SaveVersion(id, models.TaskVersion{Snapshot: snapshot, Changes: taskChanges, Source: "filesystem", Checkpoint: false, Timestamp: time.Now().UTC()})
	}
	if doc == nil {
		return false, nil
	}
	history, err := vs.GetDocHistory(doc.Path)
	if err != nil || len(history.Versions) == 0 {
		return false, nil
	}
	old, err := vs.ResolveDocState(doc.Path, "")
	if err != nil {
		return true, err
	}
	if CanonicalDocHash(old) == hash {
		return true, nil
	}
	return true, vs.SaveDocRevisionWithOptions(old, doc, DocRevisionOptions{Source: "filesystem"})
}

func (r *FilesystemReconciler) filesystemRecord(kind, id, baseHash, newHash string, snapshot map[string]any, records []models.HistoryRecord) models.HistoryRecord {
	record := models.HistoryRecord{EntityType: kind, EntityID: id, Source: "filesystem", Timestamp: time.Now().UTC(), BaseHash: baseHash, NewHash: newHash, Checkpoint: true, CheckpointPayload: snapshot}
	if len(records) == 0 {
		return record
	}
	if kind == "task" {
		if history, err := taskHistoryFromRecords(id, records); err == nil && len(history.Versions) > 0 {
			oldSnapshot := cloneMap(history.Versions[len(history.Versions)-1].Snapshot)
			newSnapshot := cloneMap(snapshot)
			delete(oldSnapshot, "createdAt")
			delete(oldSnapshot, "updatedAt")
			delete(newSnapshot, "createdAt")
			delete(newSnapshot, "updatedAt")
			changes := snapshotChanges(oldSnapshot, newSnapshot)
			if len(changes) > 0 && !historyDeltaInefficient(changes, snapshot) {
				record.Checkpoint, record.CheckpointPayload = false, nil
				record.TaskChanges = make([]models.TaskChange, 0, len(changes))
				for field, values := range changes {
					record.TaskChanges = append(record.TaskChanges, models.TaskChange{Field: field, OldValue: values[0], NewValue: values[1]})
				}
				sort.Slice(record.TaskChanges, func(i, j int) bool { return record.TaskChanges[i].Field < record.TaskChanges[j].Field })
			}
		}
	} else if history, err := docHistoryFromRecords(firstNonEmpty(records[0].CurrentPath, ""), records); err == nil && len(history.Versions) > 0 {
		old := history.Versions[len(history.Versions)-1].Snapshot
		changes := snapshotChanges(old, snapshot)
		if len(changes) > 0 && !historyDeltaInefficient(changes, snapshot) {
			record.Checkpoint, record.CheckpointPayload = false, nil
			for field, values := range changes {
				record.DocChanges = append(record.DocChanges, models.DocChange{Field: field, OldValue: values[0], NewValue: values[1]})
			}
			sort.Slice(record.DocChanges, func(i, j int) bool { return record.DocChanges[i].Field < record.DocChanges[j].Field })
		}
	}
	return record
}

func snapshotChanges(old, current map[string]any) map[string][2]any {
	changes := map[string][2]any{}
	keys := map[string]struct{}{}
	for key := range old {
		keys[key] = struct{}{}
	}
	for key := range current {
		keys[key] = struct{}{}
	}
	for key := range keys {
		before, bok := old[key]
		after, aok := current[key]
		if !bok {
			before = nil
		}
		if !aok {
			after = nil
		}
		beforeJSON, _ := json.Marshal(before)
		afterJSON, _ := json.Marshal(after)
		if !bytes.Equal(beforeJSON, afterJSON) {
			changes[key] = [2]any{before, after}
		}
	}
	return changes
}

func (r *FilesystemReconciler) canonicalFiles() ([]string, error) {
	var files []string
	roots := []string{filepath.Join(r.storeRoot, "tasks"), filepath.Join(r.storeRoot, "docs")}
	if r.allowArchive {
		roots = append(roots, filepath.Join(r.storeRoot, "archive"))
	}
	for _, root := range roots {
		err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return nil
			}
			if strings.HasSuffix(strings.ToLower(entry.Name()), ".md") {
				files = append(files, path)
			}
			return nil
		})
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	sort.Strings(files)
	return files, nil
}

func (r *FilesystemReconciler) uniqueIdentity(kind, id, target string) error {
	roots := []string{filepath.Join(r.storeRoot, kind+"s")}
	if r.allowArchive && kind == "task" {
		// Authorized archive purges must prove uniqueness across both active and
		// archived roots; scanning only the target root could erase one copy
		// while leaving a same-ID sibling behind.
		roots = append(roots, filepath.Join(r.storeRoot, "archive"))
	}
	var matches []string
	visit := func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !strings.HasSuffix(entry.Name(), ".md") {
			return nil
		}
		data, e := stableRead(path)
		if e != nil {
			return nil
		}
		if kind == "task" {
			t, e := parseTaskContent(string(data))
			if e == nil && t.ID == id {
				matches = append(matches, path)
			}
		} else {
			rel, _ := filepath.Rel(filepath.Join(r.storeRoot, "docs"), path)
			d, e := parseDocContent(string(data), strings.TrimSuffix(filepath.ToSlash(rel), ".md"), filepath.Dir(rel), false, "")
			if e == nil && d.ID == id {
				matches = append(matches, path)
			}
		}
		return nil
	}
	for _, root := range roots {
		_ = filepath.WalkDir(root, visit)
	}
	if len(matches) != 1 || filepath.Clean(matches[0]) != filepath.Clean(target) {
		return fmt.Errorf("%w: ambiguous %s identity %q", ErrReconcileUnsafe, kind, id)
	}
	return nil
}

func (r *FilesystemReconciler) validateCanonicalPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if !under(filepath.Join(r.storeRoot, "tasks"), abs) && !(r.allowArchive && under(filepath.Join(r.storeRoot, "archive"), abs)) && !under(filepath.Join(r.storeRoot, "docs"), abs) {
		return "", fmt.Errorf("%w: path outside canonical roots", ErrReconcileUnsafe)
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("%w: symlink path", ErrReconcileUnsafe)
	}
	for current := abs; under(r.storeRoot, current) && filepath.Clean(current) != filepath.Clean(r.storeRoot); current = filepath.Dir(current) {
		parentInfo, statErr := os.Lstat(current)
		if statErr == nil && parentInfo.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("%w: symlink ancestor", ErrReconcileUnsafe)
		}
	}
	if !strings.HasSuffix(strings.ToLower(abs), ".md") {
		return "", fmt.Errorf("%w: non-markdown path", ErrReconcileUnsafe)
	}
	return abs, nil
}

func (r *FilesystemReconciler) relative(path string) string {
	rel, _ := filepath.Rel(r.storeRoot, path)
	return filepath.ToSlash(rel)
}
func (r *FilesystemReconciler) readManifest() (reconcileManifest, error) {
	m := reconcileManifest{SchemaVersion: 1, Entries: map[string]manifestEntry{}}
	data, err := os.ReadFile(r.manifestPath())
	if os.IsNotExist(err) {
		return m, nil
	}
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return m, fmt.Errorf("parse reconciliation manifest: %w", err)
	}
	if m.Entries == nil {
		m.Entries = map[string]manifestEntry{}
	}
	return m, nil
}

func manifestPathConflict(manifest reconcileManifest, kind, id, path string) string {
	previous, ok := manifest.Entries[manifestKey(kind, id)]
	if !ok || strings.TrimSpace(previous.Path) == "" || filepath.Clean(previous.Path) == filepath.Clean(path) {
		return ""
	}
	return fmt.Sprintf("%v: stable %s identity %q moved from %s to %s; lifecycle reconciliation is required", ErrReconcileUnsafe, kind, id, previous.Path, path)
}

// writeManifestEntries performs a locked read-modify-write for only the
// entries changed by this reconciliation pass. Keeping the update set narrow
// prevents a stale full snapshot from replacing newer unrelated entries.
func (r *FilesystemReconciler) writeManifestEntries(entries map[string]manifestEntry) error {
	if len(entries) == 0 {
		return nil
	}
	return r.writeManifest(reconcileManifest{SchemaVersion: 1, Entries: entries})
}

func (r *FilesystemReconciler) writeManifest(m reconcileManifest) error {
	lockPath := filepath.Join(filepath.Dir(r.manifestPath()), "manifest.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return err
	}
	lockFile, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lockFile.Close()
	if err := lockTaskLifecycleFile(context.Background(), lockFile); err != nil {
		return fmt.Errorf("manifest lock: %w", err)
	}
	defer unlockTaskLifecycleFile(lockFile)
	// Merge with the latest on-disk state while holding the cross-process lock.
	if current, readErr := r.readManifest(); readErr == nil {
		merged := make(map[string]manifestEntry, len(current.Entries)+len(m.Entries))
		for key, entry := range current.Entries {
			merged[key] = entry
		}
		for key, entry := range m.Entries {
			if currentEntry, exists := merged[key]; exists && currentEntry.Revision > entry.Revision {
				continue
			}
			merged[key] = entry
		}
		m.Entries = merged
	} else if !os.IsNotExist(readErr) {
		return fmt.Errorf("manifest is corrupt or unreadable: %w", readErr)
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Dir(r.manifestPath())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".manifest-*.tmp")
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
func manifestKey(kind, id string) string { return kind + ":" + id }
func under(root, path string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
func stableRead(path string) ([]byte, error) {
	first, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if first.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("symlink")
	}
	a, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	second, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	third, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if second.Mode()&os.ModeSymlink != 0 || third.Mode()&os.ModeSymlink != 0 || first.Size() != second.Size() || second.Size() != third.Size() || !first.ModTime().Equal(second.ModTime()) || !second.ModTime().Equal(third.ModTime()) || !bytes.Equal(a, b) {
		return nil, io.ErrUnexpectedEOF
	}
	return a, nil
}
func hashBytes(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

// ReconcileScheduler is a deterministic, goroutine-free debounce scheduler.
// Call Tick with the injected clock in tests or from a watcher ticker.
type ReconcileScheduler struct {
	quiet, ceiling time.Duration
	now            func() time.Time
	pending        map[string]scheduledHint
	emit           func([]ReconcileHint)
}
type scheduledHint struct {
	hint        ReconcileHint
	first, last time.Time
	hash        string
}

func NewReconcileScheduler(emit func([]ReconcileHint), now func() time.Time) *ReconcileScheduler {
	if now == nil {
		now = time.Now
	}
	return &ReconcileScheduler{quiet: ReconcileQuietWindow, ceiling: ReconcileFlushCeiling, now: now, pending: map[string]scheduledHint{}, emit: emit}
}
func (s *ReconcileScheduler) Offer(identity, hash, path string) {
	now := s.now()
	// Identity is the serialization key. The latest hash/path wins, so an
	// editor sequence A/B/A cannot flush stale intermediate content.
	key := identity
	old, ok := s.pending[key]
	if !ok {
		s.pending[key] = scheduledHint{hint: ReconcileHint{Path: path, At: now}, first: now, last: now, hash: hash}
		return
	}
	old.last = now
	old.hint.Path = path
	s.pending[key] = old
}
func (s *ReconcileScheduler) Tick() {
	now := s.now()
	var out []ReconcileHint
	for key, p := range s.pending {
		if now.Sub(p.last) >= s.quiet || now.Sub(p.first) >= s.ceiling {
			out = append(out, p.hint)
			delete(s.pending, key)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	if len(out) > 0 && s.emit != nil {
		s.emit(out)
	}
}
func (s *ReconcileScheduler) Pending() int { return len(s.pending) }
