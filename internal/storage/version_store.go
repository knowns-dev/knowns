package storage

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

// VersionStore reads and writes task version histories from .knowns/versions/.
type VersionStore struct {
	root          string
	lifecycleLock *taskLifecycleLock
	history       *HistoryStore
	historyOnce   sync.Once
}

func (vs *VersionStore) historyStore() *HistoryStore {
	vs.historyOnce.Do(func() {
		if vs.history == nil {
			vs.history = NewHistoryStore(vs.root)
		}
	})
	return vs.history
}

func (vs *VersionStore) taskUsesJSONL(taskID string) bool {
	return vs.hasJSONLHistory("task", taskID)
}

func (vs *VersionStore) versionsDir() string { return filepath.Join(vs.root, "versions") }

func (vs *VersionStore) versionPath(taskID string) string {
	return filepath.Join(vs.versionsDir(), "task-"+taskID+".json")
}

// GetHistory returns the full version history for a task.
// Returns an empty history (not an error) if no history file exists.
func (vs *VersionStore) GetHistory(taskID string) (*models.TaskVersionHistory, error) {
	if result, err := vs.historyStore().Read(context.Background(), "task", taskID); err != nil {
		return nil, err
	} else if len(result.Records) > 0 || result.TailTruncated {
		history, err := taskHistoryFromRecords(taskID, result.Records)
		if history != nil {
			history.TailTruncated = result.TailTruncated
		}
		return history, err
	}
	data, err := os.ReadFile(vs.versionPath(taskID))
	if os.IsNotExist(err) {
		return &models.TaskVersionHistory{
			TaskID:         taskID,
			CurrentVersion: 0,
			Versions:       []models.TaskVersion{},
		}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read version history %s: %w", taskID, err)
	}
	var h models.TaskVersionHistory
	if err := json.Unmarshal(data, &h); err != nil {
		return nil, fmt.Errorf("parse version history %s: %w", taskID, err)
	}
	if h.Versions == nil {
		h.Versions = []models.TaskVersion{}
	}
	return &h, nil
}

// ListTaskHistoryMetadata returns a payload-free, newest-first page. The
// legacy JSON backend is retained as a compatibility fallback; JSONL callers
// use HistoryStore.ListMetadata and never materialize checkpoint payloads.
func (vs *VersionStore) ListTaskHistoryMetadata(taskID string, offset, limit int) (*models.TaskVersionHistoryPage, error) {
	if vs.hasJSONLHistory("task", taskID) {
		records, _, tailTruncated, err := vs.historyStore().ListMetadataWithStatus(context.Background(), "task", taskID, 0, 0)
		if err != nil {
			return nil, err
		}
		page := historyMetadataPage(records, offset, limit)
		page.EntityType, page.EntityID = "task", taskID
		page.TailTruncated = tailTruncated
		return page, nil
	}
	history, err := vs.GetHistory(taskID)
	if err != nil {
		return nil, err
	}
	records := make([]models.HistoryRecord, 0, len(history.Versions))
	for _, version := range history.Versions {
		records = append(records, historyRecordFromTaskVersion(taskID, version))
	}
	page := historyMetadataPage(records, offset, limit)
	page.EntityType, page.EntityID = "task", taskID
	page.TailTruncated = history.TailTruncated
	return page, nil
}

// GetTaskRevisionDetail explicitly loads one Task revision, including the
// reconstructed snapshot required by existing restore/compare consumers.
func (vs *VersionStore) GetTaskRevisionDetail(taskID, revisionID string) (*models.TaskVersion, error) {
	if vs.hasJSONLHistory("task", taskID) {
		records, _, err := vs.historyStore().ListMetadata(context.Background(), "task", taskID, 0, 0)
		if err != nil {
			return nil, err
		}
		physical, err := resolveHistoryRecordRevision(records, revisionID)
		if err != nil {
			return nil, err
		}
		window, err := vs.historyStore().ReadRecordWindow(context.Background(), "task", taskID, physical)
		if err != nil {
			return nil, err
		}
		history, err := taskHistoryFromRecords(taskID, window)
		if err != nil {
			return nil, err
		}
		if len(history.Versions) == 0 {
			return nil, fmt.Errorf("revision %q not found", revisionID)
		}
		version := history.Versions[len(history.Versions)-1]
		return &version, nil
	}
	history, err := vs.GetHistory(taskID)
	if err != nil {
		return nil, err
	}
	for _, version := range history.Versions {
		if historyRevisionMatches(version.ID, version.Version, revisionID) {
			version.Snapshot = cloneMap(version.Snapshot)
			return &version, nil
		}
	}
	return nil, fmt.Errorf("revision %q not found", revisionID)
}

// GetTaskRevision is a concise alias for GetTaskRevisionDetail.
func (vs *VersionStore) GetTaskRevision(taskID, revisionID string) (*models.TaskVersion, error) {
	return vs.GetTaskRevisionDetail(taskID, revisionID)
}

// SaveVersion appends a new version entry and updates CurrentVersion.
// version.Snapshot, Changes, and Timestamp should be populated by the caller
// (or use TrackChanges + TaskToSnapshot helpers).
func (vs *VersionStore) SaveVersion(taskID string, version models.TaskVersion) error {
	if vs.lifecycleLock == nil {
		return vs.saveVersionUnlocked(taskID, version)
	}
	return vs.lifecycleLock.with(context.Background(), func() error {
		return vs.saveVersionUnlocked(taskID, version)
	})
}

