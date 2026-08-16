package storage

// Legacy migration and retention deliberately live outside history_jsonl.go.
// The JSONL writer remains the single authority for locking and durable
// activation, while this file translates the two historical JSON shapes.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

const (
	DefaultHistoryMaxDetailedRevisions = 200
	DefaultHistoryMaxDetailedAge       = 90 * 24 * time.Hour
)

type HistoryRetentionPolicy struct {
	MaxDetailedRevisions int
	MaxDetailedAge       time.Duration
	Now                  time.Time
	Reason               string
}

func DefaultHistoryRetentionPolicy() HistoryRetentionPolicy {
	return HistoryRetentionPolicy{MaxDetailedRevisions: DefaultHistoryMaxDetailedRevisions, MaxDetailedAge: DefaultHistoryMaxDetailedAge}
}

type LegacyCleanupTarget struct {
	EntityType    string `json:"entityType"`
	EntityID      string `json:"entityId"`
	LegacyPath    string `json:"legacyPath"`
	JSONLPath     string `json:"jsonlPath"`
	Verified      bool   `json:"verified"`
	Reason        string `json:"reason,omitempty"`
	LegacyDigest  string `json:"legacyDigest,omitempty"`
	JSONLHeadHash string `json:"jsonlHeadHash,omitempty"`
	PreviewToken  string `json:"previewToken,omitempty"`
}

type LegacyCleanupReport struct {
	Targets []LegacyCleanupTarget `json:"targets"`
}

func historyHasUnverifiedLegacy(h *models.DocVersionHistory) bool {
	if h == nil {
		return false
	}
	for _, v := range h.Versions {
		if v.LegacyUnverified {
			return true
		}
	}
	return false
}

func legacyBytesDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func readLegacyBytes(path string) ([]byte, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	return data, legacyBytesDigest(data), nil
}

func recordsProvenance(records []models.HistoryRecord, entityType, entityID, legacyPath, digest string) bool {
	if len(records) == 0 || digest == "" || legacyPath == "" {
		return false
	}
	for _, record := range records {
		if record.EntityType != entityType || record.EntityID != entityID || record.LegacyPath != legacyPath || record.LegacyDigest != digest {
			return false
		}
	}
	return true
}

func recordsEquivalent(a, b []models.HistoryRecord, allowReconcileTimestamp bool) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		left, right := a[i], b[i]
		if allowReconcileTimestamp && left.Source == "migration-reconcile" && right.Source == "migration-reconcile" {
			// The canonical current snapshot and all immutable metadata remain
			// compared. Only the wall-clock timestamp generated for a retry is
			// ignored; the already-active timestamp is never overwritten.
			left.Timestamp = time.Time{}
			right.Timestamp = time.Time{}
			left.RecordHash = ""
			right.RecordHash = ""
		}
		if !reflect.DeepEqual(left, right) {
			return false
		}
	}
	return true
}

func legacyPayloadMatches(data []byte, supplied any) bool {
	var diskValue any
	if err := json.Unmarshal(data, &diskValue); err != nil {
		return false
	}
	encoded, err := json.Marshal(supplied)
	if err != nil {
		return false
	}
	var suppliedValue any
	if err := json.Unmarshal(encoded, &suppliedValue); err != nil {
		return false
	}
	return reflect.DeepEqual(diskValue, suppliedValue)
}

func validateLegacyReconcile(records []models.HistoryRecord) error {
	lastUnverified := -1
	lastReconcile := -1
	for i, record := range records {
		if record.LegacyUnverified {
			lastUnverified = i
		}
		if !record.LegacyUnverified && record.Source == "migration-reconcile" && record.Checkpoint && record.NewHash != "" {
			lastReconcile = i
		}
	}
	if lastUnverified >= 0 && lastReconcile <= lastUnverified {
		return errors.New("unverified legacy chain has no verified reconcile checkpoint")
	}
	return nil
}

func semanticValidateRecords(records []models.HistoryRecord) error {
	if len(records) == 0 {
		return errors.New("empty history replacement")
	}
	if err := validateLegacyReconcile(records); err != nil {
		return err
	}
	if records[0].EntityType == "task" {
		_, err := taskHistoryFromRecords(records[0].EntityID, records)
		return err
	}
	_, err := docHistoryFromRecords(firstNonEmpty(records[len(records)-1].CurrentPath, records[0].EntityID), records)
	return err
}

