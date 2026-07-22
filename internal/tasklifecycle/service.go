package tasklifecycle

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

type Service struct {
	store *storage.Store
	now   func() time.Time
	hooks Hooks
}

func New(store *storage.Store, options ...Option) *Service {
	service := &Service{store: store, now: func() time.Time { return time.Now().UTC() }}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service
}

func (service *Service) Evaluate(ctx context.Context, taskID string, options ArchiveOptions) (*Eligibility, error) {
	settings, err := service.settings()
	if err != nil {
		return nil, err
	}
	now := service.now().UTC()
	var result Eligibility
	err = service.store.WithTaskLifecycleTransaction(ctx, func(tx *storage.TaskLifecycleTransaction) error {
		task, err := tx.GetTask(taskID)
		if err != nil {
			return err
		}
		result, err = evaluateInTransaction(tx, task, now, settings, options)
		return err
	})
	return &result, err
}

func (service *Service) Archive(ctx context.Context, taskID string, options ArchiveOptions) (*Result, error) {
	result := Result{TaskID: taskID, Operation: OperationArchive, Reasons: []Reason{}}
	preWarnings, prePending, err := service.flushTaskLifecyclePending(ctx, taskID)
	result.Warnings = append(result.Warnings, preWarnings...)
	if err != nil {
		return &result, err
	}
	settings, err := service.settings()
	if err != nil {
		return &result, err
	}
	now := service.now().UTC()
	err = service.store.WithTaskLifecycleTransaction(ctx, func(tx *storage.TaskLifecycleTransaction) error {
		var mutateErr error
		mutated, mutateErr := service.archiveInTransaction(tx, taskID, options, settings, now)
		mutated.Warnings = append(preWarnings, mutated.Warnings...)
		result = mutated
		return mutateErr
	})
	if err != nil {
		return &result, err
	}
	postWarnings, postPending, err := service.flushTaskLifecyclePending(ctx, taskID)
	result.Warnings = append(result.Warnings, postWarnings...)
	if err != nil {
		return &result, err
	}
	if result.Eligible && !result.Changed && !prePending && !postPending {
		if err := service.indexTask(taskID); err != nil {
			return &result, err
		}
	}
	service.populateResultLifecycle(&result)
	return &result, nil
}

// Unarchive is an alias for Reopen because restoring an archived Task also
// makes it active and cancels stale completion/archive timing.
func (service *Service) Unarchive(ctx context.Context, taskID string, options ReopenOptions) (*Result, error) {
	return service.Reopen(ctx, taskID, options)
}

func (service *Service) Reopen(ctx context.Context, taskID string, options ReopenOptions) (*Result, error) {
	status := strings.TrimSpace(options.Status)
	if status == "" || status == "done" {
		status = "todo"
	}
	result := Result{TaskID: taskID, Operation: OperationReopen, Eligible: true, Reasons: []Reason{}}
	preWarnings, prePending, err := service.flushTaskLifecyclePending(ctx, taskID)
	result.Warnings = append(result.Warnings, preWarnings...)
	if err != nil {
		return &result, err
	}
	now := service.now().UTC()
	err = service.store.WithTaskLifecycleTransaction(ctx, func(tx *storage.TaskLifecycleTransaction) error {
		task, err := tx.GetTask(taskID)
		if err != nil {
			return err
		}
		pending, err := tx.GetIncompleteTaskLifecyclePending(taskID, string(OperationReopen))
		if err != nil {
			return err
		}
		if pending != nil {
			result.Before = pending.From
			result.After = pending.From
			result.Event = eventFromPending(pending)
			if pending.CanonicalComplete {
				result.After = pending.To
				return nil
			}
			if _, err := resumeLifecycleMutation(tx, pending); err != nil {
				return rollbackLifecycleMutation(tx, pending, err)
			}
			result.Changed = true
			result.After = pending.To
			return nil
		}

		result.Before = task.LifecycleState()
		result.After = result.Before
		if !task.Archived && task.Status != "done" {
			result.Eligible = false
			result.Reasons = append(result.Reasons, Reason{Code: ReasonAlreadyActive, Message: "Task is already active"})
			return nil
		}
		event := Event{ID: lifecycleEventID(taskID, OperationReopen, now), Type: OperationReopen, TaskID: taskID, At: now, Actor: options.Actor, From: result.Before, To: models.TaskLifecycleActive}
		desired := cloneTask(task)
		desired.Archived = false
		ApplyStatusTransition(desired, status, now)
		desired.CompletedAt = nil
		desired.ArchivedAt = nil
		desired.UpdatedAt = now
		pending = pendingForTransition(event, task, desired)
		if err := tx.SaveTaskLifecyclePending(pending); err != nil {
			return err
		}
		if _, err := resumeLifecycleMutation(tx, pending); err != nil {
			return rollbackLifecycleMutation(tx, pending, err)
		}
		result.Changed = true
		result.After = models.TaskLifecycleActive
		result.Event = &event
		return nil
	})
	if err != nil {
		return &result, err
	}
	postWarnings, postPending, err := service.flushTaskLifecyclePending(ctx, taskID)
	result.Warnings = append(result.Warnings, postWarnings...)
	if err != nil {
		return &result, err
	}
	if !result.Changed && !prePending && !postPending {
		if err := service.indexTask(taskID); err != nil {
			return &result, err
		}
	}
	service.populateResultLifecycle(&result)
	return &result, nil
}

