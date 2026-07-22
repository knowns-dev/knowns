package models

import "time"

// TaskVersion represents a snapshot of a task at a specific point in time.
// Versions are identified by an incrementing integer wrapped in a "v" prefix
// string (e.g., "v1", "v2").
type TaskVersion struct {
	// ID is the human-readable version label (e.g., "v1").
	ID string `json:"id"`

	TaskID    string    `json:"taskId"`
	Version   int       `json:"version"`
	Timestamp time.Time `json:"timestamp"`

	// Author records who triggered the change (username or "rollback").
	Author string `json:"author,omitempty"`

	// LifecycleEventID makes lifecycle history append/rollback idempotent.
	LifecycleEventID string `json:"lifecycleEventId,omitempty"`

	// Changes is the list of individual field mutations in this version.
	Changes []TaskChange `json:"changes"`

	// Snapshot is a full copy of the task state at this version, stored as a
	// generic map so that the version store remains decoupled from Task field
	// additions over time.
	Snapshot map[string]any `json:"snapshot"`
}

// TaskChange describes a mutation of a single field between two task versions.
type TaskChange struct {
	Field    string `json:"field"`
	OldValue any    `json:"oldValue"`
	NewValue any    `json:"newValue"`
}

// TaskVersionHistory is the complete audit trail for one task.
type TaskVersionHistory struct {
	TaskID         string        `json:"taskId"`
	CurrentVersion int           `json:"currentVersion"`
	Versions       []TaskVersion `json:"versions"`
}

// TaskSnapshot is a typed representation of the fields captured in a version
// snapshot.  It mirrors the TRACKED_FIELDS list from the TypeScript model.
// Storage uses map[string]any on TaskVersion.Snapshot for forward
// compatibility; this struct can be used for typed access after unmarshaling.
type TaskSnapshot struct {
	Title               string                `json:"title"`
	Description         string                `json:"description,omitempty"`
	Status              string                `json:"status"`
	Priority            string                `json:"priority"`
	Assignee            string                `json:"assignee,omitempty"`
	Labels              []string              `json:"labels,omitempty"`
	AcceptanceCriteria  []AcceptanceCriterion `json:"acceptanceCriteria,omitempty"`
	ImplementationPlan  string                `json:"implementationPlan,omitempty"`
	ImplementationNotes string                `json:"implementationNotes,omitempty"`
}

// DocVersion represents a snapshot of a doc at a specific point in time.
type DocVersion struct {
	ID            string           `json:"id"`
	DocID         string           `json:"docId,omitempty"`
	DocPath       string           `json:"docPath"`
	CurrentPath   string           `json:"currentPath,omitempty"`
	PreviousPath  string           `json:"previousPath,omitempty"`
	Version       int              `json:"version"`
	Timestamp     time.Time        `json:"timestamp"`
	Author        string           `json:"author,omitempty"`
	Actor         string           `json:"actor,omitempty"`
	Source        string           `json:"source,omitempty"`
	AuditEventID  string           `json:"auditEventId,omitempty"`
	SessionID     string           `json:"sessionId,omitempty"`
	BaseHash      string           `json:"baseHash,omitempty"`
	NewHash       string           `json:"newHash,omitempty"`
	Checkpoint    bool             `json:"checkpoint,omitempty"`
	Changes       []DocChange      `json:"changes"`
	ChangedScopes []DocChangeScope `json:"changedScopes,omitempty"`
	Snapshot      map[string]any   `json:"snapshot"`
}

// DocChange describes a mutation of a single field between two doc versions.
type DocChange struct {
	Field    string `json:"field"`
	OldValue any    `json:"oldValue"`
	NewValue any    `json:"newValue"`
}

// DocChangeScope describes the document area affected by a revision.
type DocChangeScope struct {
	Type       string `json:"type"`
	Field      string `json:"field,omitempty"`
	Section    string `json:"section,omitempty"`
	Summary    string `json:"summary,omitempty"`
	OldBytes   int    `json:"oldBytes,omitempty"`
	NewBytes   int    `json:"newBytes,omitempty"`
	DeltaBytes int    `json:"deltaBytes,omitempty"`
}

// DocVersionHistory is the complete audit trail for one document.
type DocVersionHistory struct {
	DocID          string          `json:"docId,omitempty"`
	DocPath        string          `json:"docPath"`
	CurrentPath    string          `json:"currentPath,omitempty"`
	CurrentVersion int             `json:"currentVersion"`
	Versions       []DocVersion    `json:"versions"`
	RetentionGaps  []DocHistoryGap `json:"retentionGaps,omitempty"`
}

// DocHistoryGap explains history ranges whose full detail is no longer stored.
type DocHistoryGap struct {
	Type          string    `json:"type"`
	Reason        string    `json:"reason"`
	Count         int       `json:"count"`
	BeforeVersion string    `json:"beforeVersion,omitempty"`
	AfterVersion  string    `json:"afterVersion,omitempty"`
	AppliedAt     time.Time `json:"appliedAt"`
}

// DocRevisionDiff is a structured, API-friendly view of one revision's change
// set and the history context needed to render unavailable retained ranges.
type DocRevisionDiff struct {
	DocID              string           `json:"docId,omitempty"`
	DocPath            string           `json:"docPath"`
	CurrentPath        string           `json:"currentPath,omitempty"`
	RevisionID         string           `json:"revisionId"`
	PreviousRevisionID string           `json:"previousRevisionId,omitempty"`
	Version            DocVersion       `json:"version"`
	Checkpoint         bool             `json:"checkpoint"`
	Changes            []DocChange      `json:"changes"`
	ChangedScopes      []DocChangeScope `json:"changedScopes,omitempty"`
	RetentionGaps      []DocHistoryGap  `json:"retentionGaps,omitempty"`
}