func (vs *VersionStore) saveVersionUnlocked(taskID string, version models.TaskVersion) error {
	reserved, err := (&TaskStore{root: vs.root}).IsIDReserved(taskID)
	if err != nil {
		return fmt.Errorf("check Task tombstone before saving version: %w", err)
	}
	if reserved {
		return fmt.Errorf("cannot save version for hard-deleted Task %q", taskID)
	}
	if !vs.taskUsesJSONL(taskID) {
		if err := vs.migrateLegacyTask(taskID); err != nil {
			return err
		}
	}
	h, err := vs.GetHistory(taskID)
	if err != nil {
		return err
	}

	h.CurrentVersion++
	version.ID = fmt.Sprintf("v%d", h.CurrentVersion)
	version.Version = h.CurrentVersion
	version.TaskID = taskID
	if version.Timestamp.IsZero() {
		version.Timestamp = time.Now().UTC()
	}

	// Normalize snapshot before storing to ensure consistency between write and replay paths.
	// During replay from JSONL, snapshots are already normalized via JSON unmarshal.
	// During write, snapshots come from TaskToSnapshot() and may contain strongly-typed values.
	// Normalizing here ensures h.Versions always contains normalized snapshots.
	if version.Snapshot != nil {
		version.Snapshot = normalizeStateMap(version.Snapshot)
	}

	h.Versions = append(h.Versions, version)
	checkpoint := len(h.Versions) == 1 || version.Checkpoint || historyDeltaInefficient(version.Changes, version.Snapshot)
	baseHash := ""
	if len(h.Versions) > 1 {
		baseHash = h.Versions[len(h.Versions)-2].NewHash
		if baseHash == "" && len(h.Versions[len(h.Versions)-2].Snapshot) > 0 {
			baseHash = taskCanonicalHash(h.Versions[len(h.Versions)-2].Snapshot)
		}
	}
	// For hash computation: normalize checkpoint, or apply changes to normalized previous state
	stateForHash := normalizeStateMap(cloneMap(version.Snapshot))
	if len(h.Versions) > 1 && !checkpoint {
		// Previous snapshot is already normalized (stored normalized or from JSONL replay)
		normalizedPrev := cloneMap(h.Versions[len(h.Versions)-2].Snapshot)
		stateForHash = applyTaskChangesToMap(normalizedPrev, version.Changes)
	}
	newHash := taskCanonicalHash(stateForHash)
	
	version.SchemaVersion = historySchemaVersion
	version.BaseHash = baseHash
	version.NewHash = newHash
	version.Checkpoint = checkpoint
	h.Versions[len(h.Versions)-1] = version
	jsonl := vs.hasJSONLHistory("task", taskID)
	legacy := !jsonl && fileExists(vs.versionPath(taskID))
	if jsonl || !legacy {
		if err := vs.historyStore().Append(context.Background(), models.HistoryRecord{
			EntityType: "task", EntityID: taskID, Timestamp: version.Timestamp,
			Author: version.Author, Source: version.Source, SessionID: version.SessionID,
			BatchID: version.BatchID, LifecycleID: version.LifecycleEventID,
			BaseHash: version.BaseHash, NewHash: version.NewHash, Checkpoint: version.Checkpoint,
			TaskChanges:       append([]models.TaskChange(nil), version.Changes...),
			CheckpointPayload: cloneMapIf(version.Checkpoint, version.Snapshot),
		}); err != nil {
			return err
		}
		return nil
	}

	if err := os.MkdirAll(vs.versionsDir(), 0755); err != nil {
		return fmt.Errorf("mkdir versions: %w", err)
	}
	return writeJSON(vs.versionPath(taskID), h)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// TrackChanges compares two Task values and returns the list of changed fields.
// oldTask may be nil (for the initial creation version).
func (vs *VersionStore) TrackChanges(oldTask, newTask *models.Task) []models.TaskChange {
	var changes []models.TaskChange

	if oldTask == nil {
		// Creation: record non-zero new values as additions.
		if newTask.Status != "" {
			changes = append(changes, models.TaskChange{Field: "status", NewValue: newTask.Status})
		}
		if newTask.Priority != "" {
			changes = append(changes, models.TaskChange{Field: "priority", NewValue: newTask.Priority})
		}
		return changes
	}

	diff := func(field string, old, new any) {
		if !reflect.DeepEqual(old, new) {
			ch := models.TaskChange{Field: field}
			if !isZero(old) {
				ch.OldValue = old
			}
			if !isZero(new) {
				ch.NewValue = new
			}
			changes = append(changes, ch)
		}
	}

	diff("title", oldTask.Title, newTask.Title)
	diff("status", oldTask.Status, newTask.Status)
	diff("priority", oldTask.Priority, newTask.Priority)
	diff("assignee", oldTask.Assignee, newTask.Assignee)
	diff("labels", oldTask.Labels, newTask.Labels)
	diff("description", oldTask.Description, newTask.Description)
	diff("acceptanceCriteria", oldTask.AcceptanceCriteria, newTask.AcceptanceCriteria)
	diff("implementationPlan", oldTask.ImplementationPlan, newTask.ImplementationPlan)
	diff("implementationNotes", oldTask.ImplementationNotes, newTask.ImplementationNotes)
	diff("parent", oldTask.Parent, newTask.Parent)
	diff("spec", oldTask.Spec, newTask.Spec)
	diff("fulfills", oldTask.Fulfills, newTask.Fulfills)
	diff("order", oldTask.Order, newTask.Order)
	diff("completedAt", oldTask.CompletedAt, newTask.CompletedAt)
	diff("archivedAt", oldTask.ArchivedAt, newTask.ArchivedAt)
	diff("archived", oldTask.Archived, newTask.Archived)
	diff("timeSpent", oldTask.TimeSpent, newTask.TimeSpent)

	return changes
}

// TaskToSnapshot converts a Task to the generic map snapshot stored in
// TaskVersion.Snapshot. This matches the TypeScript version history format.
func TaskToSnapshot(task *models.Task) map[string]any {
	snap := map[string]any{
		"id":        task.ID,
		"title":     task.Title,
		"status":    task.Status,
		"priority":  task.Priority,
		"createdAt": task.CreatedAt,
		"updatedAt": task.UpdatedAt,
		"timeSpent": task.TimeSpent,
		"archived":  task.Archived,
	}
	if task.Description != "" {
		snap["description"] = task.Description
	}
	if task.Assignee != "" {
		snap["assignee"] = task.Assignee
	}
	if len(task.Labels) > 0 {
		snap["labels"] = task.Labels
	}
	if len(task.AcceptanceCriteria) > 0 {
		snap["acceptanceCriteria"] = task.AcceptanceCriteria
	}
	if task.ImplementationPlan != "" {
		snap["implementationPlan"] = task.ImplementationPlan
	}
	if task.ImplementationNotes != "" {
		snap["implementationNotes"] = task.ImplementationNotes
	}
	if task.Parent != "" {
		snap["parent"] = task.Parent
	}
	if task.Spec != "" {
		snap["spec"] = task.Spec
	}
	if len(task.Fulfills) > 0 {
		snap["fulfills"] = task.Fulfills
	}
	if task.Order != nil {
		snap["order"] = *task.Order
	}
	if task.CompletedAt != nil {
		snap["completedAt"] = *task.CompletedAt
	}
	if task.ArchivedAt != nil {
		snap["archivedAt"] = *task.ArchivedAt
	}
	
	// Normalize through JSON round-trip to ensure consistent structure.
	// This is critical because strongly-typed fields (like []AcceptanceCriterion)
	// have different JSON key ordering than map[string]any after unmarshal.
	// Without this normalization, hash computation differs between write and replay paths.
	data, err := json.Marshal(snap)
	if err != nil {
		return snap
	}
	var normalized map[string]any
	if err := json.Unmarshal(data, &normalized); err != nil {
		return snap
	}
	return normalized
}

// --- Activity feed ---

// ActivityEntry is a denormalized version entry for the activity feed.
type ActivityEntry struct {
	TaskID    string              `json:"taskId"`
	TaskTitle string              `json:"taskTitle"`
	Version   int                 `json:"version"`
	Timestamp time.Time           `json:"timestamp"`
	Author    string              `json:"author,omitempty"`
	Changes   []models.TaskChange `json:"changes"`
}

// ListRecentActivities scans all task version histories and returns the most
// recent version entries across all tasks, sorted by timestamp descending.
// typeFilter optionally filters to entries containing changes of a certain
// category ("status", "assignee", "content").
func (vs *VersionStore) ListRecentActivities(limit int, typeFilter string) ([]ActivityEntry, error) {
	dir := vs.versionsDir()
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return []ActivityEntry{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read versions dir: %w", err)
	}

	var all []ActivityEntry

	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "task-") || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}

		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var h models.TaskVersionHistory
		if err := json.Unmarshal(data, &h); err != nil {
			continue
		}

		for _, v := range h.Versions {
			if len(v.Changes) == 0 {
				continue
			}

			// Apply type filter
			if typeFilter != "" && !matchesTypeFilter(v.Changes, typeFilter) {
				continue
			}

			// Extract task title from snapshot
			title, _ := v.Snapshot["title"].(string)

			all = append(all, ActivityEntry{
				TaskID:    h.TaskID,
				TaskTitle: title,
				Version:   v.Version,
				Timestamp: v.Timestamp,
				Author:    v.Author,
				Changes:   v.Changes,
			})
		}
	}

	// Sort by timestamp descending (most recent first)
	sort.Slice(all, func(i, j int) bool {
		return all[i].Timestamp.After(all[j].Timestamp)
	})

	if limit > 0 && len(all) > limit {
		all = all[:limit]
	}

	return all, nil
}

// matchesTypeFilter checks if any change in the list matches the category.
func matchesTypeFilter(changes []models.TaskChange, category string) bool {
	for _, c := range changes {
		switch category {
		case "status":
			if c.Field == "status" {
				return true
			}
		case "assignee":
			if c.Field == "assignee" {
				return true
			}
		case "content":
			if c.Field == "title" || c.Field == "description" || c.Field == "acceptanceCriteria" ||
				c.Field == "implementationPlan" || c.Field == "implementationNotes" {
				return true
			}
		}
	}
	return false
}

// --- Doc version tracking ---

type docVersionIndex struct {
	Paths map[string]string `json:"paths"`
}

// DocRevisionOptions carries optional context for document history entries.
type DocRevisionOptions struct {
	Section      string
	Actor        string
	Source       string
	AuditEventID string
	SessionID    string
	Retention    *DocHistoryRetentionPolicy
	ExpectedHash string
}

// MutationConflictError is a content-free optimistic-concurrency failure.
// Only entity identity and hashes are exposed so callers can safely log or
// return it from public APIs.
type MutationConflictError struct {
	EntityType   string
	EntityID     string
	ExpectedHash string
	CurrentHash  string
}

// DocIdentityConflictError reports an attempted stable-ID reassignment
// without exposing document content. Stable IDs are immutable once present.
type DocIdentityConflictError struct {
	EntityID    string
	RequestedID string
}

func (e *DocIdentityConflictError) Error() string {
	return fmt.Sprintf("doc %q stable identity cannot be changed to %q", e.EntityID, e.RequestedID)
}

func (e *DocIdentityConflictError) Unwrap() error { return ErrHistoryConflict }

func (e *MutationConflictError) Error() string {
	if e == nil {
		return "history conflict"
	}
	return fmt.Sprintf("%s %q mutation conflict: expected hash %q, current hash %q", e.EntityType, e.EntityID, e.ExpectedHash, e.CurrentHash)
}

func (e *MutationConflictError) Unwrap() error { return ErrHistoryConflict }

// CanonicalTaskHash and CanonicalDocHash are the single canonical hash
// helpers shared by storage and public mutation adapters.
func CanonicalTaskHash(task *models.Task) string {
	if task == nil {
		return ""
	}
	return taskCanonicalHash(TaskToSnapshot(task))
}

func CanonicalDocHash(doc *models.Doc) string { return hashDoc(doc) }

// DocHistoryRetentionPolicy bounds retained document history detail.
type DocHistoryRetentionPolicy struct {
	MaxVersions int
	MaxAge      time.Duration
	Now         time.Time
}

type docContentScope struct {
	scope models.DocChangeScope
	old   string
	new   string
	ok    bool
}

// docVersionPath returns the legacy file path for a doc's path-keyed history.
// Slashes in the doc path are replaced with "--" to create a flat filename.
func (vs *VersionStore) docVersionPath(docPath string) string {
	return vs.legacyDocVersionPath(docPath)
}

func (vs *VersionStore) legacyDocVersionPath(docPath string) string {
	safe := strings.ReplaceAll(docPath, "/", "--")
	return filepath.Join(vs.versionsDir(), "doc-"+safe+".json")
}

func (vs *VersionStore) stableDocVersionPath(docID string) string {
	safe := strings.NewReplacer("/", "-", "\\", "-", "..", "").Replace(docID)
	return filepath.Join(vs.versionsDir(), "docid-"+safe+".json")
}