func (service *Service) BatchArchive(ctx context.Context, options BatchOptions) (*BatchResult, error) {
	batch := &BatchResult{Operation: OperationBatchArchive, Execute: options.Execute, Items: []Result{}}
	var failures []error
	archiveOptions := ArchiveOptions{Actor: options.Actor, Automatic: options.Automatic, MinimumAge: options.MinimumAge}
	ids, err := service.resolveBatchIDs(ctx, options.IDs)
	if err != nil {
		return batch, err
	}
	for _, id := range ids {
		var item *Result
		if options.Execute {
			item, err = service.Archive(ctx, id, archiveOptions)
		} else {
			var eligibility *Eligibility
			eligibility, err = service.Evaluate(ctx, id, archiveOptions)
			if eligibility != nil {
				preview := resultFromEligibility(OperationArchive, *eligibility)
				item = &preview
			}
		}
		batch.Processed++
		if item == nil {
			item = &Result{TaskID: id, Operation: OperationArchive, Reasons: []Reason{}}
		}
		if err != nil && len(item.Reasons) == 0 {
			item.Reasons = append(item.Reasons, publicFailureReason(err))
		}
		batch.Items = append(batch.Items, *item)
		if item.Changed {
			batch.Changed++
		}
		if err != nil {
			if batch.FailedTaskID == "" {
				batch.FailedTaskID = id
			}
			failures = append(failures, fmt.Errorf("Task %s: %w", id, err))
		}
	}
	batch.Completed = true
	return batch, errors.Join(failures...)
}

// BatchUnarchive previews or restores archived/done Tasks. Preview uses the
// same Result shape as execution and never mutates canonical state.
func (service *Service) BatchUnarchive(ctx context.Context, options BatchOptions) (*BatchResult, error) {
	batch := &BatchResult{Operation: OperationBatchUnarchive, Execute: options.Execute, Items: []Result{}}
	var failures []error
	ids := uniqueSorted(append([]string(nil), options.IDs...))
	for _, id := range ids {
		task, err := service.store.Tasks.Get(id)
		item := Result{TaskID: id, Operation: OperationReopen, Eligible: err == nil, Reasons: []Reason{}}
		if err == nil {
			item.Before = task.LifecycleState()
			item.After = item.Before
			item.CompletedAt = cloneTime(task.CompletedAt)
			item.ArchivedAt = cloneTime(task.ArchivedAt)
			if !task.Archived && task.Status != "done" {
				item.Eligible = false
				item.Reasons = append(item.Reasons, Reason{Code: ReasonAlreadyActive, Message: "Task is already active"})
			}
		}
		if err == nil && options.Execute {
			var result *Result
			result, err = service.Unarchive(ctx, id, ReopenOptions{Actor: options.Actor})
			if result != nil {
				item = *result
			}
		}
		if err != nil && len(item.Reasons) == 0 {
			item.Reasons = append(item.Reasons, publicFailureReason(err))
		}
		batch.Processed++
		if item.Changed {
			batch.Changed++
		}
		batch.Items = append(batch.Items, item)
		if err != nil {
			if batch.FailedTaskID == "" {
				batch.FailedTaskID = id
			}
			failures = append(failures, fmt.Errorf("Task %s: %w", id, err))
		}
	}
	batch.Completed = true
	return batch, errors.Join(failures...)
}

func (service *Service) AutoArchive(ctx context.Context, actor string) (*BatchResult, error) {
	return service.BatchArchive(ctx, BatchOptions{Execute: true, Actor: actor, Automatic: true})
}

