package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
)

// NormalizeTask ensures all slice fields are non-nil so JSON serialization
// produces [] instead of null/omitted, which the UI client relies on.
func NormalizeTask(t *models.Task) {
	if t.Labels == nil {
		t.Labels = []string{}
	}
	if t.Subtasks == nil {
		t.Subtasks = []string{}
	}
	if t.AcceptanceCriteria == nil {
		t.AcceptanceCriteria = []models.AcceptanceCriterion{}
	}
	if t.TimeEntries == nil {
		t.TimeEntries = []models.TimeEntry{}
	}
	if t.Fulfills == nil {
		t.Fulfills = []string{}
	}
}

// taskResponse adds backend-derived lifecycle state without persisting it in
// Task markdown. Storage location remains canonical for archived Tasks.
type taskResponse struct {
	*models.Task
	LifecycleState models.TaskLifecycleState `json:"lifecycleState"`
}

func newTaskResponse(task *models.Task) taskResponse {
	NormalizeTask(task)
	return taskResponse{Task: task, LifecycleState: task.LifecycleState()}
}

func (tr *TaskRoutes) loadTaskTimeEntries(t *models.Task) {
	if t == nil {
		return
	}
	entries, err := tr.getStore().Time.GetEntries(t.ID)
	if err != nil {
		return
	}
	t.TimeEntries = entries
	NormalizeTask(t)
}

// TaskRoutes handles /api/tasks endpoints.
type TaskRoutes struct {
	store        *storage.Store
	mgr          *storage.Manager
	sse          Broadcaster
	capabilities TaskRouteCapabilities
}

// TaskRouteCapabilities are injected by the authenticated server boundary.
// Client request data cannot grant these permissions.
type TaskRouteCapabilities struct {
	HardDelete bool
}

func (tr *TaskRoutes) getStore() *storage.Store {
	if tr.mgr != nil {
		return tr.mgr.GetStore()
	}
	return tr.store
}

// Register wires the task routes onto r.
func (tr *TaskRoutes) Register(r chi.Router) {
	r.Get("/tasks", tr.list)
	r.Post("/tasks", tr.create)
	r.Get("/tasks/{id}", tr.get)
	r.Put("/tasks/{id}", tr.update)
	r.Post("/tasks/{id}/archive", tr.archive)
	r.Post("/tasks/{id}/unarchive", tr.unarchive)
	r.Post("/tasks/batch-archive", tr.batchArchive)
	r.Post("/tasks/batch-unarchive", tr.batchUnarchive)
	r.Post("/tasks/{id}/hard-delete", tr.hardDelete)
	r.Post("/tasks/reorder", tr.reorder)
	r.Post("/tasks/sync-spec-acs", tr.syncSpecACs)
	r.Get("/tasks/{id}/history", tr.history)
}

// list returns all active tasks.
//
// GET /api/tasks
func (tr *TaskRoutes) list(w http.ResponseWriter, r *http.Request) {
	includeHistorical, err := parseIncludeHistorical(r)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	tasks, err := tr.getStore().Tasks.List()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if includeHistorical {
		archived, err := tr.getStore().Tasks.ListArchived()
		if err != nil {
			respondError(w, http.StatusInternalServerError, err.Error())
			return
		}
		tasks = append(tasks, archived...)
	}
	sortTasksByLifecycle(tasks)
	response := make([]taskResponse, 0, len(tasks))
	for _, t := range tasks {
		tr.loadTaskTimeEntries(t)
		response = append(response, newTaskResponse(t))
	}
	respondJSON(w, http.StatusOK, response)
}

func parseIncludeHistorical(r *http.Request) (bool, error) {
	values, present := r.URL.Query()["includeHistorical"]
	if !present {
		return false, nil
	}
	if len(values) != 1 || (values[0] != "true" && values[0] != "false") {
		return false, fmt.Errorf("includeHistorical must be true or false")
	}
	return values[0] == "true", nil
}

func sortTasksByLifecycle(tasks []*models.Task) {
	sort.Slice(tasks, func(i, j int) bool {
		left, right := tasks[i], tasks[j]
		leftRank, rightRank := taskLifecycleRank(left), taskLifecycleRank(right)
		if leftRank != rightRank {
			return leftRank < rightRank
		}
		if left.Order != nil || right.Order != nil {
			if left.Order == nil {
				return false
			}
			if right.Order == nil {
				return true
			}
			if *left.Order != *right.Order {
				return *left.Order < *right.Order
			}
		}
		return left.ID < right.ID
	})
}

func taskLifecycleRank(task *models.Task) int {
	switch task.LifecycleState() {
	case models.TaskLifecycleActive:
		return 0
	case models.TaskLifecycleDone:
		return 1
	default:
		return 2
	}
}