func (vs *VersionStore) docVersionIndexPath() string {
	return filepath.Join(vs.versionsDir(), "doc_history_index.json")
}

// GetDocHistory returns the full version history for a document.
// Returns an empty history (not an error) if no history file exists.
func (vs *VersionStore) GetDocHistory(docPath string) (*models.DocVersionHistory, error) {
	docPath = normalizeDocPath(docPath)
	if history, ok, err := vs.readDocJSONL(docPath); ok || err != nil {
		if err != nil {
			return nil, err
		}
		return history, nil
	}

	if h, ok, err := vs.loadStableDocHistoryForPath(docPath); ok || err != nil {
		return h, err
	}
	if h, ok, err := vs.loadLegacyDocHistory(docPath); ok || err != nil {
		return h, err
	}

	return &models.DocVersionHistory{
		DocPath:        docPath,
		CurrentPath:    docPath,
		CurrentVersion: 0,
		Versions:       []models.DocVersion{},
	}, nil
}

// ListDocHistoryMetadata returns a payload-free, newest-first page and keeps
// stable Doc ID/path resolution independent of the backing history format.
func (vs *VersionStore) ListDocHistoryMetadata(docPath string, offset, limit int) (*models.DocVersionHistoryPage, error) {
	docPath = normalizeDocPath(docPath)
	entityID, ok, err := vs.historyStore().FindEntityByPathMetadata(context.Background(), "doc", docPath)
	if err != nil {
		return nil, err
	}
	if ok {
		records, _, tailTruncated, err := vs.historyStore().ListMetadataWithStatus(context.Background(), "doc", entityID, 0, 0)
		if err != nil {
			return nil, err
		}
		page := historyMetadataPage(records, offset, limit)
		page.EntityType, page.EntityID = "doc", entityID
		page.DocPath, page.CurrentPath = docPath, docPath
		page.TailTruncated = tailTruncated
		return page, nil
	}
	history, err := vs.GetDocHistory(docPath)
	if err != nil {
		return nil, err
	}
	records := make([]models.HistoryRecord, 0, len(history.Versions))
	for _, version := range history.Versions {
		records = append(records, historyRecordFromDocVersion(history.DocID, version))
	}
	page := historyMetadataPage(records, offset, limit)
	page.EntityType, page.EntityID = "doc", history.DocID
	page.DocPath, page.CurrentPath = history.DocPath, history.CurrentPath
	page.CurrentVersion = history.CurrentVersion
	page.TailTruncated = history.TailTruncated
	return page, nil
}

// GetDocRevisionDetail explicitly loads one Doc revision and reconstructs the
// compatible snapshot from the nearest retained checkpoint.
func (vs *VersionStore) GetDocRevisionDetail(docPath, revisionID string) (*models.DocVersion, error) {
	docPath = normalizeDocPath(docPath)
	entityID, ok, err := vs.historyStore().FindEntityByPathMetadata(context.Background(), "doc", docPath)
	if err != nil {
		return nil, err
	}
	if ok {
		records, _, err := vs.historyStore().ListMetadata(context.Background(), "doc", entityID, 0, 0)
		if err != nil {
			return nil, err
		}
		physical, err := resolveHistoryRecordRevision(records, revisionID)
		if err != nil {
			return nil, err
		}
		window, err := vs.historyStore().ReadRecordWindow(context.Background(), "doc", entityID, physical)
		if err != nil {
			return nil, err
		}
		history, err := docHistoryFromRecords(docPath, window)
		if err != nil {
			return nil, err
		}
		if len(history.Versions) == 0 {
			return nil, fmt.Errorf("revision %q not found", revisionID)
		}
		version := history.Versions[len(history.Versions)-1]
		return &version, nil
	}
	history, err := vs.GetDocHistory(docPath)
	if err != nil {
		return nil, err
	}
	for _, version := range history.Versions {
		if historyRevisionMatches(version.ID, version.Version, revisionID) {
			return &version, nil
		}
	}
	return nil, fmt.Errorf("revision %q not found", revisionID)
}

// GetDocRevision is a concise alias for GetDocRevisionDetail.
func (vs *VersionStore) GetDocRevision(docPath, revisionID string) (*models.DocVersion, error) {
	return vs.GetDocRevisionDetail(docPath, revisionID)
}

func historyRecordFromTaskVersion(taskID string, version models.TaskVersion) models.HistoryRecord {
	return models.HistoryRecord{SchemaVersion: version.SchemaVersion, EntityType: "task", EntityID: taskID, Revision: version.Version, LegacyRevision: version.Version, LegacyID: version.ID, Timestamp: version.Timestamp, Author: version.Author, Source: version.Source, SessionID: version.SessionID, BatchID: version.BatchID, Operation: version.Operation, Tombstone: version.Tombstone, LifecycleID: version.LifecycleEventID, BaseHash: version.BaseHash, NewHash: version.NewHash, Checkpoint: version.Checkpoint, LegacyUnverified: version.LegacyUnverified, LegacyPath: version.LegacyPath, LegacyDigest: version.LegacyDigest}
}

func historyRecordFromDocVersion(docID string, version models.DocVersion) models.HistoryRecord {
	return models.HistoryRecord{SchemaVersion: version.SchemaVersion, EntityType: "doc", EntityID: firstNonEmpty(docID, version.DocID), Revision: version.Version, LegacyRevision: version.Version, LegacyID: version.ID, Timestamp: version.Timestamp, Author: version.Author, Actor: version.Actor, Source: version.Source, AuditEventID: version.AuditEventID, SessionID: version.SessionID, BatchID: version.BatchID, Operation: version.Operation, Tombstone: version.Tombstone, BaseHash: version.BaseHash, NewHash: version.NewHash, Checkpoint: version.Checkpoint, LegacyUnverified: version.LegacyUnverified, LegacyPath: version.LegacyPath, LegacyDigest: version.LegacyDigest, CurrentPath: version.CurrentPath, PreviousPath: version.PreviousPath}
}

func historyMetadataPage(records []models.HistoryRecord, offset, limit int) *models.HistoryMetadataPage {
	if offset < 0 {
		offset = 0
	}
	if limit < 0 {
		limit = 0
	}
	items := make([]models.HistoryMetadata, 0, len(records))
	current := 0
	for i := len(records) - 1; i >= 0; i-- {
		record := records[i]
		logical := firstPositive(record.LegacyRevision, record.Revision)
		if logical > current {
			current = logical
		}
		items = append(items, historyMetadataFromRecord(record))
	}
	if offset > len(items) {
		offset = len(items)
	}
	end := len(items)
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	page := &models.HistoryMetadataPage{Offset: offset, Limit: limit, HasMore: end < len(items), CurrentVersion: current, Items: items[offset:end]}
	if len(records) > 0 {
		page.EntityType = records[0].EntityType
		page.EntityID = records[0].EntityID
		page.CurrentPath = records[len(records)-1].CurrentPath
		page.DocPath = page.CurrentPath
		for _, record := range records {
			if record.CurrentPath != "" {
				page.CurrentPath = record.CurrentPath
				page.DocPath = record.CurrentPath
			}
			page.RetentionGaps = append(page.RetentionGaps, record.RetentionGaps...)
		}
	}
	if page.HasMore {
		next := end
		page.NextOffset = &next
	}
	return page
}

func historyMetadataFromRecord(record models.HistoryRecord) models.HistoryMetadata {
	return models.HistoryMetadata{SchemaVersion: record.SchemaVersion, EntityType: record.EntityType, EntityID: record.EntityID, Revision: record.Revision, ID: firstNonEmpty(record.LegacyID, fmt.Sprintf("v%d", firstPositive(record.LegacyRevision, record.Revision))), Timestamp: record.Timestamp, Author: record.Author, Actor: record.Actor, Source: record.Source, AuditEventID: record.AuditEventID, SessionID: record.SessionID, BatchID: record.BatchID, Operation: record.Operation, Tombstone: record.Tombstone, LifecycleID: record.LifecycleID, BaseHash: record.BaseHash, NewHash: record.NewHash, PrevRecordHash: record.PrevRecordHash, RecordHash: record.RecordHash, Checkpoint: record.Checkpoint, LegacyRevision: record.LegacyRevision, LegacyID: record.LegacyID, Legacy: record.Legacy, LegacyUnverified: record.LegacyUnverified, LegacyPath: record.LegacyPath, LegacyDigest: record.LegacyDigest, RetentionGaps: append([]models.DocHistoryGap(nil), record.RetentionGaps...), CurrentPath: record.CurrentPath, PreviousPath: record.PreviousPath}
}

func resolveHistoryRecordRevision(records []models.HistoryRecord, revisionID string) (int, error) {
	for _, record := range records {
		if historyRevisionMatches(record.LegacyID, firstPositive(record.LegacyRevision, record.Revision), revisionID) || historyRevisionMatches(fmt.Sprintf("v%d", record.Revision), record.Revision, revisionID) {
			return record.Revision, nil
		}
	}
	return 0, fmt.Errorf("revision %q not found", revisionID)
}