func (service *Service) HardDelete(ctx context.Context, taskID string, options HardDeleteOptions) (*Result, error) {
	now := service.now().UTC()
	result := Result{TaskID: taskID, Operation: OperationHardDelete, Reasons: []Reason{}}
	if !options.Confirmed {
		result.Reasons = append(result.Reasons, Reason{Code: ReasonConfirmationRequired, Message: "Hard-delete requires explicit confirmation"})
	}
	options.Reason = strings.TrimSpace(options.Reason)
	if options.Reason == "" {
		result.Reasons = append(result.Reasons, Reason{Code: ReasonDeleteReasonRequired, Message: "Hard-delete requires a reason"})
	}
	if len(result.Reasons) > 0 {
		return &result, nil
	}
	result.Eligible = true
	preWarnings, prePending, err := service.flushTaskLifecyclePending(ctx, taskID)
	result.Warnings = append(result.Warnings, preWarnings...)
	if err != nil {
		return &result, err
	}

	err = service.store.WithTaskLifecycleTransaction(ctx, func(tx *storage.TaskLifecycleTransaction) error {
		task, taskErr := tx.GetTask(taskID)
		existing, tombstoneErr := tx.GetTombstone(taskID)
		pending, pendingErr := tx.GetTaskLifecyclePending(taskID, string(OperationHardDelete))
		if taskErr != nil && !isNotFound(taskErr) {
			return taskErr
		}
		if tombstoneErr != nil && !isNotFound(tombstoneErr) {
			return tombstoneErr
		}
		if pendingErr != nil {
			return pendingErr
		}
		hasTombstone := tombstoneErr == nil
		if hasTombstone && (existing.Reason != options.Reason || existing.Actor != options.Actor) {
			result.Eligible = false
			result.Reasons = append(result.Reasons, Reason{Code: ReasonTombstoneConflict, Message: "Task ID is reserved by a tombstone with different audit metadata"})
			return nil
		}
		if taskErr != nil && !hasTombstone {
			return taskErr
		}
		if task != nil {
			result.Before = task.LifecycleState()
		} else {
			result.Before = models.TaskLifecycleArchived
		}

		if !hasTombstone {
			existing = &models.TaskTombstone{ID: taskID, DeletedAt: now, Actor: options.Actor, Reason: options.Reason}
			if err := tx.SaveTombstone(existing); err != nil {
				return err
			}
			result.Changed = true
		}
		// A tombstone without either a live Task or a pending record is an
		// already-completed legacy/idempotent delete. Do not synthesize a new
		// event: doing so would duplicate delivery on every retry.
		if task == nil && pending == nil {
			if err := tx.DeleteTaskVersionHistory(taskID); err != nil {
				return err
			}
			if err := tx.DeleteTaskTimeData(taskID); err != nil {
				return err
			}
			result.Reasons = append(result.Reasons, Reason{Code: ReasonAlreadyDeleted, Message: "Task is already hard-deleted"})
			result.After = models.TaskLifecycleArchived
			return nil
		}
		if pending == nil {
			event := Event{
				ID:     lifecycleEventID(taskID, OperationHardDelete, existing.DeletedAt),
				Type:   OperationHardDelete,
				TaskID: taskID,
				At:     existing.DeletedAt,
				Actor:  existing.Actor,
				Reason: existing.Reason,
				From:   result.Before,
				To:     models.TaskLifecycleArchived,
			}
			pending = pendingFromEvent(event)
			if err := tx.SaveTaskLifecyclePending(pending); err != nil {
				return err
			}
		}
		if task != nil {
			if err := tx.DeleteTask(taskID); err != nil {
				return err
			}
			result.Changed = true
		}
		if err := tx.DeleteTaskVersionHistory(taskID); err != nil {
			return err
		}
		if err := tx.DeleteTaskTimeData(taskID); err != nil {
			return err
		}
		pending.CanonicalComplete = true
		if err := tx.SaveTaskLifecyclePending(pending); err != nil {
			return err
		}
		result.After = models.TaskLifecycleArchived
		result.Event = eventFromPending(pending)
		return nil
	})
	if err != nil {
		return &result, err
	}
	if !result.Eligible {
		return &result, nil
	}
	postWarnings, postPending, err := service.flushTaskLifecyclePending(ctx, taskID)
	result.Warnings = append(result.Warnings, postWarnings...)
	if err != nil {
		return &result, err
	}
	if !result.Changed && !prePending && !postPending {
		if err := service.removeFromIndex(taskID); err != nil {
			return &result, err
		}
	}
	return &result, nil
}

// ExecutePublic maps the shared public request contract onto the canonical
// lifecycle service. hardDeleteAuthorized is supplied only by a trusted
// adapter boundary and is never read from Request.
func (service *Service) ExecutePublic(ctx context.Context, request Request, hardDeleteAuthorized bool) (*Response, error) {
	return service.ExecutePublicWithCapabilities(ctx, request, PublicCapabilities{Archive: true, HardDelete: hardDeleteAuthorized})
}