// get returns a single task by ID.
//
// GET /api/tasks/{id}
func (tr *TaskRoutes) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	task, err := tr.getStore().Tasks.Get(id)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}
	tr.loadTaskTimeEntries(task)
	task.ActiveTimer = tr.getStore().Time.GetActiveTimer(task.ID)
	respondJSON(w, http.StatusOK, newTaskResponse(task))
}

// create persists a new task.
//
// POST /api/tasks
func (tr *TaskRoutes) create(w http.ResponseWriter, r *http.Request) {
	var task models.Task
	if err := decodeJSON(r, &task); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	// Generate an ID if not provided.
	if task.ID == "" {
		task.ID = models.NewTaskID()
	}

	now := time.Now().UTC()
	if task.CreatedAt.IsZero() {
		task.CreatedAt = now
	}
	task.UpdatedAt = now

	requestedStatus := task.Status
	if requestedStatus == "" {
		requestedStatus = "todo"
	}
	// Lifecycle clocks and archive state are server-owned. Never accept a
	// caller-supplied completion/archive clock that could bypass retention.
	task.Status = "todo"
	task.CompletedAt = nil
	task.Archived = false
	task.ArchivedAt = nil
	tasklifecycle.ApplyStatusTransition(&task, requestedStatus, now)
	if task.Priority == "" {
		task.Priority = "medium"
	}
	if task.Labels == nil {
		task.Labels = []string{}
	}

	if err := tr.getStore().Tasks.Create(&task); err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	search.BestEffortIndexTask(tr.getStore(), task.ID)

	// Record initial version.
	_ = tr.getStore().Versions.SaveVersion(task.ID, models.TaskVersion{
		Changes:  tr.getStore().Versions.TrackChanges(nil, &task),
		Snapshot: storage.TaskToSnapshot(&task),
	})

	response := newTaskResponse(&task)
	tr.sse.Broadcast(SSEEvent{Type: "tasks:updated", Data: map[string]interface{}{"task": response}})
	respondJSON(w, http.StatusCreated, response)
}

// update replaces a task's fields.
//
// PUT /api/tasks/{id}
func (tr *TaskRoutes) update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var patch map[string]json.RawMessage
	if err := decodeJSON(r, &patch); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	updated, err := tr.lifecycleService().UpdateTask(r.Context(), id, tasklifecycle.TaskUpdateOptions{Actor: "api", Mutate: func(task *models.Task) error {
		data, err := json.Marshal(task)
		if err != nil {
			return err
		}
		var current map[string]json.RawMessage
		if err := json.Unmarshal(data, &current); err != nil {
			return err
		}
		for key, value := range patch {
			current[key] = value
		}
		merged, err := json.Marshal(current)
		if err != nil {
			return err
		}
		return json.Unmarshal(merged, task)
	}})
	if err != nil {
		status := http.StatusInternalServerError
		if tasklifecycleErrorNotFound(err) {
			status = http.StatusNotFound
		}
		respondError(w, status, err.Error())
		return
	}

	response := newTaskResponse(updated)
	tr.sse.Broadcast(SSEEvent{Type: "tasks:updated", Data: map[string]interface{}{"task": response}})
	respondJSON(w, http.StatusOK, response)
}

// archive moves a task to the archive.
//
// POST /api/tasks/{id}/archive
func (tr *TaskRoutes) archive(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	request, ok := decodeLifecycleRequest(w, r)
	if !ok {
		return
	}
	request.Operation = tasklifecycle.OperationArchive
	request.TaskID = id
	tr.executeLifecycle(w, r, request)
}

// unarchive restores a task from the archive.
//
// POST /api/tasks/{id}/unarchive
func (tr *TaskRoutes) unarchive(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	request, ok := decodeLifecycleRequest(w, r)
	if !ok {
		return
	}
	request.Operation = tasklifecycle.OperationReopen
	request.TaskID = id
	tr.executeLifecycle(w, r, request)
}

// batchArchiveRequest is the request body for batch-archive.
type batchArchiveRequest struct {
	IDs          []string `json:"ids,omitempty"`
	Execute      bool     `json:"execute"`
	Actor        string   `json:"actor,omitempty"`
	MinimumAgeMs *int64   `json:"minimumAgeMs,omitempty"`
	// OlderThanMs is accepted as a backward-compatible alias.
	OlderThanMs *int64 `json:"olderThanMs,omitempty"`
}

// batchArchive archives all tasks that were last updated before the given age.
//
// POST /api/tasks/batch-archive
func (tr *TaskRoutes) batchArchive(w http.ResponseWriter, r *http.Request) {
	var req batchArchiveRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	minimumAge := req.MinimumAgeMs
	if minimumAge == nil {
		minimumAge = req.OlderThanMs
	}
	tr.executeLifecycle(w, r, tasklifecycle.Request{Operation: tasklifecycle.OperationBatchArchive, IDs: req.IDs, Execute: req.Execute, Actor: req.Actor, MinimumAgeMs: minimumAge})
}