func historyRevisionMatches(id string, version int, requested string) bool {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return false
	}
	if requested == id || requested == fmt.Sprintf("v%d", version) || requested == strconv.Itoa(version) {
		return true
	}
	if strings.HasPrefix(requested, "v") {
		requested = strings.TrimPrefix(requested, "v")
	}
	n, err := strconv.Atoi(requested)
	return err == nil && n == version
}

// SaveDocVersion appends a new version entry and updates CurrentVersion.
func (vs *VersionStore) SaveDocVersion(docPath string, version models.DocVersion) error {
	docPath = normalizeDocPath(docPath)
	if err := vs.migrateLegacyDocPaths(docPath); err != nil {
		return err
	}
	h, err := vs.docHistoryForWrite(docPath, "")
	if err != nil {
		return err
	}
	if version.NewHash == "" && len(version.Snapshot) > 0 {
		version.NewHash = hashSnapshot(version.Snapshot)
	}
	if len(version.ChangedScopes) == 0 {
		version.ChangedScopes = docChangeScopes(version.Changes)
	}
	return vs.appendDocVersion(h, "", version)
}

// SaveDocRevision records a document creation/update/rename revision using a
// stable document identity. oldDoc may be nil for initial creation.
func (vs *VersionStore) SaveDocRevision(oldDoc, newDoc *models.Doc) error {
	return vs.SaveDocRevisionWithOptions(oldDoc, newDoc, DocRevisionOptions{})
}

// SaveDocRevisionWithOptions records a document revision with optional
// section attribution and light actor/source/audit metadata.
func (vs *VersionStore) SaveDocRevisionWithOptions(oldDoc, newDoc *models.Doc, opts DocRevisionOptions) error {
	if newDoc == nil {
		return fmt.Errorf("new doc is required")
	}

	canonicalBefore := newDoc
	if oldDoc != nil {
		canonicalBefore = oldDoc
	}
	if err := vs.migrateLegacyDocPathsWithCurrent(canonicalBefore, newDoc.Path, func() string {
		if oldDoc != nil {
			return oldDoc.Path
		}
		return ""
	}()); err != nil {
		return err
	}
	changes, scopes, contentScope := vs.trackDocChangesWithOptions(oldDoc, newDoc, opts)
	if oldDoc != nil && len(changes) == 0 {
		return nil
	}

	oldPath := ""
	baseHash := ""
	if oldDoc != nil {
		oldPath = normalizeDocPath(oldDoc.Path)
		baseHash = hashDoc(oldDoc)
	}
	currentPath := normalizeDocPath(newDoc.Path)

	h, err := vs.docHistoryForWrite(currentPath, oldPath)
	if err != nil {
		return err
	}
	// Canonical callers establish the frontmatter ID before entering history.
	// Keep direct VersionStore callers without an ID backward-compatible.
	if len(h.Versions) == 0 && newDoc.ID != "" {
		h.DocID = newDoc.ID
	}
	if h.DocID == "" {
		h.DocID = newDoc.ID
	}
	if len(h.Versions) > 0 {
		if oldDoc == nil {
			return fmt.Errorf("%w: nil old doc cannot append to existing history", ErrHistoryConflict)
		}
		head := h.Versions[len(h.Versions)-1]
		headState, err := resolveDocStateFromHistory(h, head.ID)
		if err != nil {
			return fmt.Errorf("reconstruct Doc history head: %w", err)
		}
		if expected := hashDoc(oldDoc); expected != hashDoc(headState) && !historyHasUnverifiedLegacy(h) {
			return &MutationConflictError{EntityType: "doc", EntityID: firstNonEmpty(newDoc.ID, h.DocID, newDoc.Path), ExpectedHash: expected, CurrentHash: hashDoc(headState)}
		}
	} else {
		// A history stream with no records must start with a self-contained
		// checkpoint. The caller's oldDoc hash is not a valid first-record
		// BaseHash because there is no prior history state to chain from.
		baseHash = ""
	}

	checkpoint := oldDoc == nil || len(h.Versions) == 0 || historyDeltaInefficient(changes, DocToSnapshot(newDoc)) || historyHasUnverifiedLegacy(h)
	version := models.DocVersion{
		CurrentPath:   currentPath,
		PreviousPath:  previousDocPath(oldPath, currentPath),
		Author:        opts.Actor,
		Actor:         opts.Actor,
		Source:        opts.Source,
		AuditEventID:  opts.AuditEventID,
		SessionID:     opts.SessionID,
		BaseHash:      baseHash,
		NewHash:       hashDoc(newDoc),
		Checkpoint:    checkpoint,
		Changes:       changes,
		ChangedScopes: scopes,
		Snapshot:      docRevisionSnapshot(newDoc, checkpoint, contentScope),
	}
	if oldDoc != nil {
		if checkpoint {
			version.NewHash = hashDoc(newDoc)
		} else {
			stateForHash := cloneDoc(oldDoc)
			if err := applyDocChangesToState(&stateForHash, models.HistoryRecord{
				DocChanges: changes, ChangedScopes: scopes, CurrentPath: currentPath,
			}); err != nil {
				return err
			}
			version.NewHash = hashSnapshot(DocToSnapshot(&stateForHash))
		}
	}

	if err := vs.appendDocVersion(h, oldPath, version); err != nil {
		return err
	}
	if opts.Retention != nil {
		_, err := vs.ApplyDocHistoryRetention(currentPath, *opts.Retention)
		return err
	}
	return nil
}

func (vs *VersionStore) appendDocVersion(h *models.DocVersionHistory, previousPath string, version models.DocVersion) error {
	version.DocID = h.DocID
	version.DocPath = h.CurrentPath
	if version.CurrentPath == "" {
		version.CurrentPath = h.CurrentPath
	}
	if version.Timestamp.IsZero() {
		version.Timestamp = time.Now().UTC()
	}

	var candidate *models.Doc
	baseHash := version.BaseHash
	if len(h.Versions) == 0 {
		if !version.Checkpoint || len(version.Snapshot) == 0 {
			return fmt.Errorf("%w: first Doc history record must be a checkpoint payload", ErrHistoryCorrupt)
		}
		candidate = &models.Doc{}
		applyDocSnapshot(candidate, version.Snapshot)
		if version.CurrentPath != "" {
			candidate.Path = normalizeDocPath(version.CurrentPath)
		}
		if baseHash != "" {
			return fmt.Errorf("%w: first Doc history record has a base hash", ErrHistoryCorrupt)
		}
	} else {
		head := h.Versions[len(h.Versions)-1]
		headState, err := resolveDocStateFromHistory(h, head.ID)
		if err != nil {
			return fmt.Errorf("reconstruct Doc history head: %w", err)
		}
		headHash := hashDoc(headState)
		if head.NewHash != "" && head.NewHash != headHash {
			return fmt.Errorf("%w: Doc history head hash mismatch", ErrHistoryCorrupt)
		}
		if baseHash == "" {
			baseHash = firstNonEmpty(head.NewHash, headHash)
		} else if baseHash != firstNonEmpty(head.NewHash, headHash) {
			return fmt.Errorf("%w: Doc history base hash does not match current head", ErrHistoryConflict)
		}
		if version.Checkpoint {
			if len(version.Snapshot) == 0 {
				return fmt.Errorf("%w: Doc checkpoint payload is required", ErrHistoryCorrupt)
			}
			candidate = &models.Doc{}
			applyDocSnapshot(candidate, version.Snapshot)
			if version.CurrentPath != "" {
				candidate.Path = normalizeDocPath(version.CurrentPath)
			}
		} else {
			candidate = headState
			if err := applyDocChangesToState(candidate, models.HistoryRecord{
				DocChanges: version.Changes, ChangedScopes: version.ChangedScopes, CurrentPath: version.CurrentPath,
			}); err != nil {
				return err
			}
		}
	}
	candidateHash := hashDoc(candidate)
	if version.NewHash != "" && version.NewHash != candidateHash {
		return fmt.Errorf("%w: Doc candidate hash does not match supplied NewHash", ErrHistoryCorrupt)
	}
	version.SchemaVersion = historySchemaVersion
	version.BaseHash = baseHash
	version.NewHash = candidateHash
	if version.Checkpoint {
		version.Snapshot = DocToSnapshot(candidate)
	}
	h.CurrentVersion++
	version.ID = fmt.Sprintf("v%d", h.CurrentVersion)
	version.Version = h.CurrentVersion
	h.Versions = append(h.Versions, version)
	h.DocPath = h.CurrentPath
	h.Versions[len(h.Versions)-1] = version
	jsonl := vs.hasJSONLHistory("doc", h.DocID)
	legacy := !jsonl && (fileExists(vs.stableDocVersionPath(h.DocID)) || fileExists(vs.legacyDocVersionPath(h.CurrentPath)))
	if jsonl || !legacy {
		if err := vs.historyStore().Append(context.Background(), models.HistoryRecord{
			EntityType: "doc", EntityID: h.DocID, Timestamp: version.Timestamp, Author: version.Author,
			Actor: version.Actor, Source: version.Source, AuditEventID: version.AuditEventID, SessionID: version.SessionID,
			BatchID: version.BatchID, BaseHash: version.BaseHash, NewHash: version.NewHash, Checkpoint: version.Checkpoint,
			DocChanges: append([]models.DocChange(nil), version.Changes...), ChangedScopes: append([]models.DocChangeScope(nil), version.ChangedScopes...),
			CurrentPath: firstNonEmpty(version.CurrentPath, version.DocPath), PreviousPath: version.PreviousPath,
			CheckpointPayload: cloneMapIf(version.Checkpoint, version.Snapshot),
		}); err != nil {
			return err
		}
		return nil
	}

	if err := os.MkdirAll(vs.versionsDir(), 0755); err != nil {
		return fmt.Errorf("mkdir versions: %w", err)
	}
	if err := writeJSON(vs.stableDocVersionPath(h.DocID), h); err != nil {
		return err
	}
	return vs.indexDocHistory(h.DocID, h.CurrentPath, previousPath)
}