// ExecutePublicWithCapabilities is used by policy-aware trusted adapters such
// as MCP. Capabilities are never accepted from request data.
func (service *Service) ExecutePublicWithCapabilities(ctx context.Context, request Request, capabilities PublicCapabilities) (*Response, error) {
	response := &Response{Operation: request.Operation, Execute: request.Execute, Items: []Result{}}
	if reason := validatePublicRequest(request); reason != nil {
		response.Items = append(response.Items, Result{TaskID: request.TaskID, Operation: request.Operation, Reasons: []Reason{*reason}})
		response.Completed = false
		return response, contractError(response, nil)
	}
	if isArchiveOperation(request.Operation) && !capabilities.Archive {
		response.Items = append(response.Items, Result{TaskID: request.TaskID, Operation: request.Operation, Reasons: []Reason{{Code: ReasonPermissionRequired, Message: "Task lifecycle operation requires a trusted archive capability"}}})
		return response, contractError(response, nil)
	}
	var minimumAge *time.Duration
	if request.MinimumAgeMs != nil {
		if *request.MinimumAgeMs < 0 || *request.MinimumAgeMs > int64((1<<63-1)/time.Millisecond) {
			response.Items = append(response.Items, Result{TaskID: request.TaskID, Operation: request.Operation, Reasons: []Reason{{Code: ReasonInvalidRequest, Message: "minimumAgeMs must be a non-negative duration"}}})
			return response, contractError(response, nil)
		}
		value := time.Duration(*request.MinimumAgeMs) * time.Millisecond
		minimumAge = &value
	}
	var err error
	switch request.Operation {
	case OperationArchive:
		var result *Result
		if request.Execute {
			result, err = service.Archive(ctx, request.TaskID, ArchiveOptions{Actor: request.Actor, MinimumAge: minimumAge})
		} else {
			var eligibility *Eligibility
			eligibility, err = service.Evaluate(ctx, request.TaskID, ArchiveOptions{Actor: request.Actor, MinimumAge: minimumAge})
			if eligibility != nil {
				item := resultFromEligibility(OperationArchive, *eligibility)
				result = &item
			}
		}
		if result != nil {
			response.Items = append(response.Items, *result)
			response.Processed = 1
			if result.Changed {
				response.Changed = 1
			}
		}
		response.Completed = err == nil
	case OperationReopen:
		if request.Execute {
			var result *Result
			result, err = service.Unarchive(ctx, request.TaskID, ReopenOptions{Actor: request.Actor, Status: request.Status})
			if result != nil {
				response.Items = append(response.Items, *result)
				response.Processed = 1
				if result.Changed {
					response.Changed = 1
				}
			}
		} else {
			batch, batchErr := service.BatchUnarchive(ctx, BatchOptions{IDs: []string{request.TaskID}, Execute: false, Actor: request.Actor})
			copyBatchResponse(response, batch)
			err = batchErr
		}
		response.Completed = err == nil
	case OperationBatchArchive:
		batch, batchErr := service.BatchArchive(ctx, BatchOptions{IDs: request.IDs, Execute: request.Execute, Actor: request.Actor, MinimumAge: minimumAge})
		copyBatchResponse(response, batch)
		err = batchErr
	case OperationBatchUnarchive:
		batch, batchErr := service.BatchUnarchive(ctx, BatchOptions{IDs: request.IDs, Execute: request.Execute, Actor: request.Actor})
		copyBatchResponse(response, batch)
		err = batchErr
	case OperationHardDelete:
		if !capabilities.HardDelete {
			result := Result{TaskID: request.TaskID, Operation: OperationHardDelete, Reasons: []Reason{{Code: ReasonPermissionRequired, Message: "Hard-delete requires a trusted delete capability"}}}
			response.Items = append(response.Items, result)
			response.Processed = 1
			response.Completed = false
			break
		}
		result, deleteErr := service.HardDelete(ctx, request.TaskID, HardDeleteOptions{Actor: request.Actor, Reason: request.Reason, Confirmed: request.Confirmed})
		if result != nil {
			response.Items = append(response.Items, *result)
			response.Processed = 1
			if result.Changed {
				response.Changed = 1
			}
		}
		response.Completed = deleteErr == nil && result != nil && result.Eligible
		err = deleteErr
	}
	if err != nil && response.FailedTaskID == "" {
		response.FailedTaskID = request.TaskID
	}
	if err != nil {
		if len(response.Items) == 0 {
			response.Items = append(response.Items, Result{TaskID: request.TaskID, Operation: request.Operation, Reasons: []Reason{publicFailureReason(err)}})
			response.Processed = 1
		} else if len(response.Items[len(response.Items)-1].Reasons) == 0 {
			response.Items[len(response.Items)-1].Reasons = append(response.Items[len(response.Items)-1].Reasons, publicFailureReason(err))
		}
	}
	for index := range response.Items {
		item := &response.Items[index]
		if task, getErr := service.store.Tasks.Get(item.TaskID); getErr == nil {
			item.After = task.LifecycleState()
			item.CompletedAt = cloneTime(task.CompletedAt)
			item.ArchivedAt = cloneTime(task.ArchivedAt)
		}
	}
	return response, contractError(response, err)
}

func isArchiveOperation(operation Operation) bool {
	switch operation {
	case OperationArchive, OperationReopen, OperationBatchArchive, OperationBatchUnarchive:
		return true
	default:
		return false
	}
}

func copyBatchResponse(response *Response, batch *BatchResult) {
	if response == nil || batch == nil {
		return
	}
	response.Execute = batch.Execute
	response.Completed = batch.Completed
	response.Processed = batch.Processed
	response.Changed = batch.Changed
	response.FailedTaskID = batch.FailedTaskID
	response.Items = append(response.Items[:0], batch.Items...)
}

func (service *Service) populateResultLifecycle(result *Result) {
	if service == nil || service.store == nil || result == nil || result.TaskID == "" {
		return
	}
	task, err := service.store.Tasks.Get(result.TaskID)
	if err != nil {
		return
	}
	result.After = task.LifecycleState()
	result.CompletedAt = cloneTime(task.CompletedAt)
	result.ArchivedAt = cloneTime(task.ArchivedAt)
}