// ReplaceRecords is the only path used to activate a migrated or compacted
// stream. No active .jsonl exists until staging, validation, file sync,
// rename, and directory sync all succeed.
func (s *HistoryStore) ReplaceRecords(ctx context.Context, entityType, entityID string, records []models.HistoryRecord) error {
	return s.replaceRecords(ctx, entityType, entityID, records, "", "", false)
}

func (s *HistoryStore) replaceRecords(ctx context.Context, entityType, entityID string, records []models.HistoryRecord, legacyPath, legacyDigest string, allowReconcileTimestamp bool) error {
	if !validHistoryEntityType(entityType) || strings.TrimSpace(entityID) == "" {
		return fmt.Errorf("invalid history entity %s/%s", entityType, entityID)
	}
	return s.withEntityLock(ctx, entityType, entityID, func() error {
		if legacyPath != "" {
			canonicalPath, ok := s.managedLegacyPath(entityType, entityID, legacyPath)
			if !ok {
				return errors.New("legacy provenance source is outside the managed versions store")
			}
			legacyPath = canonicalPath
			info, err := os.Lstat(legacyPath)
			if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("legacy provenance source is not a regular file")
			}
			_, currentDigest, err := readLegacyBytes(legacyPath)
			if err != nil {
				return fmt.Errorf("read legacy provenance source: %w", err)
			}
			if currentDigest != legacyDigest {
				return fmt.Errorf("legacy provenance source changed during migration")
			}
		}
		path := s.EntityPath(entityType, entityID)
		if fileExists(path) {
			active, err := s.readFile(path, entityType, entityID)
			if err != nil {
				return fmt.Errorf("validate existing active history: %w", err)
			}
			if active.TailTruncated {
				return errors.New("validate existing active history: truncated final record")
			}
			if err := semanticValidateRecords(active.Records); err != nil {
				return fmt.Errorf("validate existing active replay: %w", err)
			}
			if legacyPath != "" && !recordsProvenance(active.Records, entityType, entityID, legacyPath, legacyDigest) {
				return fmt.Errorf("existing active history legacy provenance mismatch")
			}
			_, prepared, err := marshalReplacementRecords(records, entityType, entityID)
			if err != nil {
				return fmt.Errorf("validate replacement history against active stream: %w", err)
			}
			if !recordsEquivalent(active.Records, prepared, allowReconcileTimestamp) {
				return fmt.Errorf("existing active history is not equivalent to replacement")
			}
			return nil
		}
		data, prepared, err := marshalReplacementRecords(records, entityType, entityID)
		if err != nil {
			return err
		}
		if s.validate != nil {
			if err := s.validate(prepared); err != nil {
				return fmt.Errorf("validate replacement history: %w", err)
			}
		}
		return s.activateReplacement(path, data, prepared)
	})
}

func (s *HistoryStore) activateReplacement(path string, data []byte, records []models.HistoryRecord) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create history directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".history-migration-*.tmp")
	if err != nil {
		return fmt.Errorf("stage history replacement: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = tmp.Close(); _ = os.Remove(tmpName) }
	appendFn := s.append
	if appendFn == nil {
		appendFn = func(f *os.File, b []byte) (int, error) { return f.Write(b) }
	}
	if n, err := appendFn(tmp, data); err != nil || n != len(data) {
		cleanup()
		if err != nil {
			return fmt.Errorf("write staged history replacement: %w", err)
		}
		return io.ErrShortWrite
	}
	syncFn := s.compactSync
	if syncFn == nil {
		syncFn = s.sync
	}
	if syncFn == nil {
		syncFn = (*os.File).Sync
	}
	if err := syncFn(tmp); err != nil {
		cleanup()
		return fmt.Errorf("sync staged history replacement: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("close staged history replacement: %w", err)
	}
	syncDir := s.syncDirectory
	if syncDir == nil {
		syncDir = syncDirectory
	}
	if err := syncDir(dir); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("sync staging directory: %w", err)
	}
	// Validate from disk as the final pre-activation check. This catches
	// encoding/short-write problems that an in-memory check cannot see.
	check, err := s.readFile(tmpName, records[0].EntityType, records[0].EntityID)
	if err != nil || len(check.Records) != len(records) {
		_ = os.Remove(tmpName)
		if err != nil {
			return fmt.Errorf("validate staged history: %w", err)
		}
		return fmt.Errorf("validate staged history: record count mismatch")
	}
	if err := validateLegacyReconcile(check.Records); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("validate staged history: %w", err)
	}
	if records[0].EntityType == "task" {
		if _, err := taskHistoryFromRecords(records[0].EntityID, check.Records); err != nil {
			_ = os.Remove(tmpName)
			return fmt.Errorf("validate staged Task replay: %w", err)
		}
	} else {
		if _, err := docHistoryFromRecords(firstNonEmpty(check.Records[len(check.Records)-1].CurrentPath, records[0].EntityID), check.Records); err != nil {
			_ = os.Remove(tmpName)
			return fmt.Errorf("validate staged Doc replay: %w", err)
		}
	}
	rename := s.rename
	if rename == nil {
		rename = os.Rename
	}
	backup := ""
	if _, statErr := os.Lstat(path); statErr == nil {
		backup = path + ".history-backup"
		_ = os.Remove(backup)
		if err := copyDurableFile(path, backup, syncFn); err != nil {
			_ = os.Remove(tmpName)
			return fmt.Errorf("stage active history backup: %w", err)
		}
		if err := syncDir(dir); err != nil {
			_ = os.Remove(tmpName)
			_ = os.Remove(backup)
			return fmt.Errorf("sync active history backup: %w", err)
		}
	}
	if err := rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("activate history replacement: %w", err)
	}
	if err := syncDir(dir); err != nil {
		// Roll back the newly named file. This preserves the previous durable
		// head for injected swap/fsync failures.
		if backup != "" {
			_ = os.Rename(backup, path)
		} else {
			_ = os.Remove(path)
		}
		_ = syncDir(dir)
		return fmt.Errorf("sync activated history directory: %w", err)
	}
	if backup != "" {
		// The active successor was already directory-synced above. Removing the
		// backup is cleanup only; do not turn a successful swap into a reported
		// failure after the old head is no longer needed for rollback.
		_ = os.Remove(backup)
	}
	return nil
}

