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

	// History metadata is populated by the JSONL history backend.  The fields
	// are optional so older .knowns/versions JSON remains readable.
	SchemaVersion    int    `json:"schemaVersion,omitempty"`
	BaseHash         string `json:"baseHash,omitempty"`
	NewHash          string `json:"newHash,omitempty"`
	Checkpoint       bool   `json:"checkpoint,omitempty"`
	Source           string `json:"source,omitempty"`
	SessionID        string `json:"sessionId,omitempty"`
	BatchID          string `json:"batchId,omitempty"`
	Operation        string `json:"operation,omitempty"`
	Tombstone        bool   `json:"tombstone,omitempty"`
	LegacyUnverified bool   `json:"legacyUnverified,omitempty"`
	LegacyPath       string `json:"legacyPath,omitempty"`
	LegacyDigest     string `json:"legacyDigest,omitempty"`
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
	TailTruncated  bool          `json:"tailTruncated,omitempty"`
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
	ID               string           `json:"id"`
	DocID            string           `json:"docId,omitempty"`
	DocPath          string           `json:"docPath"`
	CurrentPath      string           `json:"currentPath,omitempty"`
	PreviousPath     string           `json:"previousPath,omitempty"`
	Version          int              `json:"version"`
	Timestamp        time.Time        `json:"timestamp"`
	Author           string           `json:"author,omitempty"`
	Actor            string           `json:"actor,omitempty"`
	Source           string           `json:"source,omitempty"`
	AuditEventID     string           `json:"auditEventId,omitempty"`
	SessionID        string           `json:"sessionId,omitempty"`
	BaseHash         string           `json:"baseHash,omitempty"`
	NewHash          string           `json:"newHash,omitempty"`
	Checkpoint       bool             `json:"checkpoint,omitempty"`
	Changes          []DocChange      `json:"changes"`
	ChangedScopes    []DocChangeScope `json:"changedScopes,omitempty"`
	Snapshot         map[string]any   `json:"snapshot"`
	SchemaVersion    int              `json:"schemaVersion,omitempty"`
	BatchID          string           `json:"batchId,omitempty"`
	RecordHash       string           `json:"recordHash,omitempty"`
	Operation        string           `json:"operation,omitempty"`
	Tombstone        bool             `json:"tombstone,omitempty"`
	LegacyUnverified bool             `json:"legacyUnverified,omitempty"`
	LegacyPath       string           `json:"legacyPath,omitempty"`
	LegacyDigest     string           `json:"legacyDigest,omitempty"`
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
	TailTruncated  bool            `json:"tailTruncated,omitempty"`
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

// HistoryRecord is the backend-neutral, immutable JSONL representation of a
// revision.  Delta records carry only changes; CheckpointPayload is populated
// only for checkpoints.  Task/Doc version structs are materialized by the
// storage adapter for compatibility with existing callers.
type HistoryRecord struct {
	SchemaVersion int       `json:"schemaVersion"`
	EntityType    string    `json:"entityType"`
	EntityID      string    `json:"entityId"`
	Revision      int       `json:"revision"`
	Timestamp     time.Time `json:"timestamp"`
	Author        string    `json:"author,omitempty"`
	Actor         string    `json:"actor,omitempty"`
	Source        string    `json:"source,omitempty"`
	AuditEventID  string    `json:"auditEventId,omitempty"`
	SessionID     string    `json:"sessionId,omitempty"`
	BatchID       string    `json:"batchId,omitempty"`
	// Operation and Tombstone describe lifecycle transitions while remaining
	// optional for backward-compatible readers.
	Operation      string `json:"operation,omitempty"`
	Tombstone      bool   `json:"tombstone,omitempty"`
	LifecycleID    string `json:"lifecycleEventId,omitempty"`
	BaseHash       string `json:"baseHash,omitempty"`
	NewHash        string `json:"newHash,omitempty"`
	PrevRecordHash string `json:"prevRecordHash,omitempty"`
	RecordHash     string `json:"recordHash,omitempty"`
	Checkpoint     bool   `json:"checkpoint,omitempty"`
	// LegacyRevision and LegacyID preserve the identifiers used by the legacy
	// JSON store when a compacted/migrated stream has been renumbered.
	LegacyRevision   int    `json:"legacyRevision,omitempty"`
	LegacyID         string `json:"legacyId,omitempty"`
	Legacy           bool   `json:"legacy,omitempty"`
	LegacyUnverified bool   `json:"legacyUnverified,omitempty"`
	LegacyBaseHash   string `json:"legacyBaseHash,omitempty"`
	LegacyNewHash    string `json:"legacyNewHash,omitempty"`
	// LegacyPath and LegacyDigest bind migrated records to the exact legacy
	// bytes that produced them. The digest is immutable provenance, not a
	// content hash exposed to callers.
	LegacyPath    string          `json:"legacyPath,omitempty"`
	LegacyDigest  string          `json:"legacyDigest,omitempty"`
	RetentionGaps []DocHistoryGap `json:"retentionGaps,omitempty"`

	TaskChanges       []TaskChange     `json:"taskChanges,omitempty"`
	DocChanges        []DocChange      `json:"docChanges,omitempty"`
	ChangedScopes     []DocChangeScope `json:"changedScopes,omitempty"`
	CurrentPath       string           `json:"currentPath,omitempty"`
	PreviousPath      string           `json:"previousPath,omitempty"`
	CheckpointPayload map[string]any   `json:"checkpointPayload,omitempty"`
}