// ResolveDocState reconstructs the document state represented by revisionID.
// An empty revisionID resolves the latest retained revision.
func (vs *VersionStore) ResolveDocState(docPath, revisionID string) (*models.Doc, error) {
	h, err := vs.GetDocHistory(docPath)
	if err != nil {
		return nil, err
	}
	return resolveDocStateFromHistory(h, revisionID)
}

// GetDocRevisionDiff returns the structured change set for a retained revision.
// An empty revisionID resolves to the latest retained revision.
func (vs *VersionStore) GetDocRevisionDiff(docPath, revisionID string) (*models.DocRevisionDiff, error) {
	h, err := vs.GetDocHistory(docPath)
	if err != nil {
		return nil, err
	}
	idx, err := findDocVersionIndex(h, revisionID)
	if err != nil {
		return nil, err
	}
	version := h.Versions[idx]
	previousID := ""
	if idx > 0 {
		previousID = h.Versions[idx-1].ID
	}
	return &models.DocRevisionDiff{
		DocID:              h.DocID,
		DocPath:            h.DocPath,
		CurrentPath:        h.CurrentPath,
		RevisionID:         version.ID,
		PreviousRevisionID: previousID,
		Version:            version,
		Checkpoint:         version.Checkpoint,
		Changes:            version.Changes,
		ChangedScopes:      version.ChangedScopes,
		RetentionGaps:      h.RetentionGaps,
	}, nil
}

// ApplyDocHistoryRetention purges old retained detail while converting the
// first retained revision into a checkpoint so retained history stays restorable.
func (vs *VersionStore) ApplyDocHistoryRetention(docPath string, policy DocHistoryRetentionPolicy) (*models.DocVersionHistory, error) {
	if history, ok, err := vs.readDocJSONL(normalizeDocPath(docPath)); ok {
		if err != nil {
			return nil, err
		}
		retention := HistoryRetentionPolicy{MaxDetailedRevisions: policy.MaxVersions, MaxDetailedAge: policy.MaxAge, Now: policy.Now, Reason: retentionReason(policy)}
		if err := vs.historyStore().Compact(context.Background(), "doc", history.DocID, retention); err != nil {
			return nil, err
		}
		return vs.GetDocHistory(docPath)
	}
	h, err := vs.GetDocHistory(docPath)
	if err != nil {
		return nil, err
	}
	if len(h.Versions) == 0 {
		return h, nil
	}

	now := policy.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}

	removeBefore := 0
	if policy.MaxAge > 0 {
		cutoff := now.Add(-policy.MaxAge)
		for i, version := range h.Versions {
			if !version.Timestamp.IsZero() && version.Timestamp.Before(cutoff) {
				removeBefore = i + 1
			}
		}
	}
	if policy.MaxVersions > 0 && len(h.Versions)-removeBefore > policy.MaxVersions {
		byCount := len(h.Versions) - policy.MaxVersions
		if byCount > removeBefore {
			removeBefore = byCount
		}
	}
	if removeBefore <= 0 {
		return h, nil
	}
	if removeBefore >= len(h.Versions) {
		removeBefore = len(h.Versions) - 1
	}

	firstRetainedID := h.Versions[removeBefore].ID
	firstRetainedState, err := resolveDocStateFromHistory(h, firstRetainedID)
	if err != nil {
		return nil, err
	}

	removed := h.Versions[:removeBefore]
	retained := append([]models.DocVersion(nil), h.Versions[removeBefore:]...)
	retained[0].Checkpoint = true
	retained[0].Snapshot = DocToSnapshot(firstRetainedState)
	if retained[0].NewHash == "" {
		retained[0].NewHash = hashDoc(firstRetainedState)
	}

	h.Versions = retained
	h.RetentionGaps = append(h.RetentionGaps, models.DocHistoryGap{
		Type:          "purged",
		Reason:        retentionReason(policy),
		Count:         len(removed),
		BeforeVersion: removed[len(removed)-1].ID,
		AfterVersion:  retained[0].ID,
		AppliedAt:     now,
	})
	normalizeDocHistory(h, h.DocID, h.CurrentPath)

	if err := os.MkdirAll(vs.versionsDir(), 0755); err != nil {
		return nil, fmt.Errorf("mkdir versions: %w", err)
	}
	if err := writeJSON(vs.stableDocVersionPath(h.DocID), h); err != nil {
		return nil, err
	}
	if err := vs.indexDocHistory(h.DocID, h.CurrentPath, ""); err != nil {
		return nil, err
	}
	return h, nil
}

// ApplyTaskHistoryRetention compacts an active Task JSONL stream using the
// same bounded policy as Docs. Legacy Task JSON is migrated first so cleanup
// remains an explicit, separate operation.
func (vs *VersionStore) ApplyTaskHistoryRetention(taskID string, policy HistoryRetentionPolicy) (*models.TaskVersionHistory, error) {
	if err := vs.migrateLegacyTask(taskID); err != nil {
		return nil, err
	}
	if err := vs.historyStore().Compact(context.Background(), "task", taskID, policy); err != nil {
		return nil, err
	}
	return vs.GetHistory(taskID)
}

func (vs *VersionStore) MigrateLegacyTaskHistory(ctx context.Context, taskID string) error {
	if vs.hasJSONLHistory("task", taskID) {
		return nil
	}
	path := vs.versionPath(taskID)
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var legacy models.TaskVersionHistory
	if err := json.Unmarshal(data, &legacy); err != nil {
		return err
	}
	return vs.historyStore().MigrateLegacyTask(ctx, path, taskID, &legacy)
}

func (vs *VersionStore) MigrateLegacyDocHistory(ctx context.Context, docPath string) error {
	current, err := (&DocStore{root: vs.root}).Get(normalizeDocPath(docPath))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return vs.migrateLegacyDocPathsWithCurrent(current, docPath)
}

func retentionReason(policy DocHistoryRetentionPolicy) string {
	switch {
	case policy.MaxVersions > 0 && policy.MaxAge > 0:
		return "max_versions_and_max_age"
	case policy.MaxVersions > 0:
		return "max_versions"
	case policy.MaxAge > 0:
		return "max_age"
	default:
		return "manual"
	}
}

// RestoreDocSection restores one section from a retained revision and records a
// normal follow-up revision. The current document path is not changed.
func (s *Store) RestoreDocSection(path, revisionID, section string, opts DocRevisionOptions) (*models.Doc, error) {
	current, err := s.Docs.Get(path)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(section) == "" {
		section, err = s.Versions.sectionForRevision(path, revisionID)
		if err != nil {
			return nil, err
		}
	}

	historical, err := s.Versions.ResolveDocState(path, revisionID)
	if err != nil {
		return nil, err
	}
	historicalSection, ok := findMarkdownSection(historical.Content, section)
	if !ok {
		return nil, fmt.Errorf("section %q not found in revision %s", section, revisionID)
	}

	restoredContent, ok := replaceMarkdownSection(current.Content, section, historicalSection.Text)
	if !ok {
		return nil, fmt.Errorf("section %q not found in current doc", section)
	}

	oldDoc := *current
	restored := *current
	restored.Content = restoredContent
	restored.UpdatedAt = time.Now().UTC()
	opts.Section = firstNonEmpty(opts.Section, section)
	if opts.Actor == "" {
		opts.Actor = "restore"
	}
	if opts.Source == "" {
		opts.Source = "restore"
	}
	if err := s.MutateDocWithHistory(context.Background(), &oldDoc, &restored, DocMutationOptions{
		Actor: opts.Actor, Source: opts.Source, Section: opts.Section, ExpectedHash: opts.ExpectedHash,
	}); err != nil {
		return nil, err
	}
	return &restored, nil
}

// RestoreDoc restores content and metadata from a retained revision while
// keeping the current path stable. It records a normal follow-up revision.
func (s *Store) RestoreDoc(path, revisionID string, opts DocRevisionOptions) (*models.Doc, error) {
	current, err := s.Docs.Get(path)
	if err != nil {
		return nil, err
	}
	historical, err := s.Versions.ResolveDocState(path, revisionID)
	if err != nil {
		return nil, err
	}

	oldDoc := *current
	restored := *current
	restored.Title = historical.Title
	restored.Description = historical.Description
	restored.Tags = append([]string(nil), historical.Tags...)
	restored.Content = historical.Content
	restored.UpdatedAt = time.Now().UTC()
	if opts.Actor == "" {
		opts.Actor = "restore"
	}
	if opts.Source == "" {
		opts.Source = "restore"
	}
	if err := s.MutateDocWithHistory(context.Background(), &oldDoc, &restored, DocMutationOptions{
		Actor: opts.Actor, Source: opts.Source, ExpectedHash: opts.ExpectedHash,
	}); err != nil {
		return nil, err
	}
	return &restored, nil
}