func copyDurableFile(srcPath, dstPath string, syncFn func(*os.File) error) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(dstPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		_ = dst.Close()
		return err
	}
	if syncFn == nil {
		syncFn = (*os.File).Sync
	}
	if err := syncFn(dst); err != nil {
		_ = dst.Close()
		return err
	}
	return dst.Close()
}

func marshalReplacementRecords(records []models.HistoryRecord, entityType, entityID string) ([]byte, []models.HistoryRecord, error) {
	if len(records) == 0 {
		return nil, nil, fmt.Errorf("cannot activate empty history")
	}
	prepared := make([]models.HistoryRecord, len(records))
	copy(prepared, records)
	var previous []models.HistoryRecord
	for i := range prepared {
		r := &prepared[i]
		r.SchemaVersion = historySchemaVersion
		r.EntityType, r.EntityID = entityType, entityID
		r.Revision = i + 1
		if i == 0 {
			r.PrevRecordHash = ""
		} else {
			r.PrevRecordHash = prepared[i-1].RecordHash
			if r.BaseHash == "" && !r.LegacyUnverified {
				r.BaseHash = prepared[i-1].NewHash
			}
		}
		r.RecordHash = ""
		r.RecordHash = historyRecordHash(*r)
		if err := validateHistoryRecord(*r, i+1, previous, entityType, entityID); err != nil {
			return nil, nil, err
		}
		previous = append(previous, *r)
	}
	var data []byte
	for _, r := range prepared {
		line, err := json.Marshal(r)
		if err != nil {
			return nil, nil, err
		}
		data = append(data, line...)
		data = append(data, '\n')
	}
	return data, prepared, nil
}

