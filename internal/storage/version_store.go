package storage

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

// VersionStore reads and writes task version histories from .knowns/versions/.
type VersionStore struct {
	root string
}

func (vs *VersionStore) versionsDir() string { return filepath.Join(vs.root, "versions") }

func (vs *VersionStore) versionPath(taskID string) string {
	return filepath.Join(vs.versionsDir(), "task-"+taskID+".json")
}

// GetHistory returns the full version history for a task.
// Returns an empty history (not an error) if no history file exists.
func (vs *VersionStore) GetHistory(taskID string) (*models.TaskVersionHistory, error) {
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

// SaveVersion appends a new version entry and updates CurrentVersion.
// version.Snapshot, Changes, and Timestamp should be populated by the caller
// (or use TrackChanges + TaskToSnapshot helpers).
func (vs *VersionStore) SaveVersion(taskID string, version models.TaskVersion) error {
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

	h.Versions = append(h.Versions, version)

	if err := os.MkdirAll(vs.versionsDir(), 0755); err != nil {
		return fmt.Errorf("mkdir versions: %w", err)
	}
	return writeJSON(vs.versionPath(taskID), h)
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

	return changes
}

// TaskToSnapshot converts a Task to the generic map snapshot stored in
// TaskVersion.Snapshot. This matches the TypeScript version history format.
func TaskToSnapshot(task *models.Task) map[string]any {
	snap := map[string]any{
		"title":    task.Title,
		"status":   task.Status,
		"priority": task.Priority,
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
	return snap
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
}

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

// SaveDocVersion appends a new version entry and updates CurrentVersion.
func (vs *VersionStore) SaveDocVersion(docPath string, version models.DocVersion) error {
	docPath = normalizeDocPath(docPath)
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
		Checkpoint:    oldDoc == nil,
		Changes:       changes,
		ChangedScopes: scopes,
		Snapshot:      docRevisionSnapshot(newDoc, oldDoc == nil, contentScope),
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
	h.CurrentVersion++
	version.ID = fmt.Sprintf("v%d", h.CurrentVersion)
	version.Version = h.CurrentVersion
	version.DocID = h.DocID
	version.DocPath = h.CurrentPath
	if version.CurrentPath == "" {
		version.CurrentPath = h.CurrentPath
	}
	if version.Timestamp.IsZero() {
		version.Timestamp = time.Now().UTC()
	}

	h.Versions = append(h.Versions, version)
	h.DocPath = h.CurrentPath

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
	if err := s.Docs.Update(&restored); err != nil {
		return nil, err
	}

	opts.Section = firstNonEmpty(opts.Section, section)
	if opts.Actor == "" {
		opts.Actor = "restore"
	}
	if opts.Source == "" {
		opts.Source = "restore"
	}
	if err := s.Versions.SaveDocRevisionWithOptions(&oldDoc, &restored, opts); err != nil {
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
	if err := s.Docs.Update(&restored); err != nil {
		return nil, err
	}

	if opts.Actor == "" {
		opts.Actor = "restore"
	}
	if opts.Source == "" {
		opts.Source = "restore"
	}
	if err := s.Versions.SaveDocRevisionWithOptions(&oldDoc, &restored, opts); err != nil {
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
			return &h, true, nil
		}
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
			return docContentScope{
				scope: sectionDocChangeScope(title, oldSection.Text, newSection.Text),
				old:   oldSection.Text,
				new:   newSection.Text,
				ok:    true,
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
	data, err := json.Marshal(snapshot)
	if err != nil {
		return ""
	}
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
