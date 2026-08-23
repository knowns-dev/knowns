package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
)

func cloneMap(value map[string]any) map[string]any {
	if value == nil {
		return nil
	}
	copy := make(map[string]any, len(value))
	for key, item := range value {
		copy[key] = cloneHistoryValue(item)
	}
	return copy
}

func cloneHistoryValue(value any) any {
	switch item := value.(type) {
	case map[string]any:
		return cloneMap(item)
	case []any:
		out := make([]any, len(item))
		for i := range item {
			out[i] = cloneHistoryValue(item[i])
		}
		return out
	case []string:
		return append([]string(nil), item...)
	default:
		return value
	}
}

func cloneMapIf(checkpoint bool, value map[string]any) map[string]any {
	if !checkpoint {
		return nil
	}
	return cloneMap(value)
}

func applyTaskChangesToMap(state map[string]any, changes []models.TaskChange) map[string]any {
	for _, change := range changes {
		if change.NewValue == nil {
			switch change.Field {
			case "title", "status", "priority":
				state[change.Field] = ""
			case "timeSpent":
				state[change.Field] = 0
			case "archived":
				state[change.Field] = false
			default:
				delete(state, change.Field)
			}
		} else {
			// Normalize the new value before cloning to ensure consistency.
			// During write, change.NewValue may be strongly-typed (e.g., []models.AcceptanceCriterion).
			// During replay from JSONL, it's already normalized as []any.
			// We normalize here to ensure both paths produce identical state.
			normalizedValue := normalizeValue(change.NewValue)
			state[change.Field] = cloneHistoryValue(normalizedValue)
		}
	}
	// Normalize the entire state through JSON round-trip to ensure consistent
	// hash computation. This is critical because values read from JSONL (like
	// []AcceptanceCriterion) are deserialized as []any with map[string]any
	// elements, while original values are strongly typed. The normalization
	// ensures both produce the same hash.
	return normalizeStateMap(state)
}

func normalizeStateMap(state map[string]any) map[string]any {
	data, err := json.Marshal(state)
	if err != nil {
		return state
	}
	var normalized map[string]any
	if err := json.Unmarshal(data, &normalized); err != nil {
		return state
	}
	return normalized
}

// normalizeValue normalizes any value through JSON round-trip.
// This converts strongly-typed values (like []models.AcceptanceCriterion)
// into their JSON-equivalent forms ([]any with map[string]any elements),
// ensuring consistency between write and replay paths.
func normalizeValue(value any) any {
	data, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var normalized any
	if err := json.Unmarshal(data, &normalized); err != nil {
		return value
	}
	return normalized
}

func taskCanonicalHash(snapshot map[string]any) string {
	canonical := cloneMap(snapshot)
	// Timestamps are transport metadata and are not tracked as Task deltas;
	// excluding them keeps replay verification deterministic across lifecycle
	// writes that legitimately refresh UpdatedAt.
	delete(canonical, "createdAt")
	delete(canonical, "updatedAt")
	delete(canonical, "completedAt")
	delete(canonical, "archivedAt")
	return hashSnapshot(canonical)
}

// historyDeltaInefficient selects a checkpoint when the serialized delta is at
// least as large as the full checkpoint payload. This bounds replay work and
// keeps the checkpoint representation no larger than its delta counterpart.
func historyDeltaInefficient(delta any, snapshot map[string]any) bool {
	deltaBytes, err := json.Marshal(delta)
	if err != nil {
		return true
	}
	snapshotBytes, err := json.Marshal(snapshot)
	if err != nil {
		return true
	}
	return len(snapshotBytes) == 0 || len(deltaBytes) >= len(snapshotBytes)
}

