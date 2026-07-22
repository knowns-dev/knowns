// Package tasklifecycle owns Task lifecycle policy and mutations. Public
// surfaces should call this package instead of composing storage operations.
package tasklifecycle

import (
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

type Operation string

const (
	OperationArchive        Operation = "archive"
	OperationReopen         Operation = "reopen"
	OperationBatchArchive   Operation = "batch_archive"
	OperationBatchUnarchive Operation = "batch_unarchive"
	OperationHardDelete     Operation = "hard_delete"
)

type ReasonCode string

const (
	ReasonNotDone              ReasonCode = "not_done"
	ReasonAlreadyArchived      ReasonCode = "already_archived"
	ReasonAlreadyActive        ReasonCode = "already_active"
	ReasonAlreadyDeleted       ReasonCode = "already_deleted"
	ReasonInvalidRequest       ReasonCode = "invalid_request"
	ReasonAutoArchiveDisabled  ReasonCode = "auto_archive_disabled"
	ReasonCompletedAtMissing   ReasonCode = "completed_at_missing"
	ReasonRetentionPending     ReasonCode = "retention_pending"
	ReasonActiveTimer          ReasonCode = "active_timer"
	ReasonUnfinishedDescendant ReasonCode = "unfinished_descendant"
	ReasonConfirmationRequired ReasonCode = "confirmation_required"
	ReasonDeleteReasonRequired ReasonCode = "delete_reason_required"
	ReasonPermissionRequired   ReasonCode = "permission_required"
	ReasonTombstoneConflict    ReasonCode = "tombstone_conflict"
	ReasonNotFound             ReasonCode = "not_found"
	ReasonOperationFailed      ReasonCode = "operation_failed"
)

type WarningCode string

const (
	WarningDurableKnowledge   WarningCode = "durable_knowledge_review"
	WarningEventDeliveryError WarningCode = "event_delivery_failed"
)

// Reason is a stable, machine-readable explanation for an ineligible action.
type Reason struct {
	Code          ReasonCode `json:"code"`
	Message       string     `json:"message"`
	RelatedTaskID string     `json:"relatedTaskId,omitempty"`
	Deadline      *time.Time `json:"deadline,omitempty"`
}

// Warning never blocks a lifecycle mutation.
type Warning struct {
	Code       WarningCode `json:"code"`
	Message    string      `json:"message"`
	References []string    `json:"references,omitempty"`
}

type Eligibility struct {
	TaskID      string                    `json:"taskId"`
	Eligible    bool                      `json:"eligible"`
	Lifecycle   models.TaskLifecycleState `json:"lifecycle"`
	CompletedAt *time.Time                `json:"completedAt,omitempty"`
	ArchivedAt  *time.Time                `json:"archivedAt,omitempty"`
	Deadline    *time.Time                `json:"deadline,omitempty"`
	Reasons     []Reason                  `json:"reasons"`
	Warnings    []Warning                 `json:"warnings,omitempty"`
}

// Event is returned for every successful mutation so CLI, MCP, API, and WebUI
// can publish equivalent audit/event metadata.
type Event struct {
	ID        string                    `json:"id"`
	Type      Operation                 `json:"type"`
	TaskID    string                    `json:"taskId"`
	At        time.Time                 `json:"at"`
	Actor     string                    `json:"actor,omitempty"`
	Reason    string                    `json:"reason,omitempty"`
	From      models.TaskLifecycleState `json:"from"`
	To        models.TaskLifecycleState `json:"to"`
	Automatic bool                      `json:"automatic,omitempty"`
}

type Result struct {
	TaskID      string                    `json:"taskId"`
	Operation   Operation                 `json:"operation"`
	Changed     bool                      `json:"changed"`
	Eligible    bool                      `json:"eligible"`
	Before      models.TaskLifecycleState `json:"before"`
	After       models.TaskLifecycleState `json:"after"`
	Reasons     []Reason                  `json:"reasons"`
	Warnings    []Warning                 `json:"warnings,omitempty"`
	Event       *Event                    `json:"event,omitempty"`
	CompletedAt *time.Time                `json:"completedAt,omitempty"`
	ArchivedAt  *time.Time                `json:"archivedAt,omitempty"`
	Deadline    *time.Time                `json:"deadline,omitempty"`
}

type ArchiveOptions struct {
	Actor string

	// Automatic applies project auto-archive enablement and retention.
	Automatic bool

	// MinimumAge applies a caller-selected retention threshold. A pointer keeps
	// an explicit zero delay distinct from no age threshold.
	MinimumAge *time.Duration
}

type ReopenOptions struct {
	Actor  string
	Status string
}

type HardDeleteOptions struct {
	Actor     string
	Reason    string
	Confirmed bool
}

type BatchOptions struct {
	IDs        []string
	Execute    bool
	Actor      string
	Automatic  bool
	MinimumAge *time.Duration
}

type BatchResult struct {
	Operation    Operation `json:"operation"`
	Execute      bool      `json:"execute"`
	Completed    bool      `json:"completed"`
	Processed    int       `json:"processed"`
	Changed      int       `json:"changed"`
	FailedTaskID string    `json:"failedTaskId,omitempty"`
	Items        []Result  `json:"items"`
}

// Request and Response are the stable public lifecycle contract shared by
// CLI, MCP, HTTP, and WebUI adapters. Authorization is intentionally absent:
// trusted adapters pass it separately to ExecutePublic.
type Request struct {
	Operation    Operation `json:"operation"`
	TaskID       string    `json:"taskId,omitempty"`
	IDs          []string  `json:"ids,omitempty"`
	Execute      bool      `json:"execute"`
	Actor        string    `json:"actor,omitempty"`
	Reason       string    `json:"reason,omitempty"`
	Confirmed    bool      `json:"confirmed,omitempty"`
	Status       string    `json:"status,omitempty"`
	MinimumAgeMs *int64    `json:"minimumAgeMs,omitempty"`
}

type PublicCapabilities struct {
	Archive    bool
	HardDelete bool
}

type Response struct {
	Operation    Operation `json:"operation"`
	Execute      bool      `json:"execute"`
	Completed    bool      `json:"completed"`
	Processed    int       `json:"processed"`
	Changed      int       `json:"changed"`
	FailedTaskID string    `json:"failedTaskId,omitempty"`
	Items        []Result  `json:"items"`
}

// TaskUpdateOptions keeps the caller's patch logic inside the lifecycle lock.
// Mutate receives a fresh canonical Task copy and must not retain it.
type TaskUpdateOptions struct {
	Actor  string
	Mutate func(*models.Task) error
}

type TimeMutationOptions struct {
	Actor string
	Entry models.TimeEntry
}

type Hooks struct {
	IndexTask  func(taskID string) error
	RemoveTask func(taskID string) error
	// Emit is at-least-once across process crashes. Consumers must deduplicate
	// using Event.ID. Durable claims prevent concurrent normal-case delivery.
	Emit func(Event) error
}

type Option func(*Service)

func WithClock(now func() time.Time) Option {
	return func(service *Service) {
		if now != nil {
			service.now = now
		}
	}
}

func WithHooks(hooks Hooks) Option {
	return func(service *Service) { service.hooks = hooks }
}
