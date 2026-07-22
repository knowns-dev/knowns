package models

import "time"

// Task represents a task in the .knowns/ system.
// The ID uses a 6-character base36 format (e.g., "abc123").
// Legacy sequential integer IDs are also supported for backward compatibility.
type Task struct {
	ID          string   `json:"id"                    yaml:"id"`
	Title       string   `json:"title"                 yaml:"title"`
	Description string   `json:"description,omitempty" yaml:"description,omitempty"`
	Status      string   `json:"status"                yaml:"status"`
	Priority    string   `json:"priority"              yaml:"priority"` // "low", "medium", "high"
	Assignee    string   `json:"assignee,omitempty"    yaml:"assignee,omitempty"`
	Labels      []string `json:"labels"                yaml:"labels"`

	// Parent task ID for subtasks (e.g., "abc123").
	Parent string `json:"parent,omitempty" yaml:"parent,omitempty"`

	// Subtasks holds child task IDs. Derived at load time; not persisted in the
	// task file itself.
	Subtasks []string `json:"subtasks,omitempty" yaml:"-"`

	// Spec is the linked spec document path (e.g., "specs/user-auth").
	Spec string `json:"spec,omitempty" yaml:"spec,omitempty"`

	// Fulfills lists spec acceptance-criteria IDs this task satisfies
	// (e.g., ["AC-1", "AC-2"]).
	Fulfills []string `json:"fulfills,omitempty" yaml:"fulfills,omitempty"`

	// Order is an optional manual display order (lower = first).
	Order *int `json:"order,omitempty" yaml:"order,omitempty"`

	CreatedAt time.Time `json:"createdAt" yaml:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt" yaml:"updatedAt"`

	// CompletedAt records when the Task most recently entered the done state.
	// ArchivedAt records the archive transition when it is known. Existing
	// archived Task files may not have an ArchivedAt value.
	CompletedAt *time.Time `json:"completedAt,omitempty" yaml:"completedAt,omitempty"`
	ArchivedAt  *time.Time `json:"archivedAt,omitempty"  yaml:"archivedAt,omitempty"`

	// Archived is derived from the Task file location when loaded. It is never
	// persisted in frontmatter because the archive directory is canonical.
	Archived bool `json:"archived" yaml:"-"`

	// AcceptanceCriteria lives in the markdown body, not the YAML frontmatter.
	AcceptanceCriteria []AcceptanceCriterion `json:"acceptanceCriteria" yaml:"-"`

	// TimeSpent is the total time tracked in seconds.
	TimeSpent   int          `json:"timeSpent"            yaml:"timeSpent"`
	TimeEntries []TimeEntry  `json:"timeEntries,omitempty" yaml:"-"`
	ActiveTimer *ActiveTimer `json:"activeTimer,omitempty" yaml:"-"`

	// ImplementationPlan and ImplementationNotes live in the markdown body.
	ImplementationPlan  string `json:"implementationPlan,omitempty"  yaml:"-"`
	ImplementationNotes string `json:"implementationNotes,omitempty" yaml:"-"`
}

// TaskLifecycleState is the externally meaningful lifecycle group for a Task.
type TaskLifecycleState string

const (
	TaskLifecycleActive   TaskLifecycleState = "active"
	TaskLifecycleDone     TaskLifecycleState = "done"
	TaskLifecycleArchived TaskLifecycleState = "archived"
)

// LifecycleState derives lifecycle state from canonical storage location and
// status. Archived wins over status so legacy archived Tasks remain historical.
func (t *Task) LifecycleState() TaskLifecycleState {
	if t.Archived {
		return TaskLifecycleArchived
	}
	if t.Status == "done" {
		return TaskLifecycleDone
	}
	return TaskLifecycleActive
}

// TaskTombstone reserves the identity of a hard-deleted Task without retaining
// its title, body, plan, notes, acceptance criteria, or history.
type TaskTombstone struct {
	ID        string    `json:"id"`
	DeletedAt time.Time `json:"deletedAt"`
	Actor     string    `json:"actor,omitempty"`
	Reason    string    `json:"reason"`
}

// AcceptanceCriterion is a single checkbox item in the Acceptance Criteria
// section of a task file.
type AcceptanceCriterion struct {
	Text      string `json:"text"`
	Completed bool   `json:"completed"`
}

// DefaultStatuses returns the built-in task status list used when no project
// config is available.
func DefaultStatuses() []string {
	return []string{
		"todo",
		"in-progress",
		"in-review",
		"done",
		"blocked",
		"on-hold",
		"urgent",
	}
}

// ValidPriorities returns the allowed priority values.
func ValidPriorities() []string {
	return []string{"low", "medium", "high"}
}