func taskHistoryFromRecords(taskID string, records []models.HistoryRecord) (*models.TaskVersionHistory, error) {
	history := &models.TaskVersionHistory{TaskID: taskID, Versions: []models.TaskVersion{}}
	state := map[string]any{}
	for _, record := range records {
		if record.EntityType != "task" || record.EntityID != taskID {
			return nil, fmt.Errorf("history entity mismatch for Task %q", taskID)
		}
		if record.Checkpoint {
			state = normalizeStateMap(cloneMap(record.CheckpointPayload))
		}
		if !record.Checkpoint {
			state = applyTaskChangesToMap(state, record.TaskChanges)
		}
		if record.NewHash != "" && !record.LegacyUnverified {
			computedHash := taskCanonicalHash(state)
			if computedHash != record.NewHash {
				return nil, fmt.Errorf("%w: Task canonical hash mismatch at revision %d (got %s want %s)", ErrHistoryCorrupt, record.Revision, computedHash, record.NewHash)
			}
		}
		version := models.TaskVersion{
			ID: firstNonEmpty(record.LegacyID, fmt.Sprintf("v%d", firstPositive(record.LegacyRevision, record.Revision))), TaskID: taskID, Version: firstPositive(record.LegacyRevision, record.Revision),
			Timestamp: record.Timestamp, Author: record.Author, LifecycleEventID: record.LifecycleID,
			Changes: append([]models.TaskChange(nil), record.TaskChanges...), Snapshot: cloneMap(state),
			SchemaVersion: record.SchemaVersion, BaseHash: record.BaseHash, NewHash: record.NewHash,
			Checkpoint: record.Checkpoint, Source: record.Source, SessionID: record.SessionID, BatchID: record.BatchID,
			Operation: record.Operation, Tombstone: record.Tombstone,
			LegacyUnverified: record.LegacyUnverified,
			LegacyPath:       record.LegacyPath, LegacyDigest: record.LegacyDigest,
		}
		history.Versions = append(history.Versions, version)
	}
	for _, version := range history.Versions {
		if version.Version > history.CurrentVersion {
			history.CurrentVersion = version.Version
		}
	}
	return history, nil
}

func docHistoryFromRecords(docPath string, records []models.HistoryRecord) (*models.DocVersionHistory, error) {
	history := &models.DocVersionHistory{DocPath: docPath, CurrentPath: docPath, Versions: []models.DocVersion{}}
	state := &models.Doc{Path: docPath, Tags: []string{}}
	for _, record := range records {
		if record.EntityType != "doc" {
			return nil, fmt.Errorf("history entity mismatch for Doc %q", docPath)
		}
		if record.Checkpoint {
			state = &models.Doc{}
			applyDocSnapshot(state, record.CheckpointPayload)
		}
		version := models.DocVersion{
			ID: firstNonEmpty(record.LegacyID, fmt.Sprintf("v%d", firstPositive(record.LegacyRevision, record.Revision))), DocID: record.EntityID, DocPath: docPath,
			CurrentPath: record.CurrentPath, PreviousPath: record.PreviousPath, Version: firstPositive(record.LegacyRevision, record.Revision),
			Timestamp: record.Timestamp, Author: record.Author, Actor: record.Actor, Source: record.Source,
			AuditEventID: record.AuditEventID, SessionID: record.SessionID, BaseHash: record.BaseHash,
			NewHash: record.NewHash, Checkpoint: record.Checkpoint,
			Changes:       append([]models.DocChange(nil), record.DocChanges...),
			ChangedScopes: append([]models.DocChangeScope(nil), record.ChangedScopes...),
			Snapshot:      cloneMap(record.CheckpointPayload), SchemaVersion: record.SchemaVersion, BatchID: record.BatchID,
			Operation: record.Operation, Tombstone: record.Tombstone,
			LegacyUnverified: record.LegacyUnverified,
			LegacyPath:       record.LegacyPath, LegacyDigest: record.LegacyDigest,
		}
		if !record.Checkpoint {
			if err := applyDocChangesToState(state, record); err != nil {
				return nil, err
			}
		}
		if !record.LegacyUnverified && !docHashRecognized(record.NewHash, state) {
			return nil, fmt.Errorf("%w: Doc canonical hash mismatch at revision %d", ErrHistoryCorrupt, record.Revision)
		}
		// Keep the replayed snapshot byte-faithful to the record. Canonicalising
		// here would erase the pre-canonicalisation body a legacy NewHash covers,
		// making that record unrecognisable on the next write.
		version.Snapshot = rawDocSnapshot(state)
		if !record.Checkpoint && firstSectionScopeFromRecord(record) != "" {
			delete(version.Snapshot, "content")
		}
		history.Versions = append(history.Versions, version)
		history.RetentionGaps = append(history.RetentionGaps, record.RetentionGaps...)
		history.DocID = record.EntityID
		history.CurrentPath = firstNonEmpty(record.CurrentPath, history.CurrentPath)
		history.DocPath = history.CurrentPath
	}
	for _, version := range history.Versions {
		if version.Version > history.CurrentVersion {
			history.CurrentVersion = version.Version
		}
	}
	return history, nil
}