// TrackDocChanges compares two Doc values and returns the list of changed fields.
// oldDoc may be nil (for the initial creation version).
func (vs *VersionStore) TrackDocChanges(oldDoc, newDoc *models.Doc) []models.DocChange {
	changes, _, _ := vs.trackDocChangesWithOptions(oldDoc, newDoc, DocRevisionOptions{})
	return changes
}

func (vs *VersionStore) trackDocChangesWithOptions(oldDoc, newDoc *models.Doc, opts DocRevisionOptions) ([]models.DocChange, []models.DocChangeScope, docContentScope) {
	var changes []models.DocChange
	var scopes []models.DocChangeScope
	var contentScope docContentScope
	addChange := func(change models.DocChange, scope models.DocChangeScope) {
		changes = append(changes, change)
		scopes = append(scopes, scope)
	}

	if oldDoc == nil {
		if newDoc.ID != "" {
			addChange(models.DocChange{Field: "id", NewValue: newDoc.ID}, fieldDocChangeScope("id", "", newDoc.ID))
		}
		if newDoc.Path != "" {
			value := normalizeDocPath(newDoc.Path)
			addChange(models.DocChange{Field: "path", NewValue: value}, fieldDocChangeScope("path", "", value))
		}
		if newDoc.Title != "" {
			addChange(models.DocChange{Field: "title", NewValue: newDoc.Title}, fieldDocChangeScope("title", "", newDoc.Title))
		}
		if newDoc.Description != "" {
			addChange(models.DocChange{Field: "description", NewValue: newDoc.Description}, fieldDocChangeScope("description", "", newDoc.Description))
		}
		if newDoc.Content != "" {
			scope := wholeDocChangeScope("", newDoc.Content)
			contentScope = docContentScope{scope: scope, new: newDoc.Content, ok: true}
			addChange(models.DocChange{Field: "content", NewValue: newDoc.Content}, scope)
		}
		if len(newDoc.Tags) > 0 {
			addChange(models.DocChange{Field: "tags", NewValue: newDoc.Tags}, fieldDocChangeScope("tags", nil, newDoc.Tags))
		}
		return dedupeDocChanges(changes), dedupeDocChangeScopes(scopes), contentScope
	}

	diff := func(field string, old, newVal any) {
		if !reflect.DeepEqual(old, newVal) {
			ch := models.DocChange{Field: field}
			if !isZero(old) {
				ch.OldValue = old
			}
			if !isZero(newVal) {
				ch.NewValue = newVal
			}
			addChange(ch, fieldDocChangeScope(field, old, newVal))
		}
	}

	diff("path", normalizeDocPath(oldDoc.Path), normalizeDocPath(newDoc.Path))
	diff("id", oldDoc.ID, newDoc.ID)
	diff("title", oldDoc.Title, newDoc.Title)
	diff("description", oldDoc.Description, newDoc.Description)
	if oldDoc.Content != newDoc.Content {
		contentScope = resolveContentChangeScope(oldDoc.Content, newDoc.Content, opts.Section)
		if contentScope.ok && contentScope.scope.Type == "section" {
			addChange(models.DocChange{Field: "content", OldValue: contentScope.old, NewValue: contentScope.new}, contentScope.scope)
		} else {
			scope := wholeDocChangeScope(oldDoc.Content, newDoc.Content)
			contentScope = docContentScope{scope: scope, old: oldDoc.Content, new: newDoc.Content, ok: true}
			addChange(models.DocChange{Field: "content", OldValue: oldDoc.Content, NewValue: newDoc.Content}, scope)
		}
	}
	diff("tags", oldDoc.Tags, newDoc.Tags)

	return dedupeDocChanges(changes), dedupeDocChangeScopes(scopes), contentScope
}

// DocToSnapshot converts a Doc to a generic map snapshot.
func DocToSnapshot(doc *models.Doc) map[string]any {
	snap := map[string]any{
		"path":  normalizeDocPath(doc.Path),
		"title": doc.Title,
	}
	if doc.ID != "" {
		snap["id"] = doc.ID
	}
	if doc.Description != "" {
		snap["description"] = doc.Description
	}
	if doc.Content != "" {
		snap["content"] = doc.Content
	}
	if len(doc.Tags) > 0 {
		snap["tags"] = doc.Tags
	}
	return snap
}

func docRevisionSnapshot(doc *models.Doc, checkpoint bool, contentScope docContentScope) map[string]any {
	snap := DocToSnapshot(doc)
	if checkpoint {
		return snap
	}
	if !contentScope.ok || contentScope.scope.Type == "section" {
		delete(snap, "content")
	}
	return snap
}

func resolveDocStateFromHistory(h *models.DocVersionHistory, revisionID string) (*models.Doc, error) {
	if h == nil || len(h.Versions) == 0 {
		return nil, fmt.Errorf("doc history is empty")
	}

	target := strings.TrimSpace(revisionID)
	state := &models.Doc{Path: firstNonEmpty(h.DocPath, h.CurrentPath), Tags: []string{}}
	var last *models.Doc

	for _, version := range h.Versions {
		applyDocVersionState(state, version)
		clone := cloneDoc(state)
		last = &clone
		if target == "" || version.ID == target || fmt.Sprintf("%d", version.Version) == target || fmt.Sprintf("v%d", version.Version) == target {
			if target == "" {
				continue
			}
			return &clone, nil
		}
	}

	if target == "" && last != nil {
		return last, nil
	}
	return nil, fmt.Errorf("revision %q not found", revisionID)
}

func findDocVersionIndex(h *models.DocVersionHistory, revisionID string) (int, error) {
	if h == nil || len(h.Versions) == 0 {
		return -1, fmt.Errorf("doc history is empty")
	}
	target := strings.TrimSpace(revisionID)
	if target == "" {
		return len(h.Versions) - 1, nil
	}
	for i, version := range h.Versions {
		if version.ID == target || fmt.Sprintf("%d", version.Version) == target || fmt.Sprintf("v%d", version.Version) == target {
			return i, nil
		}
	}
	return -1, fmt.Errorf("revision %q not found", revisionID)
}

func applyDocVersionState(state *models.Doc, version models.DocVersion) {
	applyDocSnapshot(state, version.Snapshot)

	for _, change := range version.Changes {
		switch change.Field {
		case "path":
			if v, ok := change.NewValue.(string); ok && v != "" {
				state.Path = normalizeDocPath(v)
			} else if version.CurrentPath != "" {
				state.Path = normalizeDocPath(version.CurrentPath)
			}
		case "id":
			if v, ok := change.NewValue.(string); ok {
				state.ID = v
			}
		case "title":
			if v, ok := change.NewValue.(string); ok {
				state.Title = v
			}
		case "description":
			if v, ok := change.NewValue.(string); ok {
				state.Description = v
			}
		case "content":
			if isSectionContentChange(version) {
				section := firstSectionScope(version)
				if v, ok := change.NewValue.(string); ok && section != "" {
					if restored, replaced := replaceMarkdownSection(state.Content, section, v); replaced {
						state.Content = restored
					}
				}
			} else if v, ok := change.NewValue.(string); ok {
				state.Content = v
			}
		case "tags":
			state.Tags = anyStringSlice(change.NewValue)
		}
	}

	if version.CurrentPath != "" {
		state.Path = normalizeDocPath(version.CurrentPath)
	}
}

func applyDocSnapshot(state *models.Doc, snapshot map[string]any) {
	if len(snapshot) == 0 {
		return
	}
	if v, ok := snapshot["path"].(string); ok && v != "" {
		state.Path = normalizeDocPath(v)
	}
	if v, ok := snapshot["id"].(string); ok {
		state.ID = v
	}
	if v, ok := snapshot["title"].(string); ok {
		state.Title = v
	}
	if v, ok := snapshot["description"].(string); ok {
		state.Description = v
	}
	if v, ok := snapshot["content"].(string); ok {
		state.Content = v
	}
	if tags := anyStringSlice(snapshot["tags"]); tags != nil {
		state.Tags = tags
	}
}

func cloneDoc(doc *models.Doc) models.Doc {
	clone := *doc
	clone.Tags = append([]string(nil), doc.Tags...)
	return clone
}

