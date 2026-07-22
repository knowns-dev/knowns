package models

import "time"

// TaskLifecyclePending is a content-free durable delivery checkpoint. Task
// files and tombstones remain canonical; this record only tracks one stable
// lifecycle event and its derived index/remove delivery state.
type TaskLifecyclePending struct {
	EventID           string              `json:"eventId"`
	TaskID            string              `json:"taskId"`
	Operation         string              `json:"operation"`
	At                time.Time           `json:"at"`
	Actor             string              `json:"actor,omitempty"`
	Reason            string              `json:"reason,omitempty"`
	From              TaskLifecycleState  `json:"from"`
	To                TaskLifecycleState  `json:"to"`
	Automatic         bool                `json:"automatic,omitempty"`
	Original          *TaskLifecycleData  `json:"original,omitempty"`
	Desired           *TaskLifecycleData  `json:"desired,omitempty"`
	MoveComplete      bool                `json:"moveComplete,omitempty"`
	PatchComplete     bool                `json:"patchComplete,omitempty"`
	VersionComplete   bool                `json:"versionComplete,omitempty"`
	CanonicalComplete bool                `json:"canonicalComplete"`
	EventDelivered    bool                `json:"eventDelivered"`
	DerivedApplied    bool                `json:"derivedApplied"`
	EventClaim        *TaskLifecycleClaim `json:"eventClaim,omitempty"`
	DerivedClaim      *TaskLifecycleClaim `json:"derivedClaim,omitempty"`
}

// TaskLifecycleData is the content-free portion of a Task required to resume
// an interrupted archive/reopen transition without inferring completed phases
// from the Task's current file location.
type TaskLifecycleData struct {
	Status      string     `json:"status"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
	ArchivedAt  *time.Time `json:"archivedAt,omitempty"`
	Archived    bool       `json:"archived"`
}

// TaskLifecycleClaim serializes one external delivery attempt without holding
// the lifecycle file lock while user-supplied hooks execute. Expired claims
// can be retried; event sinks therefore remain at-least-once and must
// deduplicate by the stable event ID.
type TaskLifecycleClaim struct {
	Token     string    `json:"token"`
	ClaimedAt time.Time `json:"claimedAt"`
}