func firstPositive(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func applyDocChangesToState(state *models.Doc, record models.HistoryRecord) error {
	for _, change := range record.DocChanges {
		switch change.Field {
		case "path":
			if change.NewValue == nil {
				state.Path = ""
			} else if path, ok := change.NewValue.(string); ok {
				state.Path = normalizeDocPath(path)
			}
		case "id":
			if change.NewValue == nil {
				state.ID = ""
			} else if id, ok := change.NewValue.(string); ok {
				state.ID = id
			}
		case "title":
			state.Title = ""
			if value, ok := change.NewValue.(string); ok {
				state.Title = value
			}
		case "description":
			state.Description = ""
			if value, ok := change.NewValue.(string); ok {
				state.Description = value
			}
		case "content":
			if firstSection := firstSectionScopeFromRecord(record); firstSection != "" {
				value := ""
				if newValue, ok := change.NewValue.(string); ok {
					value = newValue
				}
				content, replaced := replaceMarkdownSection(state.Content, firstSection, value)
				if !replaced {
					return fmt.Errorf("%w: section %q cannot be replayed", ErrHistoryCorrupt, firstSection)
				}
				state.Content = content
			} else {
				state.Content = ""
				if value, ok := change.NewValue.(string); ok {
					state.Content = value
				}
			}
		case "tags":
			state.Tags = anyStringSlice(change.NewValue)
		}
	}
	if record.CurrentPath != "" {
		state.Path = normalizeHistoryDocPath(record.CurrentPath)
	}
	return nil
}

// Lifecycle records may carry the project-relative canonical path (docs/x.md)
// while Doc snapshots use the public path (x). Accept both forms so rename
// and tombstone records remain hash-replayable across old/new writers.
func normalizeHistoryDocPath(path string) string {
	path = strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(path), "/"), "docs/")
	return normalizeDocPath(path)
}

func firstSectionScopeFromRecord(record models.HistoryRecord) string {
	for _, scope := range record.ChangedScopes {
		if scope.Type == "section" && scope.Field == "content" && scope.Section != "" {
			return scope.Section
		}
	}
	return ""
}

func (vs *VersionStore) hasJSONLHistory(entityType, entityID string) bool {
	_, err := os.Stat(vs.historyStore().EntityPath(entityType, entityID))
	return err == nil
}

func (vs *VersionStore) readDocJSONL(docPath string) (*models.DocVersionHistory, bool, error) {
	entityID, ok, err := vs.historyStore().FindEntityByPath(context.Background(), "doc", docPath)
	if err != nil || !ok {
		return nil, ok, err
	}
	result, err := vs.historyStore().Read(context.Background(), "doc", entityID)
	if err != nil {
		return nil, true, err
	}
	history, err := docHistoryFromRecords(docPath, result.Records)
	if history != nil {
		history.TailTruncated = result.TailTruncated
	}
	return history, true, err
}