// HistoryReadResult reports valid records and whether an incomplete final
// line was ignored. Earlier corruption is returned as an error.
type HistoryReadResult struct {
	Records       []HistoryRecord `json:"records"`
	TailTruncated bool            `json:"tailTruncated,omitempty"`
}

// HistoryMetadata is the payload-free public representation of one revision.
// It intentionally contains only identity, lifecycle, ordering, hash, and
// retention metadata. Changes, scopes, and checkpoint snapshots are loaded
// by an explicit revision-detail request.
type HistoryMetadata struct {
	SchemaVersion    int             `json:"schemaVersion,omitempty"`
	EntityType       string          `json:"entityType"`
	EntityID         string          `json:"entityId"`
	Revision         int             `json:"revision"`
	ID               string          `json:"id"`
	Timestamp        time.Time       `json:"timestamp"`
	Author           string          `json:"author,omitempty"`
	Actor            string          `json:"actor,omitempty"`
	Source           string          `json:"source,omitempty"`
	AuditEventID     string          `json:"auditEventId,omitempty"`
	SessionID        string          `json:"sessionId,omitempty"`
	BatchID          string          `json:"batchId,omitempty"`
	Operation        string          `json:"operation,omitempty"`
	Tombstone        bool            `json:"tombstone,omitempty"`
	LifecycleID      string          `json:"lifecycleEventId,omitempty"`
	BaseHash         string          `json:"baseHash,omitempty"`
	NewHash          string          `json:"newHash,omitempty"`
	PrevRecordHash   string          `json:"prevRecordHash,omitempty"`
	RecordHash       string          `json:"recordHash,omitempty"`
	Checkpoint       bool            `json:"checkpoint,omitempty"`
	LegacyRevision   int             `json:"legacyRevision,omitempty"`
	LegacyID         string          `json:"legacyId,omitempty"`
	Legacy           bool            `json:"legacy,omitempty"`
	LegacyUnverified bool            `json:"legacyUnverified,omitempty"`
	LegacyPath       string          `json:"legacyPath,omitempty"`
	LegacyDigest     string          `json:"legacyDigest,omitempty"`
	RetentionGaps    []DocHistoryGap `json:"retentionGaps,omitempty"`
	CurrentPath      string          `json:"currentPath,omitempty"`
	PreviousPath     string          `json:"previousPath,omitempty"`
}

// HistoryMetadataPage is the backend-neutral paginated history response.
// Items are deterministic newest-first; NextOffset is omitted at the end.
type HistoryMetadataPage struct {
	EntityType     string            `json:"entityType,omitempty"`
	EntityID       string            `json:"entityId,omitempty"`
	DocPath        string            `json:"docPath,omitempty"`
	CurrentPath    string            `json:"currentPath,omitempty"`
	RetentionGaps  []DocHistoryGap   `json:"retentionGaps,omitempty"`
	Offset         int               `json:"offset"`
	Limit          int               `json:"limit"`
	HasMore        bool              `json:"hasMore"`
	NextOffset     *int              `json:"nextOffset,omitempty"`
	CurrentVersion int               `json:"currentVersion"`
	Items          []HistoryMetadata `json:"items"`
	TailTruncated  bool              `json:"tailTruncated,omitempty"`
}

// TaskVersionHistoryPage and DocVersionHistoryPage are aliases kept as
// discoverable names for callers that work with one entity type.
type TaskVersionHistoryPage = HistoryMetadataPage
type DocVersionHistoryPage = HistoryMetadataPage