// MigrateLegacyTask translates every legacy snapshot without changing its
// source file. Snapshots are retained as checkpoints because this is the only
// lossless representation of the old full-snapshot format.
func (s *HistoryStore) MigrateLegacyTask(ctx context.Context, legacyPath, taskID string, legacy *models.TaskVersionHistory) error {
	if legacy == nil {
		return errors.New("legacy Task history is nil")
	}
	canonicalPath, ok := s.managedLegacyPath("task", taskID, legacyPath)
	if !ok {
		return errors.New("legacy Task provenance source is outside the managed versions store")
	}
	legacyPath = canonicalPath
	legacyBytes, legacyDigest, err := readLegacyBytes(legacyPath)
	if err != nil {
		return fmt.Errorf("read legacy Task provenance: %w", err)
	}
	var exactLegacy models.TaskVersionHistory
	if err := json.Unmarshal(legacyBytes, &exactLegacy); err != nil {
		return fmt.Errorf("parse legacy Task provenance: %w", err)
	}
	if !legacyPayloadMatches(legacyBytes, legacy) {
		return errors.New("legacy Task input does not match the exact provenance bytes")
	}
	if exactLegacy.TaskID != taskID || !legacyFileMatches(LegacyCleanupTarget{EntityType: "task", EntityID: taskID, LegacyPath: legacyPath}) {
		return errors.New("legacy Task provenance entity binding mismatch")
	}
	legacy = &exactLegacy
	records := make([]models.HistoryRecord, 0, len(legacy.Versions))
	var previousHash string
	for i, v := range legacy.Versions {
		record := models.HistoryRecord{EntityType: "task", EntityID: taskID, Timestamp: v.Timestamp, Author: v.Author, Source: v.Source, SessionID: v.SessionID, BatchID: v.BatchID, LifecycleID: v.LifecycleEventID, TaskChanges: append([]models.TaskChange(nil), v.Changes...), Legacy: true, LegacyRevision: v.Version, LegacyID: v.ID, LegacyPath: legacyPath, LegacyDigest: legacyDigest}
		if record.LegacyRevision == 0 {
			record.LegacyRevision = i + 1
		}
		if record.LegacyID == "" {
			record.LegacyID = fmt.Sprintf("v%d", record.LegacyRevision)
		}
		record.Checkpoint = len(v.Snapshot) > 0
		record.CheckpointPayload = cloneMap(v.Snapshot)
		computedHash := taskCanonicalHash(v.Snapshot)
		record.NewHash = computedHash
		record.BaseHash = previousHash
		if v.NewHash != "" && v.NewHash != computedHash {
			record.LegacyNewHash = v.NewHash
		}
		if v.BaseHash != "" && v.BaseHash != previousHash {
			record.LegacyBaseHash = v.BaseHash
		}
		if !record.Checkpoint || record.NewHash == "" || record.LegacyNewHash != "" || record.LegacyBaseHash != "" {
			record.LegacyUnverified = true
		}
		if len(records) > 0 && records[len(records)-1].LegacyUnverified {
			record.LegacyUnverified = true
		}
		previousHash = record.NewHash
		records = append(records, record)
	}
	if len(records) == 0 {
		return nil
	}
	return s.replaceRecords(ctx, "task", taskID, records, legacyPath, legacyDigest, false)
}

// MigrateLegacyDoc follows the same lossless rule. Mismatched legacy hashes
// are retained as legacy metadata and do not prevent a verified checkpoint
// from being appended by the caller once it has read the canonical Doc.
func (s *HistoryStore) MigrateLegacyDoc(ctx context.Context, legacyPath, docID, docPath string, legacy *models.DocVersionHistory) error {
	return s.MigrateLegacyDocWithCurrent(ctx, legacyPath, docID, docPath, legacy, nil)
}

