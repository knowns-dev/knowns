package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/permissions"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
	"github.com/mark3labs/mcp-go/mcp"
)

// RegisterTaskTool registers the consolidated task management MCP tool.
// This includes the board view (previously in board.go).
func RegisterTaskTool(s toolRegistrar, getStore func() *storage.Store) {
	s.AddTool(
		mcp.NewTool("tasks",
			mcp.WithDescription(`Task management operations. Use 'action' to specify: create, get, update, delete, list, history, board, archive, unarchive, batch_archive, batch_unarchive, hard_delete.

- create: Create a task or subtask. Required: title. Optional: description, status, priority, assignee, labels, parent, spec, fulfills, order. Returns: created task with ID and metadata.
- get: Read task details. Required: taskId. Optional: none. Returns: task metadata, acceptance criteria, plan, notes, spec links, and time spent.
- update: Modify task fields, ACs, plan, or notes. Required: taskId. Optional: title, description, status, priority, assignee, labels, spec, fulfills, order, addAc, checkAc, uncheckAc, removeAc, plan, notes, appendNotes, clear. Returns: updated task.
- delete: Remove a task or preview removal. Required: taskId. Optional: dryRun (default true). Returns: deletion preview or confirmation.
- list: List tasks with filters. Required: none. Optional: status, priority, assignee, label, spec. Returns: matching task summaries with IDs, titles, statuses, priorities, assignees, labels, and spec links.
- history: View task change history. Required: taskId. Optional: none. Returns: chronological change entries with timestamps and metadata.
- board: Show tasks grouped by status. Required: none. Optional: none. Returns: board columns containing task summaries by status.
- archive/unarchive: Preview by default; set execute=true to mutate. Required: taskId.
- batch_archive/batch_unarchive: Preview by default; set execute=true to mutate. Optional: ids for batch_archive; required for batch_unarchive.
- hard_delete: Permission-gated separately from archive. Required: taskId, confirmed=true, and non-empty reason.
`),
			mcp.WithString("action",
				mcp.Required(),
				mcp.Description("Action to perform"),
				mcp.Enum("create", "get", "update", "delete", "list", "history", "board", "archive", "unarchive", "batch_archive", "batch_unarchive", "hard_delete"),
			),
			mcp.WithString("taskId",
				mcp.Description("Task ID (required for get, update, delete, history)"),
			),
			mcp.WithString("title",
				mcp.Description("Task title (required for create, optional for update)"),
			),
			mcp.WithString("description",
				mcp.Description("Task description (create, update)"),
			),
			mcp.WithString("status",
				mcp.Description("Task status (create, update, list)"),
				mcp.Enum("todo", "in-progress", "in-review", "done", "blocked", "on-hold", "urgent"),
			),
			mcp.WithString("priority",
				mcp.Description("Task priority (create, update, list)"),
				mcp.Enum("low", "medium", "high"),
			),
			mcp.WithString("assignee",
				mcp.Description("Task assignee (create, update, list)"),
			),
			mcp.WithArray("labels",
				mcp.Description("Task labels (create, update)"),
				mcp.WithStringItems(),
			),
			mcp.WithString("parent",
				mcp.Description("Parent task ID for subtasks (create)"),
			),
			mcp.WithString("spec",
				mcp.Description("Spec document path (create, update, list)"),
			),
			mcp.WithArray("fulfills",
				mcp.Description("Spec ACs this task fulfills (create, update)"),
				mcp.WithStringItems(),
			),
			mcp.WithNumber("order",
				mcp.Description("Display order (create, update)"),
			),
			mcp.WithArray("addAc",
				mcp.Description("Add new acceptance criteria (update)"),
				mcp.WithStringItems(),
			),
			mcp.WithArray("checkAc",
				mcp.Description("Check AC by index, 1-based (update)"),
				mcp.WithNumberItems(),
			),
			mcp.WithArray("uncheckAc",
				mcp.Description("Uncheck AC by index, 1-based (update)"),
				mcp.WithNumberItems(),
			),
			mcp.WithArray("removeAc",
				mcp.Description("Remove AC by index, 1-based (update)"),
				mcp.WithNumberItems(),
			),
			mcp.WithString("plan",
				mcp.Description("Implementation plan (update)"),
			),
			mcp.WithString("notes",
				mcp.Description("Implementation notes, replaces existing (update)"),
			),
			mcp.WithString("appendNotes",
				mcp.Description("Append to implementation notes (update)"),
			),
			mcp.WithArray("clear",
				mcp.Description("Clear string fields (update)"),
				mcp.WithStringItems(),
			),
			mcp.WithString("label",
				mcp.Description("Filter by label (list)"),
			),
			mcp.WithBoolean("dryRun",
				mcp.Description("Preview only without deleting (default: true) (delete)"),
			),
			mcp.WithArray("ids", mcp.Description("Task IDs for batch lifecycle actions"), mcp.WithStringItems()),
			mcp.WithBoolean("execute", mcp.Description("Execute a lifecycle mutation; defaults to false preview")),
			mcp.WithBoolean("confirmed", mcp.Description("Explicit hard-delete confirmation")),
			mcp.WithString("reason", mcp.Description("Required hard-delete reason")),
			mcp.WithString("actor", mcp.Description("Optional lifecycle audit actor")),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			action, err := req.RequireString("action")
			if err != nil {
				return errResult("action is required")
			}
			switch action {
			case "create":
				return handleTaskCreate(getStore, req)
			case "get":
				return handleTaskGet(getStore, req)
			case "update":
				return handleTaskUpdate(getStore, req)
			case "delete":
				return handleTaskDelete(getStore, req)
			case "list":
				return handleTaskList(getStore, req)
			case "history":
				return handleTaskHistory(getStore, req)
			case "board":
				return handleTaskBoard(getStore, req)
			case "archive", "unarchive", "batch_archive", "batch_unarchive", "hard_delete":
				return handleTaskLifecycle(ctx, getStore, action, req)
			default:
				return errResultf("unknown tasks action: %s", action)
			}
		},
	)

	registerHelp(s, "tasks.create", HelpEntry{When: "Create a new task or subtask with title, context, ownership, labels, and optional spec links.", Params: map[string]string{"title": "required — task title", "description": "task context and goal", "status": "todo | in-progress | in-review | done | blocked | on-hold | urgent", "priority": "low | medium | high", "assignee": "person responsible for task", "labels": "task labels", "parent": "parent task ID for subtasks", "spec": "spec doc path this task implements", "fulfills": "spec AC IDs this task satisfies", "order": "display order"}, Examples: []string{`tasks({ action: "create", title: "Add auth", description: "...", priority: "high" })`}, Flow: "Create task, then update to in-progress and start time before implementation."})
	registerHelp(s, "tasks.get", HelpEntry{When: "Read full task details before planning, implementation, review, or status updates.", Params: map[string]string{"taskId": "required — task ID"}, Flow: "Use before update/history when you need current ACs, plan, notes, or spec links."})
	registerHelp(s, "tasks.update", HelpEntry{When: "Modify task metadata, status, acceptance criteria, plan, or implementation notes.", Params: map[string]string{"taskId": "required — task ID", "title": "new task title", "description": "new task description", "status": "new task status", "priority": "low | medium | high", "assignee": "new assignee", "labels": "replacement label list", "spec": "spec doc path", "fulfills": "spec AC IDs this task satisfies", "order": "display order", "addAc": "new acceptance criteria", "checkAc": "1-based AC indexes to mark complete", "uncheckAc": "1-based AC indexes to mark incomplete", "removeAc": "1-based AC indexes to remove", "plan": "implementation plan", "notes": "replace all implementation notes", "appendNotes": "append to existing implementation notes", "clear": "string fields to clear"}, Why: "Use appendNotes for progress. notes replaces existing notes and can wipe history.", Examples: []string{`tasks({ action: "update", taskId: "abc123", appendNotes: "Done: added tests" })`, `tasks({ action: "update", taskId: "abc123", checkAc: [1, 2] })`}, Flow: "Only check AC after work is complete; stop time and set status done at finish."})
	registerHelp(s, "tasks.delete", HelpEntry{When: "Preview or remove a task when it is obsolete or was created by mistake.", Params: map[string]string{"taskId": "required — task ID", "dryRun": "preview only without deleting; default true"}, Why: "Default dryRun protects against accidental deletion."})
	registerHelp(s, "tasks.list", HelpEntry{When: "Find tasks by status, owner, priority, label, or spec before choosing work or checking remaining scope.", Params: map[string]string{"status": "filter by task status", "priority": "filter by low | medium | high", "assignee": "filter by assignee", "label": "filter by one label", "spec": "filter by linked spec doc path"}})
	registerHelp(s, "tasks.history", HelpEntry{When: "Inspect chronological changes for audit, debugging, or understanding how a task evolved.", Params: map[string]string{"taskId": "required — task ID"}})
	registerHelp(s, "tasks.board", HelpEntry{When: "Show task board grouped by status for planning or handoff overview.", Params: map[string]string{}})
	registerHelp(s, "tasks.archive", HelpEntry{When: "Preview or archive one completed Task through the canonical lifecycle policy.", Params: map[string]string{"taskId": "required", "execute": "false previews; true mutates", "actor": "optional audit actor"}})
	registerHelp(s, "tasks.unarchive", HelpEntry{When: "Preview or restore one done/archived Task.", Params: map[string]string{"taskId": "required", "execute": "false previews; true mutates"}})
	registerHelp(s, "tasks.batch_archive", HelpEntry{When: "Preview or archive eligible Tasks with machine retry progress.", Params: map[string]string{"ids": "optional; omitted evaluates all Tasks", "execute": "false previews; true mutates"}})
	registerHelp(s, "tasks.batch_unarchive", HelpEntry{When: "Preview or restore multiple Tasks.", Params: map[string]string{"ids": "required Task IDs", "execute": "false previews; true mutates"}})
	registerHelp(s, "tasks.hard_delete", HelpEntry{When: "Permanently delete a Task only under a trusted project delete permission.", Params: map[string]string{"taskId": "required", "confirmed": "must be true", "reason": "required non-empty reason"}, Why: "Hard-delete is distinct from archive and leaves a content-free tombstone."})
}