// UpdateTask applies an arbitrary public Task patch to a fresh canonical copy,
// including status lifecycle clocks, and persists Task plus history under one
// lifecycle transaction. Index hooks run only after the lock is released.
func (service *Service) UpdateTask(ctx context.Context, taskID string, options TaskUpdateOptions) (*models.Task, error) {
	var updated *models.Task
	err := service.store.WithTaskLifecycleTransaction(ctx, func(tx *storage.TaskLifecycleTransaction) error {
		current, err := tx.GetTask(taskID)
		if err != nil {
			return err
		}
		if current.Archived {
			return fmt.Errorf("Task %q is archived; reopen it before updating", taskID)
		}
		before := cloneTask(current)
		candidate := cloneTask(current)
		if options.Mutate != nil {
			if err := options.Mutate(candidate); err != nil {
				return err
			}
		}
		requestedStatus := candidate.Status
		candidate.ID = current.ID
		candidate.CreatedAt = current.CreatedAt
		candidate.Archived = current.Archived
		candidate.CompletedAt = cloneTime(current.CompletedAt)
		candidate.ArchivedAt = cloneTime(current.ArchivedAt)
		candidate.Status = current.Status
		now := service.now().UTC()
		ApplyStatusTransition(candidate, requestedStatus, now)
		candidate.UpdatedAt = now
		if err := tx.UpdateTask(candidate); err != nil {
			return err
		}
		if err := tx.SaveTaskVersion(before, candidate, options.Actor, now, ""); err != nil {
			_ = tx.UpdateTask(before)
			return err
		}
		updated = cloneTask(candidate)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := service.indexTask(taskID); err != nil {
		return updated, err
	}
	return updated, nil
}

func (service *Service) archiveInTransaction(tx *storage.TaskLifecycleTransaction, taskID string, options ArchiveOptions, settings models.TaskLifecycleSettings, now time.Time) (Result, error) {
	task, err := tx.GetTask(taskID)
	if err != nil {
		return Result{}, err
	}
	pending, err := tx.GetIncompleteTaskLifecyclePending(taskID, string(OperationArchive))
	if err != nil {
		return Result{}, err
	}
	if pending != nil {
		result := Result{
			TaskID: task.ID, Operation: OperationArchive, Eligible: true,
			Before: pending.From, After: pending.From, Reasons: []Reason{},
			Warnings: durableKnowledgeWarnings(task), Event: eventFromPending(pending),
		}
		if pending.CanonicalComplete {
			result.After = pending.To
			return result, nil
		}
		if _, err := resumeLifecycleMutation(tx, pending); err != nil {
			return result, rollbackLifecycleMutation(tx, pending, err)
		}
		result.Changed = true
		result.After = pending.To
		return result, nil
	}
	if task.Archived {
		result := Result{TaskID: task.ID, Operation: OperationArchive, Eligible: true, Before: models.TaskLifecycleArchived, After: models.TaskLifecycleArchived, Reasons: []Reason{{Code: ReasonAlreadyArchived, Message: "Task is already archived"}}, Warnings: durableKnowledgeWarnings(task)}
		if task.ArchivedAt == nil {
			event := Event{ID: lifecycleEventID(task.ID, OperationArchive, now), Type: OperationArchive, TaskID: task.ID, At: now, Actor: options.Actor, From: result.Before, To: result.After, Automatic: options.Automatic}
			desired := cloneTask(task)
			desired.ArchivedAt = timePointer(now)
			desired.UpdatedAt = now
			pending = pendingForTransition(event, task, desired)
			if err := tx.SaveTaskLifecyclePending(pending); err != nil {
				return result, err
			}
			if _, err := resumeLifecycleMutation(tx, pending); err != nil {
				return result, rollbackLifecycleMutation(tx, pending, err)
			}
			result.Changed = true
			result.Event = &event
		}
		return result, nil
	}
	eligibility, err := evaluateInTransaction(tx, task, now, settings, options)
	if err != nil {
		return Result{}, err
	}
	if !eligibility.Eligible {
		return resultFromEligibility(OperationArchive, eligibility), nil
	}
	return service.archiveTaskInTransaction(tx, task, options, eligibility, now)
}

func (service *Service) archiveTaskInTransaction(tx *storage.TaskLifecycleTransaction, task *models.Task, options ArchiveOptions, eligibility Eligibility, now time.Time) (Result, error) {
	result := resultFromEligibility(OperationArchive, eligibility)
	event := Event{ID: lifecycleEventID(task.ID, OperationArchive, now), Type: OperationArchive, TaskID: task.ID, At: now, Actor: options.Actor, From: result.Before, To: models.TaskLifecycleArchived, Automatic: options.Automatic}
	desired := cloneTask(task)
	desired.Archived = true
	desired.ArchivedAt = timePointer(now)
	desired.UpdatedAt = now
	pending := pendingForTransition(event, task, desired)
	if err := tx.SaveTaskLifecyclePending(pending); err != nil {
		return result, err
	}
	if _, err := resumeLifecycleMutation(tx, pending); err != nil {
		return result, rollbackLifecycleMutation(tx, pending, err)
	}
	result.Changed = true
	result.After = models.TaskLifecycleArchived
	result.Event = &event
	return result, nil
}

func (service *Service) resolveBatchIDs(ctx context.Context, requested []string) ([]string, error) {
	ids := append([]string(nil), requested...)
	if len(ids) > 0 {
		return uniqueSorted(ids), nil
	}
	err := service.store.WithTaskLifecycleTransaction(ctx, func(tx *storage.TaskLifecycleTransaction) error {
		tasks, err := tx.ListActiveTasks()
		if err != nil {
			return err
		}
		for _, task := range tasks {
			ids = append(ids, task.ID)
		}
		pending, err := tx.ListTaskLifecyclePending(string(OperationArchive))
		if err != nil {
			return err
		}
		for _, record := range pending {
			ids = append(ids, record.TaskID)
		}
		return nil
	})
	return uniqueSorted(ids), err
}

func rollbackLifecycleMutation(tx *storage.TaskLifecycleTransaction, pending *models.TaskLifecyclePending, cause error) error {
	if pending == nil || pending.Original == nil {
		return cause
	}
	var rollbackErrors []string
	if err := tx.RollbackTaskLifecycleVersion(pending.TaskID, pending.EventID); err != nil {
		rollbackErrors = append(rollbackErrors, "version: "+err.Error())
	}
	current, err := tx.GetTask(pending.TaskID)
	if err == nil {
		original := taskWithLifecycleData(current, pending.Original)
		err = tx.PatchTaskLifecycle(original)
		if err == nil && pending.Original.Archived != current.Archived {
			if pending.Original.Archived {
				err = tx.ArchiveTask(original.ID)
			} else {
				err = tx.UnarchiveTask(original.ID)
			}
		}
	}
	if err != nil {
		rollbackErrors = append(rollbackErrors, "canonical: "+err.Error())
	}
	if err := tx.DeleteTaskLifecyclePending(pending.TaskID, pending.Operation, pending.EventID); err != nil {
		rollbackErrors = append(rollbackErrors, "pending: "+err.Error())
	}
	if len(rollbackErrors) > 0 {
		return fmt.Errorf("%w; rollback Task %q lifecycle mutation: %s", cause, pending.TaskID, strings.Join(rollbackErrors, "; "))
	}
	return cause
}

func resumeLifecycleMutation(tx *storage.TaskLifecycleTransaction, pending *models.TaskLifecyclePending) (*models.Task, error) {
	if pending == nil || pending.Original == nil || pending.Desired == nil {
		return nil, fmt.Errorf("resume Task lifecycle: original and desired metadata are required")
	}
	task, err := tx.GetTask(pending.TaskID)
	if err != nil {
		return nil, err
	}

	// A completed checkpoint may only be trusted after every durable phase is
	// present. Current location/status alone never implies completion.
	if pending.CanonicalComplete && pending.MoveComplete && pending.PatchComplete && pending.VersionComplete && lifecycleDataMatches(task, pending.Desired) {
		hasVersion, err := tx.HasTaskLifecycleVersion(pending.TaskID, pending.EventID)
		if err != nil {
			return nil, err
		}
		if hasVersion {
			return task, nil
		}
	}
	pending.CanonicalComplete = false

	if task.Archived != pending.Desired.Archived {
		if pending.Desired.Archived {
			err = tx.ArchiveTask(task.ID)
		} else {
			err = tx.UnarchiveTask(task.ID)
		}
		if err != nil {
			return nil, err
		}
		task, err = tx.GetTask(task.ID)
		if err != nil {
			return nil, err
		}
	}
	pending.MoveComplete = true
	if err := tx.SaveTaskLifecyclePending(pending); err != nil {
		return nil, err
	}

	if !lifecycleDataMatches(task, pending.Desired) {
		desired := taskWithLifecycleData(task, pending.Desired)
		if err := tx.PatchTaskLifecycle(desired); err != nil {
			return nil, err
		}
		task = desired
	}
	pending.PatchComplete = true
	if err := tx.SaveTaskLifecyclePending(pending); err != nil {
		return nil, err
	}

	hasVersion, err := tx.HasTaskLifecycleVersion(pending.TaskID, pending.EventID)
	if err != nil {
		return nil, err
	}
	if !hasVersion {
		original := taskWithLifecycleData(task, pending.Original)
		desired := taskWithLifecycleData(task, pending.Desired)
		if err := tx.SaveTaskVersion(original, desired, pending.Actor, pending.At, pending.EventID); err != nil {
			return nil, err
		}
	}
	pending.VersionComplete = true
	if err := tx.SaveTaskLifecyclePending(pending); err != nil {
		return nil, err
	}

	pending.CanonicalComplete = true
	if err := tx.SaveTaskLifecyclePending(pending); err != nil {
		return nil, err
	}
	return taskWithLifecycleData(task, pending.Desired), nil
}

func lifecycleEventID(taskID string, operation Operation, at time.Time) string {
	var entropy [8]byte
	if _, err := rand.Read(entropy[:]); err == nil {
		return fmt.Sprintf("task:%s:%s:%d:%x", taskID, operation, at.UTC().UnixNano(), entropy)
	}
	return fmt.Sprintf("task:%s:%s:%d", taskID, operation, at.UTC().UnixNano())
}

func pendingFromEvent(event Event) *models.TaskLifecyclePending {
	return &models.TaskLifecyclePending{
		EventID:   event.ID,
		TaskID:    event.TaskID,
		Operation: string(event.Type),
		At:        event.At.UTC(),
		Actor:     event.Actor,
		Reason:    event.Reason,
		From:      event.From,
		To:        event.To,
		Automatic: event.Automatic,
	}
}

func pendingForTransition(event Event, original, desired *models.Task) *models.TaskLifecyclePending {
	pending := pendingFromEvent(event)
	pending.Original = lifecycleDataFromTask(original)
	pending.Desired = lifecycleDataFromTask(desired)
	return pending
}

func lifecycleDataFromTask(task *models.Task) *models.TaskLifecycleData {
	if task == nil {
		return nil
	}
	return &models.TaskLifecycleData{
		Status:      task.Status,
		UpdatedAt:   task.UpdatedAt,
		CompletedAt: cloneTimePointer(task.CompletedAt),
		ArchivedAt:  cloneTimePointer(task.ArchivedAt),
		Archived:    task.Archived,
	}
}

func taskWithLifecycleData(task *models.Task, data *models.TaskLifecycleData) *models.Task {
	result := cloneTask(task)
	if result == nil || data == nil {
		return result
	}
	result.Status = data.Status
	result.UpdatedAt = data.UpdatedAt
	result.CompletedAt = cloneTimePointer(data.CompletedAt)
	result.ArchivedAt = cloneTimePointer(data.ArchivedAt)
	result.Archived = data.Archived
	return result
}

func lifecycleDataMatches(task *models.Task, data *models.TaskLifecycleData) bool {
	if task == nil || data == nil {
		return false
	}
	return task.Status == data.Status &&
		task.UpdatedAt.Equal(data.UpdatedAt) &&
		timePointersEqual(task.CompletedAt, data.CompletedAt) &&
		timePointersEqual(task.ArchivedAt, data.ArchivedAt) &&
		task.Archived == data.Archived
}

func cloneTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func timePointersEqual(left, right *time.Time) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Equal(*right)
}

func eventFromPending(pending *models.TaskLifecyclePending) *Event {
	if pending == nil {
		return nil
	}
	return &Event{
		ID:        pending.EventID,
		Type:      Operation(pending.Operation),
		TaskID:    pending.TaskID,
		At:        pending.At,
		Actor:     pending.Actor,
		Reason:    pending.Reason,
		From:      pending.From,
		To:        pending.To,
		Automatic: pending.Automatic,
	}
}

// flushTaskLifecyclePending delivers durable lifecycle side effects without
// holding the project lock across callbacks. Durable leases prevent concurrent
// invocation in the normal case. Delivery remains at-least-once across a crash
// after a hook succeeds but before its checkpoint is saved; event sinks must
// deduplicate by Event.ID.
func (service *Service) flushTaskLifecyclePending(ctx context.Context, taskID string) ([]Warning, bool, error) {
	var pending []*models.TaskLifecyclePending
	err := service.store.WithTaskLifecycleTransaction(ctx, func(tx *storage.TaskLifecycleTransaction) error {
		records, err := tx.ListTaskLifecyclePending("")
		if err != nil {
			return err
		}
		for _, record := range records {
			canonicalReady := record.CanonicalComplete
			if Operation(record.Operation) == OperationArchive || Operation(record.Operation) == OperationReopen {
				canonicalReady = canonicalReady && record.MoveComplete && record.PatchComplete && record.VersionComplete
			}
			if record.TaskID == taskID && canonicalReady {
				copy := *record
				pending = append(pending, &copy)
			}
		}
		return nil
	})
	if err != nil {
		return nil, false, err
	}

	warnings := []Warning{}
	hadPending := len(pending) > 0
	for _, record := range pending {
		if err := ctx.Err(); err != nil {
			return warnings, hadPending, err
		}
		if !record.EventDelivered {
			claimed, acquired, err := service.claimPendingPhase(ctx, record, false)
			if err != nil {
				return warnings, hadPending, err
			}
			if !acquired {
				if claimed == nil || !claimed.EventDelivered {
					continue
				}
				record = claimed
			} else {
				record = claimed
				if service.hooks.Emit != nil {
					if err := service.hooks.Emit(*eventFromPending(record)); err != nil {
						warnings = append(warnings, Warning{Code: WarningEventDeliveryError, Message: err.Error()})
						if releaseErr := service.releasePendingClaim(ctx, record, false); releaseErr != nil {
							return warnings, hadPending, releaseErr
						}
					} else {
						record.EventDelivered = true
						if err := service.completePendingPhase(ctx, record, false); err != nil {
							return warnings, hadPending, err
						}
					}
				} else {
					record.EventDelivered = true
					if err := service.completePendingPhase(ctx, record, false); err != nil {
						return warnings, hadPending, err
					}
				}
			}
		}

		if !record.DerivedApplied {
			claimed, acquired, err := service.claimPendingPhase(ctx, record, true)
			if err != nil {
				return warnings, hadPending, err
			}
			if !acquired {
				continue
			}
			record = claimed
			var derivedErr error
			if Operation(record.Operation) == OperationHardDelete {
				derivedErr = service.removeFromIndex(record.TaskID)
			} else {
				derivedErr = service.indexTask(record.TaskID)
			}
			if derivedErr != nil {
				if releaseErr := service.releasePendingClaim(ctx, record, true); releaseErr != nil {
					return warnings, hadPending, fmt.Errorf("%w; release derived claim: %v", derivedErr, releaseErr)
				}
				return warnings, hadPending, derivedErr
			}
			record.DerivedApplied = true
			if err := service.completePendingPhase(ctx, record, true); err != nil {
				return warnings, hadPending, err
			}
		}
	}
	return warnings, hadPending, nil
}

const taskLifecycleClaimLease = 5 * time.Minute

func (service *Service) claimPendingPhase(ctx context.Context, pending *models.TaskLifecyclePending, derived bool) (*models.TaskLifecyclePending, bool, error) {
	var claimed *models.TaskLifecyclePending
	acquired := false
	err := service.store.WithTaskLifecycleTransaction(ctx, func(tx *storage.TaskLifecycleTransaction) error {
		current, err := tx.GetTaskLifecyclePendingEvent(pending.TaskID, pending.Operation, pending.EventID)
		if err != nil {
			return err
		}
		if current == nil {
			return nil
		}
		if (!derived && current.EventDelivered) || (derived && current.DerivedApplied) {
			copy := *current
			claimed = &copy
			return nil
		}
		now := service.now().UTC()
		claim := current.EventClaim
		if derived {
			claim = current.DerivedClaim
		}
		if claim != nil && now.Before(claim.ClaimedAt.Add(taskLifecycleClaimLease)) {
			return nil
		}
		newClaim := &models.TaskLifecycleClaim{Token: lifecycleEventID(current.TaskID, Operation(current.Operation), now), ClaimedAt: now}
		if derived {
			current.DerivedClaim = newClaim
		} else {
			current.EventClaim = newClaim
		}
		if err := tx.SaveTaskLifecyclePending(current); err != nil {
			return err
		}
		copy := *current
		claimed = &copy
		acquired = true
		return nil
	})
	return claimed, acquired, err
}

func (service *Service) completePendingPhase(ctx context.Context, pending *models.TaskLifecyclePending, derived bool) error {
	return service.store.WithTaskLifecycleTransaction(ctx, func(tx *storage.TaskLifecycleTransaction) error {
		current, err := tx.GetTaskLifecyclePendingEvent(pending.TaskID, pending.Operation, pending.EventID)
		if err != nil || current == nil {
			return err
		}
		if derived {
			current.DerivedApplied = true
			current.DerivedClaim = nil
		} else {
			current.EventDelivered = true
			current.EventClaim = nil
		}
		if current.EventDelivered && current.DerivedApplied {
			return tx.DeleteTaskLifecyclePending(current.TaskID, current.Operation, current.EventID)
		}
		return tx.SaveTaskLifecyclePending(current)
	})
}

func (service *Service) releasePendingClaim(ctx context.Context, pending *models.TaskLifecyclePending, derived bool) error {
	return service.store.WithTaskLifecycleTransaction(ctx, func(tx *storage.TaskLifecycleTransaction) error {
		current, err := tx.GetTaskLifecyclePendingEvent(pending.TaskID, pending.Operation, pending.EventID)
		if err != nil || current == nil {
			return err
		}
		var expected, actual *models.TaskLifecycleClaim
		if derived {
			expected, actual = pending.DerivedClaim, current.DerivedClaim
		} else {
			expected, actual = pending.EventClaim, current.EventClaim
		}
		if expected == nil || actual == nil || expected.Token != actual.Token {
			return nil
		}
		if derived {
			current.DerivedClaim = nil
		} else {
			current.EventClaim = nil
		}
		return tx.SaveTaskLifecyclePending(current)
	})
}

func (service *Service) settings() (models.TaskLifecycleSettings, error) {
	if service == nil || service.store == nil {
		return models.TaskLifecycleSettings{}, fmt.Errorf("task lifecycle service: store is required")
	}
	project, err := service.store.Config.Load()
	if err != nil {
		return models.TaskLifecycleSettings{}, err
	}
	return project.Settings.EffectiveTaskLifecycle(), nil
}

func (service *Service) removeFromIndex(taskID string) error {
	if service.hooks.RemoveTask == nil {
		return nil
	}
	if err := service.hooks.RemoveTask(taskID); err != nil {
		return fmt.Errorf("remove Task %q from index: %w", taskID, err)
	}
	return nil
}

func (service *Service) indexTask(taskID string) error {
	if service.hooks.IndexTask == nil {
		return nil
	}
	if err := service.hooks.IndexTask(taskID); err != nil {
		return fmt.Errorf("index Task %q lifecycle state: %w", taskID, err)
	}
	return nil
}

func (service *Service) emit(result *Result) {
	if result == nil || result.Event == nil || service.hooks.Emit == nil {
		return
	}
	if err := service.hooks.Emit(*result.Event); err != nil {
		result.Warnings = append(result.Warnings, Warning{Code: WarningEventDeliveryError, Message: err.Error()})
	}
}

func resultFromEligibility(operation Operation, eligibility Eligibility) Result {
	return Result{
		TaskID:      eligibility.TaskID,
		Operation:   operation,
		Eligible:    eligibility.Eligible,
		Before:      eligibility.Lifecycle,
		After:       eligibility.Lifecycle,
		Reasons:     append([]Reason(nil), eligibility.Reasons...),
		Warnings:    append([]Warning(nil), eligibility.Warnings...),
		CompletedAt: cloneTime(eligibility.CompletedAt),
		ArchivedAt:  cloneTime(eligibility.ArchivedAt),
		Deadline:    cloneTime(eligibility.Deadline),
	}
}

func uniqueSorted(ids []string) []string {
	sort.Strings(ids)
	result := ids[:0]
	for _, id := range ids {
		if len(result) == 0 || result[len(result)-1] != id {
			result = append(result, id)
		}
	}
	return result
}

func isNotFound(err error) bool {
	return err != nil && strings.Contains(err.Error(), "not found")
}

func publicFailureReason(err error) Reason {
	code := ReasonOperationFailed
	if isNotFound(err) {
		code = ReasonNotFound
	}
	return Reason{Code: code, Message: err.Error()}
}