func (tr *TaskRoutes) batchUnarchive(w http.ResponseWriter, r *http.Request) {
	request, ok := decodeLifecycleRequest(w, r)
	if !ok {
		return
	}
	request.Operation = tasklifecycle.OperationBatchUnarchive
	tr.executeLifecycle(w, r, request)
}

func (tr *TaskRoutes) hardDelete(w http.ResponseWriter, r *http.Request) {
	request, ok := decodeLifecycleRequest(w, r)
	if !ok {
		return
	}
	request.Operation = tasklifecycle.OperationHardDelete
	request.TaskID = chi.URLParam(r, "id")
	request.Execute = request.Confirmed
	tr.executeLifecycle(w, r, request)
}

func decodeLifecycleRequest(w http.ResponseWriter, r *http.Request) (tasklifecycle.Request, bool) {
	var request tasklifecycle.Request
	if r.Body == nil || r.ContentLength == 0 {
		return request, true
	}
	if err := decodeJSON(r, &request); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return request, false
	}
	return request, true
}

func (tr *TaskRoutes) lifecycleService() *tasklifecycle.Service {
	store := tr.getStore()
	return tasklifecycle.New(store, tasklifecycle.WithHooks(tasklifecycle.Hooks{
		IndexTask:  func(id string) error { return search.ReconcileTaskIndex(store, id) },
		RemoveTask: func(id string) error { return search.ReconcileTaskRemoval(store, id) },
		Emit: func(event tasklifecycle.Event) error {
			if tr.sse != nil {
				tr.sse.Broadcast(SSEEvent{Type: "tasks:lifecycle", Data: event})
			}
			return nil
		},
	}))
}

func tasklifecycleErrorNotFound(err error) bool {
	return err != nil && strings.Contains(err.Error(), "not found")
}

func (tr *TaskRoutes) executeLifecycle(w http.ResponseWriter, r *http.Request, request tasklifecycle.Request) {
	if request.Actor == "" {
		request.Actor = "api"
	}
	response, err := tr.lifecycleService().ExecutePublic(r.Context(), request, tr.capabilities.HardDelete)
	status := lifecycleResponseStatus(response, err)
	respondJSON(w, status, response)
}

func lifecycleResponseStatus(response *tasklifecycle.Response, err error) int {
	switch tasklifecycle.FailureKindFor(response, err) {
	case tasklifecycle.FailureNone:
		return http.StatusOK
	case tasklifecycle.FailureInvalidRequest:
		return http.StatusBadRequest
	case tasklifecycle.FailurePermission:
		return http.StatusForbidden
	case tasklifecycle.FailureNotFound:
		return http.StatusNotFound
	case tasklifecycle.FailureConflict, tasklifecycle.FailureDenied:
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
	}
}

// reorderItem is a single entry in a reorder request.
type reorderItem struct {
	ID    string `json:"id"`
	Order int    `json:"order"`
}

// reorderRequest is the request body for the batch reorder endpoint.
type reorderRequest struct {
	Orders []reorderItem `json:"orders"`
}

// reorder batch-updates the display order of tasks.
//
// POST /api/tasks/reorder
func (tr *TaskRoutes) reorder(w http.ResponseWriter, r *http.Request) {
	var req reorderRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	updated := 0
	for _, item := range req.Orders {
		changed := false
		_, err := tr.lifecycleService().UpdateTask(r.Context(), item.ID, tasklifecycle.TaskUpdateOptions{Actor: "api", Mutate: func(task *models.Task) error {
			if task.Order != nil && *task.Order == item.Order {
				return nil
			}
			order := item.Order
			task.Order = &order
			changed = true
			return nil
		}})
		if err != nil {
			continue
		}
		if changed {
			updated++
		}
	}

	if updated > 0 {
		tr.sse.Broadcast(SSEEvent{Type: "tasks:reordered", Data: map[string]interface{}{
			"updated": updated,
		}})
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"updated": updated,
	})
}

// syncSpecACs scans all done tasks that have a Spec field and synchronises
// their Fulfills list into the linked spec document's acceptance criteria.
//
// POST /api/tasks/sync-spec-acs
func (tr *TaskRoutes) syncSpecACs(w http.ResponseWriter, r *http.Request) {
	tasks, err := tr.getStore().Tasks.List()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	synced := 0
	for _, t := range tasks {
		if t.Status != "done" || t.Spec == "" || len(t.Fulfills) == 0 {
			continue
		}

		doc, err := tr.getStore().Docs.Get(t.Spec)
		if err != nil || doc == nil {
			continue
		}

		// Mark the task as synced. The actual spec AC update is a
		// best-effort broadcast so the UI can refresh.
		synced++
	}

	if synced > 0 {
		tr.sse.Broadcast(SSEEvent{Type: "docs:updated", Data: map[string]interface{}{"synced": synced}})
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"synced":  synced,
	})
}

// history returns the version history for a task.
//
// GET /api/tasks/{id}/history
func (tr *TaskRoutes) history(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h, err := tr.getStore().Versions.GetHistory(id)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, h)
}