func anyStringSlice(value any) []string {
	switch v := value.(type) {
	case nil:
		return nil
	case []string:
		return append([]string(nil), v...)
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func isSectionContentChange(version models.DocVersion) bool {
	return firstSectionScope(version) != ""
}

func firstSectionScope(version models.DocVersion) string {
	for _, scope := range version.ChangedScopes {
		if scope.Type == "section" && scope.Field == "content" && scope.Section != "" {
			return scope.Section
		}
	}
	return ""
}

func (vs *VersionStore) sectionForRevision(docPath, revisionID string) (string, error) {
	h, err := vs.GetDocHistory(docPath)
	if err != nil {
		return "", err
	}
	target := strings.TrimSpace(revisionID)
	for _, version := range h.Versions {
		if target != "" && version.ID != target && fmt.Sprintf("%d", version.Version) != target && fmt.Sprintf("v%d", version.Version) != target {
			continue
		}
		if section := firstSectionScope(version); section != "" {
			return section, nil
		}
		if target != "" {
			break
		}
	}
	return "", fmt.Errorf("revision %q does not identify a single section", revisionID)
}

func (vs *VersionStore) docHistoryForWrite(currentPath, previousPath string) (*models.DocVersionHistory, error) {
	currentPath = normalizeDocPath(currentPath)
	previousPath = normalizeDocPath(previousPath)
	if currentPath == "" {
		return nil, fmt.Errorf("doc path is required")
	}
	if h, ok, err := vs.readDocJSONL(currentPath); ok || err != nil {
		if err != nil {
			return nil, err
		}
		normalizeDocHistory(h, h.DocID, currentPath)
		return h, nil
	}
	if previousPath != "" {
		if h, ok, err := vs.readDocJSONL(previousPath); ok || err != nil {
			if err != nil {
				return nil, err
			}
			normalizeDocHistory(h, h.DocID, currentPath)
			return h, nil
		}
	}

	if h, ok, err := vs.loadStableDocHistoryForAnyPath(currentPath, previousPath); ok || err != nil {
		if h != nil {
			normalizeDocHistory(h, h.DocID, currentPath)
		}
		return h, err
	}

	for _, legacyPath := range compactDocPaths(previousPath, currentPath) {
		h, ok, err := vs.loadLegacyDocHistory(legacyPath)
		if err != nil {
			return nil, err
		}
		if ok {
			normalizeDocHistory(h, h.DocID, currentPath)
			return h, nil
		}
	}

	return &models.DocVersionHistory{
		DocID:          newDocID(),
		DocPath:        currentPath,
		CurrentPath:    currentPath,
		CurrentVersion: 0,
		Versions:       []models.DocVersion{},
	}, nil
}

func (vs *VersionStore) loadStableDocHistoryForPath(docPath string) (*models.DocVersionHistory, bool, error) {
	return vs.loadStableDocHistoryForAnyPath(docPath)
}

func (vs *VersionStore) loadStableDocHistoryForAnyPath(paths ...string) (*models.DocVersionHistory, bool, error) {
	idx, err := vs.loadDocVersionIndex()
	if err != nil {
		return nil, false, err
	}

	for _, path := range compactDocPaths(paths...) {
		if docID := idx.Paths[path]; docID != "" {
			h, err := vs.loadStableDocHistoryByID(docID)
			if err != nil {
				if os.IsNotExist(err) {
					continue
				}
				return nil, true, err
			}
			return h, true, nil
		}
	}

	h, ok, err := vs.scanStableDocHistoryForPath(paths...)
	if ok || err != nil {
		return h, ok, err
	}
	return nil, false, nil
}

func (vs *VersionStore) loadStableDocHistoryByID(docID string) (*models.DocVersionHistory, error) {
	data, err := os.ReadFile(vs.stableDocVersionPath(docID))
	if err != nil {
		return nil, err
	}
	var h models.DocVersionHistory
	if err := json.Unmarshal(data, &h); err != nil {
		return nil, fmt.Errorf("parse doc version history %s: %w", docID, err)
	}
	normalizeDocHistory(&h, docID, "")
	return &h, nil
}

func (vs *VersionStore) scanStableDocHistoryForPath(paths ...string) (*models.DocVersionHistory, bool, error) {
	want := map[string]bool{}
	for _, path := range compactDocPaths(paths...) {
		want[path] = true
	}
	if len(want) == 0 {
		return nil, false, nil
	}

	entries, err := os.ReadDir(vs.versionsDir())
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read versions dir: %w", err)
	}

	var match *models.DocVersionHistory
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "docid-") || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(vs.versionsDir(), e.Name()))
		if err != nil {
			continue
		}
		var h models.DocVersionHistory
		if err := json.Unmarshal(data, &h); err != nil {
			continue
		}
		normalizeDocHistory(&h, h.DocID, "")
		if docHistoryContainsPath(&h, want) {
			if match != nil && match.DocID != h.DocID {
				return nil, true, fmt.Errorf("ambiguous Doc history candidates for path %q; repair stable history index before mutating", firstNonEmpty(paths...))
			}
			copy := h
			match = &copy
		}
	}
	if match != nil {
		return match, true, nil
	}
	return nil, false, nil
}

func (vs *VersionStore) loadLegacyDocHistory(docPath string) (*models.DocVersionHistory, bool, error) {
	docPath = normalizeDocPath(docPath)
	if docPath == "" {
		return nil, false, nil
	}

	data, err := os.ReadFile(vs.legacyDocVersionPath(docPath))
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, true, fmt.Errorf("read doc version history %s: %w", docPath, err)
	}
	var h models.DocVersionHistory
	if err := json.Unmarshal(data, &h); err != nil {
		return nil, true, fmt.Errorf("parse doc version history %s: %w", docPath, err)
	}
	if h.DocID == "" {
		h.DocID = legacyDocID(docPath)
	}
	normalizeDocHistory(&h, h.DocID, docPath)
	return &h, true, nil
}

func (vs *VersionStore) loadDocVersionIndex() (docVersionIndex, error) {
	idx := docVersionIndex{Paths: map[string]string{}}
	data, err := os.ReadFile(vs.docVersionIndexPath())
	if os.IsNotExist(err) {
		return idx, nil
	}
	if err != nil {
		return idx, fmt.Errorf("read doc version index: %w", err)
	}
	if err := json.Unmarshal(data, &idx); err != nil {
		return idx, fmt.Errorf("parse doc version index: %w", err)
	}
	if idx.Paths == nil {
		idx.Paths = map[string]string{}
	}
	return idx, nil
}

func (vs *VersionStore) indexDocHistory(docID, currentPath, previousPath string) error {
	idx, err := vs.loadDocVersionIndex()
	if err != nil {
		return err
	}
	currentPath = normalizeDocPath(currentPath)
	previousPath = normalizeDocPath(previousPath)
	if previousPath != "" && previousPath != currentPath {
		delete(idx.Paths, previousPath)
	}
	idx.Paths[currentPath] = docID
	if err := os.MkdirAll(vs.versionsDir(), 0755); err != nil {
		return fmt.Errorf("mkdir versions: %w", err)
	}
	return writeJSON(vs.docVersionIndexPath(), idx)
}

func normalizeDocHistory(h *models.DocVersionHistory, docID, currentPath string) {
	if h.Versions == nil {
		h.Versions = []models.DocVersion{}
	}
	if h.DocID == "" {
		h.DocID = docID
	}
	if h.DocID == "" {
		h.DocID = legacyDocID(firstNonEmpty(currentPath, h.CurrentPath, h.DocPath))
	}
	if currentPath != "" {
		h.CurrentPath = currentPath
		h.DocPath = currentPath
	} else {
		h.CurrentPath = firstNonEmpty(h.CurrentPath, h.DocPath)
		h.DocPath = firstNonEmpty(h.DocPath, h.CurrentPath)
	}
	if h.CurrentVersion == 0 && len(h.Versions) > 0 {
		h.CurrentVersion = h.Versions[len(h.Versions)-1].Version
		if h.CurrentVersion == 0 {
			h.CurrentVersion = len(h.Versions)
		}
	}

	for i := range h.Versions {
		v := &h.Versions[i]
		if v.DocID == "" {
			v.DocID = h.DocID
		}
		if v.DocPath == "" {
			v.DocPath = firstNonEmpty(v.CurrentPath, h.CurrentPath, h.DocPath)
		}
		if v.CurrentPath == "" {
			v.CurrentPath = v.DocPath
		}
		if len(v.ChangedScopes) == 0 {
			v.ChangedScopes = docChangeScopes(v.Changes)
		}
	}
}

func docHistoryContainsPath(h *models.DocVersionHistory, paths map[string]bool) bool {
	if paths[normalizeDocPath(h.CurrentPath)] || paths[normalizeDocPath(h.DocPath)] {
		return true
	}
	for _, v := range h.Versions {
		if paths[normalizeDocPath(v.CurrentPath)] || paths[normalizeDocPath(v.DocPath)] || paths[normalizeDocPath(v.PreviousPath)] {
			return true
		}
	}
	return false
}

func docChangeScopes(changes []models.DocChange) []models.DocChangeScope {
	if len(changes) == 0 {
		return nil
	}

	seen := map[string]bool{}
	var scopes []models.DocChangeScope
	add := func(scope models.DocChangeScope) {
		key := scope.Type + ":" + scope.Field + ":" + scope.Section
		if seen[key] {
			return
		}
		seen[key] = true
		scopes = append(scopes, scope)
	}

	for _, change := range changes {
		switch change.Field {
		case "content":
			add(models.DocChangeScope{Type: "whole_doc", Field: "content", Summary: "Whole document content"})
		case "path":
			add(models.DocChangeScope{Type: "path", Field: "path", Summary: "Document path"})
		default:
			add(models.DocChangeScope{Type: "field", Field: change.Field, Summary: change.Field})
		}
	}
	return scopes
}