// MigrateLegacyDocWithCurrent appends a verified migration-reconcile
// checkpoint in the same staged replacement whenever legacy continuity is
// incomplete or mismatched. current is read from the canonical Doc by the
// caller, never synthesized from the broken chain.
func (s *HistoryStore) MigrateLegacyDocWithCurrent(ctx context.Context, legacyPath, docID, docPath string, legacy *models.DocVersionHistory, current map[string]any) error {
	if legacy == nil {
		return errors.New("legacy Doc history is nil")
	}
	canonicalPath, ok := s.managedLegacyPath("doc", docID, legacyPath)
	if !ok {
		return errors.New("legacy Doc provenance source is outside the managed versions store")
	}
	legacyPath = canonicalPath
	legacyBytes, legacyDigest, err := readLegacyBytes(legacyPath)
	if err != nil {
		return fmt.Errorf("read legacy Doc provenance: %w", err)
	}
	var exactLegacy models.DocVersionHistory
	if err := json.Unmarshal(legacyBytes, &exactLegacy); err != nil {
		return fmt.Errorf("parse legacy Doc provenance: %w", err)
	}
	if !legacyPayloadMatches(legacyBytes, legacy) {
		return errors.New("legacy Doc input does not match the exact provenance bytes")
	}
	actualDocPath := normalizeDocPath(firstNonEmpty(exactLegacy.CurrentPath, exactLegacy.DocPath))
	if (actualDocPath != "" && normalizeDocPath(docPath) != actualDocPath) || !legacyFileMatches(LegacyCleanupTarget{EntityType: "doc", EntityID: docID, LegacyPath: legacyPath}) {
		return errors.New("legacy Doc provenance entity/path binding mismatch")
	}
	legacy = &exactLegacy
	records := make([]models.HistoryRecord, 0, len(legacy.Versions))
	var previousHash string
	for i, v := range legacy.Versions {
		payload := cloneMap(v.Snapshot)
		if payload != nil && payload["path"] == nil && docPath != "" {
			payload["path"] = docPath
		}
		computedHash := hashSnapshot(payload)
		record := models.HistoryRecord{EntityType: "doc", EntityID: docID, Timestamp: v.Timestamp, Author: v.Author, Actor: v.Actor, Source: v.Source, AuditEventID: v.AuditEventID, SessionID: v.SessionID, BatchID: v.BatchID, BaseHash: previousHash, NewHash: computedHash, Checkpoint: len(payload) > 0, DocChanges: append([]models.DocChange(nil), v.Changes...), ChangedScopes: append([]models.DocChangeScope(nil), v.ChangedScopes...), CurrentPath: firstNonEmpty(v.CurrentPath, v.DocPath, docPath), PreviousPath: v.PreviousPath, CheckpointPayload: payload, Legacy: true, LegacyRevision: v.Version, LegacyID: v.ID, LegacyPath: legacyPath, LegacyDigest: legacyDigest}
		if record.LegacyRevision == 0 {
			record.LegacyRevision = i + 1
		}
		if record.LegacyID == "" {
			record.LegacyID = fmt.Sprintf("v%d", record.LegacyRevision)
		}
		if v.NewHash != "" && v.NewHash != computedHash {
			record.LegacyNewHash = v.NewHash
		}
		if v.BaseHash != "" && v.BaseHash != previousHash {
			record.LegacyBaseHash = v.BaseHash
		}
		if !record.Checkpoint || record.NewHash == "" || record.LegacyNewHash != "" || record.LegacyBaseHash != "" {
			record.LegacyUnverified = true
		}
		if len(records) > 0 && records[len(records)-1].LegacyUnverified {
			record.LegacyUnverified = true
		}
		previousHash = record.NewHash
		records = append(records, record)
	}
	if len(records) == 0 {
		return nil
	}
	needsReconcile := false
	for _, record := range records {
		if record.LegacyUnverified {
			needsReconcile = true
			break
		}
	}
	if needsReconcile && len(current) > 0 {
		current = cloneMap(current)
		if current["path"] == nil {
			current["path"] = docPath
		}
		logical := records[len(records)-1].LegacyRevision + 1
		records = append(records, models.HistoryRecord{EntityType: "doc", EntityID: docID, Timestamp: time.Now().UTC(), Source: "migration-reconcile", BaseHash: records[len(records)-1].NewHash, NewHash: hashSnapshot(current), Checkpoint: true, CurrentPath: docPath, CheckpointPayload: current, LegacyRevision: logical, LegacyID: fmt.Sprintf("v%d", logical), LegacyPath: legacyPath, LegacyDigest: legacyDigest})
	}
	return s.replaceRecords(ctx, "doc", docID, records, legacyPath, legacyDigest, needsReconcile)
}