func handleTaskCreate(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	title, err := req.RequireString("title")
	if err != nil {
		return errResult(err.Error())
	}

	args := req.GetArguments()

	priority := "medium"
	status := "todo"
	if proj, err := store.Config.Load(); err == nil {
		if proj.Settings.DefaultPriority != "" {
			priority = proj.Settings.DefaultPriority
		}
	}

	if s, ok := stringArg(args, "status"); ok {
		status = s
	}
	if p, ok := stringArg(args, "priority"); ok {
		priority = p
	}

	task := &models.Task{
		ID:        models.NewTaskID(),
		Title:     title,
		Status:    status,
		Priority:  priority,
		Labels:    []string{},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if status == "done" {
		task.Status = "todo"
		tasklifecycle.ApplyStatusTransition(task, status, task.UpdatedAt)
	}

	if v, ok := textArg(args, "description"); ok {
		task.Description = v
	}
	if v, ok := stringArg(args, "assignee"); ok {
		task.Assignee = v
	}
	if v, ok := stringArg(args, "parent"); ok {
		task.Parent = v
	}
	if v, ok := stringArg(args, "spec"); ok {
		task.Spec = v
	}
	if v, ok := stringSliceArg(args, "labels"); ok {
		task.Labels = v
	}
	if v, ok := stringSliceArg(args, "fulfills"); ok {
		task.Fulfills = v
	}
	if v, ok := intArg(args, "order"); ok {
		task.Order = &v
	}
	if v, ok := textArg(args, "plan"); ok {
		task.ImplementationPlan = v
	}
	if v, ok := textArg(args, "notes"); ok {
		task.ImplementationNotes = v
	}

	if err := store.Tasks.Create(task); err != nil {
		return errFailed("create task", err)
	}

	_ = store.Versions.SaveVersion(task.ID, models.TaskVersion{
		Changes:  store.Versions.TrackChanges(nil, task),
		Snapshot: storage.TaskToSnapshot(task),
	})

	search.BestEffortIndexTask(store, task.ID)
	go notifyTaskUpdated(store, task.ID)

	out, _ := json.MarshalIndent(task, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleTaskGet(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	taskID, err := req.RequireString("taskId")
	if err != nil {
		return errResult(ErrTaskIDReq)
	}

	task, err := store.Tasks.Get(taskID)
	if err != nil {
		return errNotFound("Task", err)
	}

	if entries, err := store.Time.GetEntries(task.ID); err == nil {
		task.TimeEntries = entries
	}
	task.ActiveTimer = store.Time.GetActiveTimer(task.ID)

	out, _ := json.MarshalIndent(task, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleTaskUpdate(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	taskID, err := req.RequireString("taskId")
	if err != nil {
		return errResult(ErrTaskIDReq)
	}

	args := req.GetArguments()
	clearFields := stringSetArg(args, "clear")
	service := newMCPTaskLifecycleService(store)
	task, err := service.UpdateTask(context.Background(), taskID, tasklifecycle.TaskUpdateOptions{Actor: "mcp", Mutate: func(task *models.Task) error {

		if clearFields["title"] {
			task.Title = ""
		} else if v, ok := stringArg(args, "title"); ok && v != "" {
			task.Title = v
		}
		if clearFields["description"] {
			task.Description = ""
		} else if v, ok := textArg(args, "description"); ok && v != "" {
			task.Description = v
		}
		if v, ok := stringArg(args, "status"); ok {
			task.Status = v
		}
		if v, ok := stringArg(args, "priority"); ok {
			task.Priority = v
		}
		if clearFields["assignee"] {
			task.Assignee = ""
		} else if v, ok := stringArg(args, "assignee"); ok && v != "" {
			task.Assignee = v
		}
		if _, ok := args["labels"]; ok {
			if v, ok := stringSliceArg(args, "labels"); ok {
				task.Labels = v
			} else {
				task.Labels = []string{}
			}
		}
		if clearFields["spec"] {
			task.Spec = ""
		} else if v, ok := stringArg(args, "spec"); ok && v != "" {
			task.Spec = v
		}
		if _, ok := args["fulfills"]; ok {
			if v, ok := stringSliceArg(args, "fulfills"); ok {
				task.Fulfills = v
			} else {
				task.Fulfills = nil
			}
		}
		if _, ok := args["order"]; ok {
			if v, ok := intArg(args, "order"); ok {
				task.Order = &v
			}
		}

		if v, ok := stringSliceArg(args, "addAc"); ok {
			for _, text := range v {
				task.AcceptanceCriteria = append(task.AcceptanceCriteria, models.AcceptanceCriterion{
					Text:      text,
					Completed: false,
				})
			}
		}
		if v, ok := intSliceArg(args, "checkAc"); ok {
			for _, idx := range v {
				i := idx - 1
				if i >= 0 && i < len(task.AcceptanceCriteria) {
					task.AcceptanceCriteria[i].Completed = true
				}
			}
		}
		if v, ok := intSliceArg(args, "uncheckAc"); ok {
			for _, idx := range v {
				i := idx - 1
				if i >= 0 && i < len(task.AcceptanceCriteria) {
					task.AcceptanceCriteria[i].Completed = false
				}
			}
		}
		if v, ok := intSliceArg(args, "removeAc"); ok {
			sorted := make([]int, len(v))
			copy(sorted, v)
			for i := 0; i < len(sorted); i++ {
				for j := i + 1; j < len(sorted); j++ {
					if sorted[j] > sorted[i] {
						sorted[i], sorted[j] = sorted[j], sorted[i]
					}
				}
			}
			for _, idx := range sorted {
				i := idx - 1
				if i >= 0 && i < len(task.AcceptanceCriteria) {
					task.AcceptanceCriteria = append(
						task.AcceptanceCriteria[:i],
						task.AcceptanceCriteria[i+1:]...,
					)
				}
			}
		}

		if clearFields["plan"] {
			task.ImplementationPlan = ""
		} else if v, ok := textArg(args, "plan"); ok && v != "" {
			task.ImplementationPlan = v
		}
		if clearFields["notes"] {
			task.ImplementationNotes = ""
		} else if v, ok := textArg(args, "notes"); ok && v != "" {
			task.ImplementationNotes = v
		}
		if v, ok := textArg(args, "appendNotes"); ok && v != "" {
			if task.ImplementationNotes == "" {
				task.ImplementationNotes = v
			} else {
				task.ImplementationNotes += "\n" + v
			}
		}

		return nil
	}})
	if err != nil {
		return errFailed("update task", err)
	}
	go notifyTaskUpdated(store, task.ID)

	task.ActiveTimer = store.Time.GetActiveTimer(task.ID)

	out, _ := json.MarshalIndent(task, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleTaskList(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	tasks, err := store.Tasks.List()
	if err != nil {
		return errFailed("list tasks", err)
	}

	args := req.GetArguments()
	statusFilter, _ := stringArg(args, "status")
	priorityFilter, _ := stringArg(args, "priority")
	assigneeFilter, _ := stringArg(args, "assignee")
	labelFilter, _ := stringArg(args, "label")
	specFilter, _ := stringArg(args, "spec")

	filtered := tasks[:0]
	for _, t := range tasks {
		if statusFilter != "" && t.Status != statusFilter {
			continue
		}
		if priorityFilter != "" && t.Priority != priorityFilter {
			continue
		}
		if assigneeFilter != "" && t.Assignee != assigneeFilter {
			continue
		}
		if labelFilter != "" && !containsString(t.Labels, labelFilter) {
			continue
		}
		if specFilter != "" && t.Spec != specFilter {
			continue
		}
		filtered = append(filtered, t)
	}

	// If results are empty, include project context for diagnostics.
	if len(filtered) == 0 {
		wrapper := map[string]any{
			"results":      filtered,
			"_projectRoot": store.Root,
			"_hint":        "No tasks found. Verify the active project is correct via project({ action: \"current\" }).",
		}
		out, _ := json.MarshalIndent(wrapper, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	out, _ := json.MarshalIndent(filtered, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func newMCPTaskLifecycleService(store *storage.Store) *tasklifecycle.Service {
	return tasklifecycle.New(store, tasklifecycle.WithHooks(tasklifecycle.Hooks{
		IndexTask:  func(id string) error { return search.ReconcileTaskIndex(store, id) },
		RemoveTask: func(id string) error { return search.ReconcileTaskRemoval(store, id) },
	}))
}

func handleTaskLifecycle(ctx context.Context, getStore func() *storage.Store, action string, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}
	args := req.GetArguments()
	request := tasklifecycle.Request{Actor: "mcp"}
	request.TaskID, _ = stringArg(args, "taskId")
	request.IDs, _ = stringSliceArg(args, "ids")
	request.Execute, _ = args["execute"].(bool)
	request.Confirmed, _ = args["confirmed"].(bool)
	request.Reason, _ = stringArg(args, "reason")
	if actor, ok := stringArg(args, "actor"); ok {
		request.Actor = actor
	}
	switch action {
	case "archive":
		request.Operation = tasklifecycle.OperationArchive
	case "unarchive":
		request.Operation = tasklifecycle.OperationReopen
	case "batch_archive":
		request.Operation = tasklifecycle.OperationBatchArchive
	case "batch_unarchive":
		request.Operation = tasklifecycle.OperationBatchUnarchive
	case "hard_delete":
		request.Operation = tasklifecycle.OperationHardDelete
		request.Execute = request.Confirmed
	}
	// Permission comes from canonical project policy, never MCP arguments.
	capabilities := tasklifecycle.PublicCapabilities{}
	if cfg, err := store.Config.Load(); err == nil {
		policy := permissions.EffectivePolicy(cfg.Settings.Permissions)
		capabilities.Archive = policy.Allowed[permissions.CapArchive] && !policy.Denied[permissions.CapArchive]
		capabilities.HardDelete = policy.Allowed[permissions.CapDelete] && !policy.Denied[permissions.CapDelete]
	}
	response, err := newMCPTaskLifecycleService(store).ExecutePublicWithCapabilities(ctx, request, capabilities)
	if response.Changed > 0 {
		go notifyServer(store, "notify/refresh")
	}
	out, _ := json.MarshalIndent(response, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(string(out)), nil
	}
	return mcp.NewToolResultText(string(out)), nil
}

func handleTaskHistory(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	taskID, err := req.RequireString("taskId")
	if err != nil {
		return errResult(ErrTaskIDReq)
	}

	history, err := store.Versions.GetHistory(taskID)
	if err != nil {
		return errFailed("get task history", err)
	}

	out, _ := json.MarshalIndent(history, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleTaskDelete(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	args := req.GetArguments()
	taskID, ok := stringArg(args, "taskId")
	if !ok || taskID == "" {
		return errResult(ErrTaskIDReq)
	}

	dryRun := true
	if v, exists := args["dryRun"]; exists {
		if b, ok := v.(bool); ok {
			dryRun = b
		}
	}

	task, err := store.Tasks.Get(taskID)
	if err != nil {
		return errNotFound("Task", err)
	}

	if dryRun {
		out, _ := json.MarshalIndent(map[string]any{
			"dryRun":  true,
			"message": fmt.Sprintf(MsgWouldDeleteTask, task.ID, task.Title),
			"task":    task,
		}, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	return errResult("tasks.delete is preview-only; use the separately permission-gated hard_delete action with confirmed=true and a non-empty reason")
}

// handleTaskBoard returns the board view with tasks grouped by status.
// Previously in board.go as get_board tool.
func handleTaskBoard(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	tasks, err := store.Tasks.List()
	if err != nil {
		return errFailed("list tasks", err)
	}

	columns := models.DefaultStatuses()
	if proj, err := store.Config.Load(); err == nil {
		if len(proj.Settings.VisibleColumns) > 0 {
			columns = proj.Settings.VisibleColumns
		} else if len(proj.Settings.Statuses) > 0 {
			columns = proj.Settings.Statuses
		}
	}

	type column struct {
		Status string         `json:"status"`
		Tasks  []*models.Task `json:"tasks"`
		Count  int            `json:"count"`
	}

	columnMap := make(map[string]*column)
	for _, status := range columns {
		columnMap[status] = &column{
			Status: status,
			Tasks:  []*models.Task{},
		}
	}

	extraStatuses := make(map[string]bool)
	for _, t := range tasks {
		if _, ok := columnMap[t.Status]; !ok {
			extraStatuses[t.Status] = true
			if _, ok2 := columnMap[t.Status]; !ok2 {
				columnMap[t.Status] = &column{
					Status: t.Status,
					Tasks:  []*models.Task{},
				}
			}
		}
		columnMap[t.Status].Tasks = append(columnMap[t.Status].Tasks, t)
		columnMap[t.Status].Count++
	}

	var ordered []*column
	for _, status := range columns {
		if c, ok := columnMap[status]; ok {
			ordered = append(ordered, c)
		}
	}
	for status := range extraStatuses {
		if c, ok := columnMap[status]; ok {
			ordered = append(ordered, c)
		}
	}

	totalCount := 0
	for _, c := range ordered {
		totalCount += c.Count
	}

	board := map[string]any{
		"columns": ordered,
		"total":   totalCount,
	}

	out, _ := json.MarshalIndent(board, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}