func fieldDocChangeScope(field string, old, newVal any) models.DocChangeScope {
	oldBytes := valueByteLen(old)
	newBytes := valueByteLen(newVal)
	scopeType := "field"
	if field == "path" {
		scopeType = "path"
	}
	return models.DocChangeScope{
		Type:       scopeType,
		Field:      field,
		Summary:    field,
		OldBytes:   oldBytes,
		NewBytes:   newBytes,
		DeltaBytes: newBytes - oldBytes,
	}
}

func wholeDocChangeScope(oldContent, newContent string) models.DocChangeScope {
	oldBytes := len([]byte(oldContent))
	newBytes := len([]byte(newContent))
	return models.DocChangeScope{
		Type:       "whole_doc",
		Field:      "content",
		Summary:    "Whole document content",
		OldBytes:   oldBytes,
		NewBytes:   newBytes,
		DeltaBytes: newBytes - oldBytes,
	}
}

func sectionDocChangeScope(section, oldContent, newContent string) models.DocChangeScope {
	oldBytes := len([]byte(oldContent))
	newBytes := len([]byte(newContent))
	return models.DocChangeScope{
		Type:       "section",
		Field:      "content",
		Section:    section,
		Summary:    "Section: " + section,
		OldBytes:   oldBytes,
		NewBytes:   newBytes,
		DeltaBytes: newBytes - oldBytes,
	}
}

func valueByteLen(value any) int {
	if value == nil || isZero(value) {
		return 0
	}
	data, err := json.Marshal(value)
	if err != nil {
		return len([]byte(fmt.Sprint(value)))
	}
	return len(data)
}

func dedupeDocChanges(changes []models.DocChange) []models.DocChange {
	if len(changes) <= 1 {
		return changes
	}
	seen := map[string]bool{}
	out := make([]models.DocChange, 0, len(changes))
	for _, change := range changes {
		if seen[change.Field] {
			continue
		}
		seen[change.Field] = true
		out = append(out, change)
	}
	return out
}

func dedupeDocChangeScopes(scopes []models.DocChangeScope) []models.DocChangeScope {
	if len(scopes) <= 1 {
		return scopes
	}
	seen := map[string]bool{}
	out := make([]models.DocChangeScope, 0, len(scopes))
	for _, scope := range scopes {
		key := scope.Type + ":" + scope.Field + ":" + scope.Section
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, scope)
	}
	return out
}

type docMarkdownSection struct {
	Index int
	Level int
	Title string
	Text  string
	Start int
	End   int
}

func resolveContentChangeScope(oldContent, newContent, sectionRef string) docContentScope {
	if sectionRef != "" {
		oldSection, oldOK := findMarkdownSection(oldContent, sectionRef)
		newSection, newOK := findMarkdownSection(newContent, sectionRef)
		if oldOK && newOK {
			title := firstNonEmpty(newSection.Title, oldSection.Title, strings.TrimSpace(sectionRef))
			scope := docContentScope{
				scope: sectionDocChangeScope(title, oldSection.Text, newSection.Text),
				old:   oldSection.Text,
				new:   newSection.Text,
				ok:    true,
			}
			if reconstructed, replaced := replaceMarkdownSection(oldContent, title, newSection.Text); replaced && reconstructed == newContent {
				return scope
			}
		}
	}

	oldSections := docMarkdownSections(oldContent)
	newSections := docMarkdownSections(newContent)
	if len(oldSections) == 0 || len(oldSections) != len(newSections) {
		return docContentScope{}
	}

	changed := -1
	for i := range oldSections {
		if oldSections[i].Level != newSections[i].Level || !strings.EqualFold(oldSections[i].Title, newSections[i].Title) {
			return docContentScope{}
		}
		if oldSections[i].Text != newSections[i].Text {
			if changed != -1 {
				return docContentScope{}
			}
			changed = i
		}
	}
	if changed == -1 {
		return docContentScope{}
	}

	oldSection := oldSections[changed]
	newSection := newSections[changed]
	return docContentScope{
		scope: sectionDocChangeScope(newSection.Title, oldSection.Text, newSection.Text),
		old:   oldSection.Text,
		new:   newSection.Text,
		ok:    true,
	}
}

func findMarkdownSection(content, sectionRef string) (docMarkdownSection, bool) {
	sections := docMarkdownSections(content)
	if len(sections) == 0 {
		return docMarkdownSection{}, false
	}

	ref := strings.TrimSpace(strings.TrimLeft(sectionRef, "# "))
	for _, section := range sections {
		if fmt.Sprintf("%d", section.Index) == ref ||
			strings.EqualFold(section.Title, ref) ||
			strings.Contains(strings.ToLower(section.Title), strings.ToLower(ref)) {
			return section, true
		}
	}
	return docMarkdownSection{}, false
}

func docMarkdownSections(content string) []docMarkdownSection {
	lines := strings.Split(content, "\n")
	var sections []docMarkdownSection
	for i, line := range lines {
		if !strings.HasPrefix(line, "#") {
			continue
		}
		level := headingLevel(line)
		if level == 0 {
			continue
		}
		end := len(lines)
		for j := i + 1; j < len(lines); j++ {
			if nextLevel := headingLevel(lines[j]); nextLevel > 0 && nextLevel <= level {
				end = j
				break
			}
		}
		title := strings.TrimSpace(line[level:])
		if title == "" {
			continue
		}
		sections = append(sections, docMarkdownSection{
			Index: len(sections) + 1,
			Level: level,
			Title: title,
			Text:  strings.TrimSpace(strings.Join(lines[i:end], "\n")),
			Start: i,
			End:   end,
		})
	}
	return sections
}

func replaceMarkdownSection(content, sectionRef, sectionContent string) (string, bool) {
	section, ok := findMarkdownSection(content, sectionRef)
	if !ok {
		return content, false
	}
	lines := strings.Split(content, "\n")
	replacementLines := strings.Split(sectionContent, "\n")
	currentSectionLines := lines[section.Start:section.End]
	for i := len(currentSectionLines) - 1; i >= 0 && strings.TrimSpace(currentSectionLines[i]) == ""; i-- {
		if len(replacementLines) == 0 || strings.TrimSpace(replacementLines[len(replacementLines)-1]) != "" {
			replacementLines = append(replacementLines, "")
		}
	}
	var result []string
	result = append(result, lines[:section.Start]...)
	result = append(result, replacementLines...)
	result = append(result, lines[section.End:]...)
	return strings.Join(result, "\n"), true
}

func headingLevel(line string) int {
	if !strings.HasPrefix(line, "#") {
		return 0
	}
	level := 0
	for _, r := range line {
		if r != '#' {
			break
		}
		level++
	}
	if level == 0 || level > len(line) || line[level-1] != '#' {
		return 0
	}
	if len(line) > level && line[level] != ' ' {
		return 0
	}
	return level
}

func hashDoc(doc *models.Doc) string {
	if doc == nil {
		return ""
	}
	return hashSnapshot(DocToSnapshot(doc))
}

func hashSnapshot(snapshot map[string]any) string {
	if len(snapshot) == 0 {
		return ""
	}
	// Double round-trip to ensure deterministic JSON encoding.
	// First round-trip normalizes structs to maps (e.g., []AcceptanceCriterion → []map[string]any).
	// Second round-trip ensures all nested maps have alphabetically sorted keys,
	// producing identical JSON regardless of whether the source was a struct or map.
	data, err := json.Marshal(snapshot)
	if err != nil {
		return ""
	}
	var normalized map[string]any
	if err := json.Unmarshal(data, &normalized); err != nil {
		return ""
	}
	// Second round-trip to ensure nested maps (like AcceptanceCriteria elements)
	// also have sorted keys, not struct field order
	data, err = json.Marshal(normalized)
	if err != nil {
		return ""
	}
	if err := json.Unmarshal(data, &normalized); err != nil {
		return ""
	}
	data, _ = json.Marshal(normalized)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func normalizeDocPath(path string) string {
	path = strings.TrimSpace(path)
	path = strings.TrimPrefix(path, "/")
	path = strings.TrimSuffix(path, ".md")
	return strings.Trim(path, "/")
}

func previousDocPath(oldPath, currentPath string) string {
	if oldPath == "" || oldPath == currentPath {
		return ""
	}
	return oldPath
}

func compactDocPaths(paths ...string) []string {
	seen := map[string]bool{}
	var out []string
	for _, path := range paths {
		path = normalizeDocPath(path)
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		out = append(out, path)
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func legacyDocID(docPath string) string {
	sum := sha256.Sum256([]byte("legacy-doc:" + normalizeDocPath(docPath)))
	return "legacy-" + hex.EncodeToString(sum[:8])
}

func newDocID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err == nil {
		return "doc-" + hex.EncodeToString(b[:])
	}
	return fmt.Sprintf("doc-%d", time.Now().UTC().UnixNano())
}

// isZero reports whether v is the zero value of its type.
func isZero(v any) bool {
	if v == nil {
		return true
	}
	switch x := v.(type) {
	case string:
		return x == ""
	case int:
		return x == 0
	case bool:
		return !x
	case []string:
		return len(x) == 0
	case []models.AcceptanceCriterion:
		return len(x) == 0
	}
	return false
}