func (s *HistoryStore) Compact(ctx context.Context, entityType, entityID string, policy HistoryRetentionPolicy) error {
	if policy.MaxDetailedRevisions <= 0 {
		policy.MaxDetailedRevisions = DefaultHistoryMaxDetailedRevisions
	}
	if policy.MaxDetailedAge <= 0 {
		policy.MaxDetailedAge = DefaultHistoryMaxDetailedAge
	}
	if policy.Now.IsZero() {
		policy.Now = time.Now().UTC()
	}
	return s.withEntityLock(ctx, entityType, entityID, func() error {
		path := s.EntityPath(entityType, entityID)
		read, err := s.readFile(path, entityType, entityID)
		if err != nil {
			return err
		}
		if read.TailTruncated {
			return fmt.Errorf("cannot compact truncated history stream")
		}
		if len(read.Records) > 0 {
			if err := semanticValidateRecords(read.Records); err != nil {
				return fmt.Errorf("cannot compact semantically invalid history: %w", err)
			}
		}
		if len(read.Records) <= 1 {
			return nil
		}
		boundary := len(read.Records) - policy.MaxDetailedRevisions
		cutoff := policy.Now.Add(-policy.MaxDetailedAge)
		for i, r := range read.Records {
			if !r.Timestamp.IsZero() && r.Timestamp.Before(cutoff) && i+1 > boundary {
				boundary = i + 1
			}
		}
		if boundary <= 0 || boundary >= len(read.Records) {
			if boundary >= len(read.Records) {
				boundary = len(read.Records) - 1
			}
			if boundary <= 0 {
				return nil
			}
		}
		// Include the boundary revision itself: the synthesized checkpoint must
		// represent the state *after* that revision, otherwise compaction would
		// silently lose its change.
		state, ok := replayGenericSnapshot(read.Records[:boundary+1], entityType)
		if !ok {
			return nil
		} // no safe state seed; retain the authoritative stream
		seed := read.Records[boundary]
		seed.Checkpoint = true
		seed.BaseHash = ""
		seed.CheckpointPayload = state
		if entityType == "task" {
			seed.NewHash = taskCanonicalHash(state)
		} else {
			seed.NewHash = hashSnapshot(state)
		}
		selected := append([]models.HistoryRecord{seed}, read.Records[boundary+1:]...)
		for i := range selected {
			if selected[i].LegacyRevision == 0 {
				selected[i].LegacyRevision = read.Records[boundary+i].Revision
			}
			if selected[i].LegacyID == "" {
				selected[i].LegacyID = fmt.Sprintf("v%d", selected[i].LegacyRevision)
			}
		}
		reason := policy.Reason
		if reason == "" {
			reason = "max_detailed_revisions_and_max_age"
		}
		gap := models.DocHistoryGap{Type: "retention-gap", Reason: reason, Count: boundary, BeforeVersion: logicalVersionID(read.Records[boundary-1]), AfterVersion: logicalVersionID(read.Records[boundary]), AppliedAt: policy.Now}
		selected[0].RetentionGaps = append(selected[0].RetentionGaps, gap)
		data, prepared, err := marshalReplacementRecords(selected, entityType, entityID)
		if err != nil {
			return err
		}
		if s.validate != nil {
			if err := s.validate(prepared); err != nil {
				return err
			}
		}
		return s.activateReplacement(path, data, prepared)
	})
}

func cleanupToken(entityType, entityID, legacyPath, digest, head string) string {
	sum := sha256.Sum256([]byte(entityType + "\x00" + entityID + "\x00" + legacyPath + "\x00" + digest + "\x00" + head))
	return hex.EncodeToString(sum[:])
}

func (s *HistoryStore) previewLegacyCleanupLocked(entityType, entityID string, legacyPaths ...string) LegacyCleanupReport {
	targets := []LegacyCleanupTarget{}
	jsonlPath := s.EntityPath(entityType, entityID)
	result, readErr := s.readFile(jsonlPath, entityType, entityID)
	verifiedJSONL := readErr == nil && len(result.Records) > 0 && !result.TailTruncated
	if verifiedJSONL {
		verifiedJSONL = semanticValidateRecords(result.Records) == nil
	}
	for _, path := range legacyPaths {
		if strings.TrimSpace(path) == "" {
			continue
		}
		if canonicalPath, ok := s.managedLegacyPath(entityType, entityID, path); ok {
			path = canonicalPath
		}
		pathOK := s.safeLegacyPath(entityType, entityID, path)
		if info, statErr := os.Lstat(path); statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			pathOK = false
		}
		pathErr := readErr
		if !pathOK {
			pathErr = errors.New("path is outside managed legacy store")
		}
		digest := ""
		if pathOK {
			if data, currentDigest, digestErr := readLegacyBytes(path); digestErr == nil {
				digest = currentDigest
				_ = data
			} else {
				pathOK = false
				pathErr = digestErr
			}
		}
		head := ""
		if verifiedJSONL {
			head = result.Records[len(result.Records)-1].RecordHash
		}
		provenanceOK := verifiedJSONL && pathOK && digest != "" && recordsProvenance(result.Records, entityType, entityID, path, digest) && legacyFileMatches(LegacyCleanupTarget{EntityType: entityType, EntityID: entityID, LegacyPath: path})
		target := LegacyCleanupTarget{EntityType: entityType, EntityID: entityID, LegacyPath: path, JSONLPath: jsonlPath, Verified: provenanceOK, Reason: cleanupReason(provenanceOK, pathErr), LegacyDigest: digest, JSONLHeadHash: head}
		if provenanceOK {
			target.PreviewToken = cleanupToken(entityType, entityID, path, digest, head)
		}
		targets = append(targets, target)
	}
	return LegacyCleanupReport{Targets: targets}
}

func (s *HistoryStore) PreviewLegacyCleanup(entityType, entityID string, legacyPaths ...string) LegacyCleanupReport {
	var report LegacyCleanupReport
	if !validHistoryEntityType(entityType) {
		return report
	}
	_ = s.withEntityLock(context.Background(), entityType, entityID, func() error { report = s.previewLegacyCleanupLocked(entityType, entityID, legacyPaths...); return nil })
	return report
}

