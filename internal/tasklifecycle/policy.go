package tasklifecycle

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/references"
	"github.com/howznguyen/knowns/internal/storage"
)

// ApplyStatusTransition records the completion clock when entering done and
// clears stale live lifecycle clocks when leaving done. Historical values stay
// available through Task version history.
func ApplyStatusTransition(task *models.Task, status string, now time.Time) {
	if task == nil || task.Status == status {
		return
	}
	now = now.UTC()
	if status == "done" {
		task.CompletedAt = timePointer(now)
		task.ArchivedAt = nil
	} else if task.Status == "done" || task.Archived {
		task.CompletedAt = nil
		task.ArchivedAt = nil
	}
	task.Status = status
	task.UpdatedAt = now
}

func evaluateInTransaction(tx *storage.TaskLifecycleTransaction, task *models.Task, now time.Time, settings models.TaskLifecycleSettings, options ArchiveOptions) (Eligibility, error) {
	eligibility := Eligibility{
		TaskID:      task.ID,
		Lifecycle:   task.LifecycleState(),
		CompletedAt: cloneTime(task.CompletedAt),
		ArchivedAt:  cloneTime(task.ArchivedAt),
		Reasons:     []Reason{},
		Warnings:    durableKnowledgeWarnings(task),
	}

	if task.Archived {
		eligibility.Reasons = append(eligibility.Reasons, Reason{Code: ReasonAlreadyArchived, Message: "Task is already archived"})
		return eligibility, nil
	}
	if task.Status != "done" {
		eligibility.Reasons = append(eligibility.Reasons, Reason{Code: ReasonNotDone, Message: "Task must be done before it can be archived"})
	}

	minimumAge := options.MinimumAge
	if options.Automatic {
		if !settings.AutoArchive {
			eligibility.Reasons = append(eligibility.Reasons, Reason{Code: ReasonAutoArchiveDisabled, Message: "Automatic Task archival is disabled"})
		}
		parsed, err := models.ParseTaskLifecycleDuration(settings.ArchiveAfter)
		if err != nil {
			return eligibility, err
		}
		minimumAge = &parsed
	}
	if minimumAge != nil && task.Status == "done" {
		if task.CompletedAt == nil {
			eligibility.Reasons = append(eligibility.Reasons, Reason{Code: ReasonCompletedAtMissing, Message: "Task has no completion timestamp; reopen and complete it again or archive it manually"})
		} else {
			deadline := task.CompletedAt.Add(*minimumAge).UTC()
			eligibility.Deadline = timePointer(deadline)
			if now.Before(deadline) {
				eligibility.Reasons = append(eligibility.Reasons, Reason{Code: ReasonRetentionPending, Message: "Task has not reached its archive deadline", Deadline: timePointer(deadline)})
			}
		}
	}

	hasActiveTimer, err := tx.HasActiveTimer(task.ID)
	if err != nil {
		return eligibility, fmt.Errorf("evaluate active timer for Task %q: %w", task.ID, err)
	}
	if hasActiveTimer {
		eligibility.Reasons = append(eligibility.Reasons, Reason{Code: ReasonActiveTimer, Message: "Task has an active timer"})
	}

	unfinished, err := unfinishedDescendants(tx, task.ID)
	if err != nil {
		return eligibility, err
	}
	for _, descendantID := range unfinished {
		eligibility.Reasons = append(eligibility.Reasons, Reason{
			Code:          ReasonUnfinishedDescendant,
			Message:       fmt.Sprintf("Descendant Task %s is not done or archived", descendantID),
			RelatedTaskID: descendantID,
		})
	}
	eligibility.Eligible = len(eligibility.Reasons) == 0
	return eligibility, nil
}

func unfinishedDescendants(tx *storage.TaskLifecycleTransaction, rootID string) ([]string, error) {
	active, err := tx.ListActiveTasks()
	if err != nil {
		return nil, err
	}
	archived, err := tx.ListArchivedTasks()
	if err != nil {
		return nil, err
	}
	all := make(map[string]*models.Task, len(active)+len(archived))
	for _, task := range active {
		all[task.ID] = task
	}
	for _, task := range archived {
		all[task.ID] = task
	}
	children := make(map[string][]string)
	for _, task := range all {
		if task.Parent != "" {
			children[task.Parent] = append(children[task.Parent], task.ID)
		}
	}
	for parent := range children {
		sort.Strings(children[parent])
	}

	visited := map[string]bool{rootID: true}
	queue := append([]string(nil), children[rootID]...)
	var unfinished []string
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		if visited[id] {
			continue
		}
		visited[id] = true
		task := all[id]
		if task == nil {
			continue
		}
		if !task.Archived && task.Status != "done" {
			unfinished = append(unfinished, id)
		}
		queue = append(queue, children[id]...)
	}
	sort.Strings(unfinished)
	return unfinished, nil
}

func durableKnowledgeWarnings(task *models.Task) []Warning {
	if task == nil || (strings.TrimSpace(task.ImplementationPlan) == "" && strings.TrimSpace(task.ImplementationNotes) == "") {
		return nil
	}
	combined := task.Description + "\n" + task.ImplementationPlan + "\n" + task.ImplementationNotes
	semanticRefs := references.Extract(combined)
	seen := make(map[string]struct{}, len(semanticRefs))
	refs := make([]string, 0, len(semanticRefs))
	for _, ref := range semanticRefs {
		if ref.Type != "doc" && ref.Type != "decision" && ref.Type != "memory" {
			continue
		}
		canonical := ref.Canonical
		if _, ok := seen[canonical]; ok {
			continue
		}
		seen[canonical] = struct{}{}
		refs = append(refs, canonical)
	}
	sort.Strings(refs)
	return []Warning{{
		Code:       WarningDurableKnowledge,
		Message:    "Review the Task Plan and Notes for durable knowledge before archival; this warning does not block the operation",
		References: refs,
	}}
}

func cloneTask(task *models.Task) *models.Task {
	if task == nil {
		return nil
	}
	clone := *task
	clone.Labels = append([]string(nil), task.Labels...)
	clone.Subtasks = append([]string(nil), task.Subtasks...)
	clone.Fulfills = append([]string(nil), task.Fulfills...)
	clone.AcceptanceCriteria = append([]models.AcceptanceCriterion(nil), task.AcceptanceCriteria...)
	clone.TimeEntries = append([]models.TimeEntry(nil), task.TimeEntries...)
	clone.CompletedAt = cloneTime(task.CompletedAt)
	clone.ArchivedAt = cloneTime(task.ArchivedAt)
	return &clone
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	clone := *value
	return &clone
}

func timePointer(value time.Time) *time.Time {
	value = value.UTC()
	return &value
}