func cleanupReason(verified bool, err error) string {
	if verified {
		return "authoritative JSONL successor verified"
	}
	if err != nil {
		return "JSONL successor failed validation"
	}
	return "JSONL successor is missing or empty"
}

func logicalVersionID(record models.HistoryRecord) string {
	if record.LegacyID != "" {
		return record.LegacyID
	}
	if record.LegacyRevision > 0 {
		return fmt.Sprintf("v%d", record.LegacyRevision)
	}
	return fmt.Sprintf("v%d", record.Revision)
}

func replayGenericSnapshot(records []models.HistoryRecord, entityType string) (map[string]any, bool) {
	if entityType == "doc" {
		state := &models.Doc{}
		seeded := false
		for _, record := range records {
			if record.Checkpoint {
				state = &models.Doc{}
				applyDocSnapshot(state, record.CheckpointPayload)
				seeded = len(record.CheckpointPayload) > 0
			}
			if !seeded {
				continue
			}
			if !record.Checkpoint {
				if err := applyDocChangesToState(state, record); err != nil {
					return nil, false
				}
			}
		}
		return DocToSnapshot(state), seeded
	}
	state := map[string]any{}
	seeded := false
	for _, record := range records {
		if record.Checkpoint {
			state = cloneMap(record.CheckpointPayload)
			seeded = len(state) > 0
		}
		if !seeded {
			continue
		}
		if !record.Checkpoint {
			if entityType == "task" {
				state = applyTaskChangesToMap(state, record.TaskChanges)
			}
		}
	}
	return state, seeded && len(state) > 0
}

func (s *HistoryStore) ConfirmLegacyCleanup(ctx context.Context, target LegacyCleanupTarget, confirmed bool) error {
	if !confirmed {
		return errors.New("legacy cleanup requires explicit confirmation")
	}
	canonicalPath, ok := s.managedLegacyPath(target.EntityType, target.EntityID, target.LegacyPath)
	if !ok {
		return errors.New("legacy cleanup path is outside the managed versions store")
	}
	target.LegacyPath = canonicalPath
	if !target.Verified {
		return errors.New("legacy cleanup target is not marked verified")
	}
	if target.JSONLPath != s.EntityPath(target.EntityType, target.EntityID) {
		return errors.New("legacy cleanup successor path does not match the managed entity")
	}
	return s.withEntityLock(ctx, target.EntityType, target.EntityID, func() error {
		return s.confirmLegacyCleanupLocked(ctx, target)
	})
}

func (s *HistoryStore) confirmLegacyCleanupLocked(ctx context.Context, target LegacyCleanupTarget) error {
	report := s.previewLegacyCleanupLocked(target.EntityType, target.EntityID, target.LegacyPath)
	if len(report.Targets) != 1 || !report.Targets[0].Verified || report.Targets[0].LegacyPath != target.LegacyPath || report.Targets[0].LegacyDigest != target.LegacyDigest || report.Targets[0].JSONLHeadHash != target.JSONLHeadHash || report.Targets[0].PreviewToken == "" || report.Targets[0].PreviewToken != target.PreviewToken {
		return errors.New("legacy cleanup preview is stale or successor is not verified")
	}
	info, err := os.Lstat(target.LegacyPath)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("legacy cleanup target is not a regular file")
	}
	if err := os.Remove(target.LegacyPath); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(target.LegacyPath))
}

func (s *HistoryStore) safeLegacyPath(entityType, entityID, path string) bool {
	root, err := filepath.Abs(filepath.Join(s.root, "versions"))
	if err != nil {
		return false
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return false
	}
	base := filepath.Base(abs)
	if entityType == "task" {
		return base == "task-"+entityID+".json"
	}
	return strings.HasPrefix(base, "doc-") && strings.HasSuffix(base, ".json") || base == "docid-"+strings.NewReplacer("/", "-", "\\", "-", "..", "").Replace(entityID)+".json"
}

// managedLegacyPath canonicalizes and constrains provenance to one of the
// store-derived legacy files. Keeping the canonical path in each JSONL record
// prevents relative-path aliases from bypassing cleanup provenance checks.
func (s *HistoryStore) managedLegacyPath(entityType, entityID, path string) (string, bool) {
	if !validHistoryEntityType(entityType) || strings.TrimSpace(path) == "" {
		return "", false
	}
	abs, err := filepath.Abs(path)
	if err != nil || !s.safeLegacyPath(entityType, entityID, abs) {
		return "", false
	}
	return filepath.Clean(abs), true
}

func legacyFileMatches(target LegacyCleanupTarget) bool {
	data, err := os.ReadFile(target.LegacyPath)
	if err != nil {
		return false
	}
	if target.EntityType == "task" {
		var h models.TaskVersionHistory
		return json.Unmarshal(data, &h) == nil && h.TaskID == target.EntityID
	}
	var h models.DocVersionHistory
	if json.Unmarshal(data, &h) != nil {
		return false
	}
	base := filepath.Base(target.LegacyPath)
	if strings.HasPrefix(base, "docid-") {
		return base == "docid-"+strings.NewReplacer("/", "-", "\\", "-", "..", "").Replace(target.EntityID)+".json" && h.DocID == target.EntityID
	}
	path := normalizeDocPath(firstNonEmpty(h.CurrentPath, h.DocPath))
	expectedName := ""
	if path != "" {
		expectedName = "doc-" + strings.ReplaceAll(path, "/", "--") + ".json"
	}
	if expectedName == "" || base != expectedName {
		return false
	}
	if h.DocID == target.EntityID {
		return true
	}
	if h.DocID != "" {
		return false
	}
	return legacyDocID(path) == target.EntityID
}

func (vs *VersionStore) migrateLegacyTask(taskID string) error {
	if vs.hasJSONLHistory("task", taskID) {
		return nil
	}
	path := vs.versionPath(taskID)
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var legacy models.TaskVersionHistory
	if err := json.Unmarshal(data, &legacy); err != nil {
		return fmt.Errorf("parse legacy Task history %s: %w", taskID, err)
	}
	return vs.historyStore().MigrateLegacyTask(context.Background(), path, taskID, &legacy)
}

func (vs *VersionStore) migrateLegacyDocPaths(paths ...string) error {
	return vs.migrateLegacyDocPathsWithCurrent(nil, paths...)
}

func (vs *VersionStore) migrateLegacyDocPathsWithCurrent(current *models.Doc, paths ...string) error {
	if stable, ok, err := vs.loadStableDocHistoryForAnyPath(paths...); err != nil {
		return err
	} else if ok && stable != nil && stable.DocID != "" && !vs.hasJSONLHistory("doc", stable.DocID) {
		snapshot := map[string]any(nil)
		if current != nil {
			snapshot = DocToSnapshot(current)
		}
		return vs.historyStore().MigrateLegacyDocWithCurrent(context.Background(), vs.stableDocVersionPath(stable.DocID), stable.DocID, firstNonEmpty(stable.CurrentPath, stable.DocPath), stable, snapshot)
	}
	for _, path := range compactDocPaths(paths...) {
		// Stable files are authoritative when present; the path index only
		// supplies identity and is intentionally not rewritten during migration.
		legacyPath := vs.legacyDocVersionPath(path)
		data, err := os.ReadFile(legacyPath)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		var legacy models.DocVersionHistory
		if err := json.Unmarshal(data, &legacy); err != nil {
			return fmt.Errorf("parse legacy Doc history %s: %w", path, err)
		}
		docID := firstNonEmpty(legacy.DocID, legacyDocID(path))
		if vs.hasJSONLHistory("doc", docID) {
			return nil
		}
		var snapshot map[string]any
		if current != nil {
			snapshot = DocToSnapshot(current)
		}
		return vs.historyStore().MigrateLegacyDocWithCurrent(context.Background(), legacyPath, docID, path, &legacy, snapshot)
	}
	return nil
}

// PreviewLegacyCleanup and ConfirmLegacyCleanup are explicit APIs used by
// commands/adapters. They never perform privacy purge; only the named legacy
// JSON file can be removed after a valid JSONL successor is proven.
func (vs *VersionStore) PreviewLegacyCleanup(entityType, entityID string) LegacyCleanupReport {
	paths := []string{}
	switch entityType {
	case "task":
		paths = append(paths, vs.versionPath(entityID))
	case "doc":
		if h, err := vs.GetDocHistory(entityID); err == nil {
			paths = append(paths, vs.legacyDocVersionPath(h.CurrentPath), vs.stableDocVersionPath(h.DocID))
		}
	}
	return vs.historyStore().PreviewLegacyCleanup(entityType, entityID, paths...)
}

func (vs *VersionStore) ConfirmLegacyCleanup(ctx context.Context, target LegacyCleanupTarget, confirmed bool) error {
	return vs.historyStore().ConfirmLegacyCleanup(ctx, target, confirmed)
}
