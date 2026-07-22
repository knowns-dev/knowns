package cli

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
	"github.com/spf13/cobra"
)

var taskCmd = &cobra.Command{
	Use:   "task",
	Short: "Manage tasks",
	Long:  "Create, view, edit, and manage project tasks.",
	// Allow 'knowns task <id>' as a shorthand for 'knowns task view <id>'
	Args: cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) == 0 {
			return cmd.Help()
		}
		// Treat first arg as task ID → delegate to view
		return runTaskView(cmd, args[0])
	},
}

// --- task create ---

var taskCreateCmd = &cobra.Command{
	Use:   "create <title>",
	Short: "Create a new task",
	Args:  cobra.MinimumNArgs(1),
	RunE:  runTaskCreate,
}

func runTaskCreate(cmd *cobra.Command, args []string) error {
	title := strings.Join(args, " ")
	store := getStore()

	description, _ := cmd.Flags().GetString("description")
	acList, _ := cmd.Flags().GetStringArray("ac")
	status, _ := cmd.Flags().GetString("status")
	priority, _ := cmd.Flags().GetString("priority")
	assignee, _ := cmd.Flags().GetString("assignee")
	labels, _ := cmd.Flags().GetStringArray("label")
	parent, _ := cmd.Flags().GetString("parent")
	spec, _ := cmd.Flags().GetString("spec")
	fulfills, _ := cmd.Flags().GetStringArray("fulfills")
	plan, _ := cmd.Flags().GetString("plan")
	notes, _ := cmd.Flags().GetString("notes")

	description = unescapeText(description)
	plan = unescapeText(plan)
	notes = unescapeText(notes)

	// Load config for defaults
	cfg, _ := store.Config.Load()

	if status == "" {
		status = "todo"
	}
	if priority == "" {
		priority = "medium"
		if cfg != nil && cfg.Settings.DefaultPriority != "" {
			priority = cfg.Settings.DefaultPriority
		}
	}
	if assignee == "" && cfg != nil {
		assignee = cfg.Settings.DefaultAssignee
	}

	now := time.Now()
	task := &models.Task{
		ID:                  models.NewTaskID(),
		Title:               title,
		Description:         description,
		Status:              status,
		Priority:            priority,
		Assignee:            assignee,
		Labels:              labels,
		Parent:              parent,
		Spec:                spec,
		Fulfills:            fulfills,
		ImplementationPlan:  plan,
		ImplementationNotes: notes,
		CreatedAt:           now,
		UpdatedAt:           now,
	}
	if status == "done" {
		task.Status = "todo"
		tasklifecycle.ApplyStatusTransition(task, status, now)
	}

	for _, ac := range acList {
		task.AcceptanceCriteria = append(task.AcceptanceCriteria, models.AcceptanceCriterion{
			Text:      ac,
			Completed: false,
		})
	}

	if err := store.Tasks.Create(task); err != nil {
		return fmt.Errorf("create task: %w", err)
	}

	search.BestEffortIndexTask(store, task.ID)

	// Save version
	_ = store.Versions.SaveVersion(task.ID, models.TaskVersion{
		Author:   assignee,
		Changes:  store.Versions.TrackChanges(nil, task),
		Snapshot: storage.TaskToSnapshot(task),
	})

	fmt.Println(RenderSuccess(fmt.Sprintf("Created task %s: %s", task.ID, task.Title)))
	return nil
}

// --- task list ---

var taskListCmd = &cobra.Command{
	Use:   "list",
	Short: "List tasks",
	RunE:  runTaskList,
}

func runTaskList(cmd *cobra.Command, args []string) error {
	store := getStore()

	statusFilter, _ := cmd.Flags().GetString("status")
	assigneeFilter, _ := cmd.Flags().GetString("assignee")
	priorityFilter, _ := cmd.Flags().GetString("priority")
	labelFilter, _ := cmd.Flags().GetString("label")
	treeMode, _ := cmd.Flags().GetBool("tree")

	tasks, err := store.Tasks.List()
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}

	// Apply filters
	filtered := make([]*models.Task, 0, len(tasks))
	for _, t := range tasks {
		if statusFilter != "" && t.Status != statusFilter {
			continue
		}
		if assigneeFilter != "" && t.Assignee != assigneeFilter {
			continue
		}
		if priorityFilter != "" && t.Priority != priorityFilter {
			continue
		}
		if labelFilter != "" && !containsLabel(t.Labels, labelFilter) {
			continue
		}
		filtered = append(filtered, t)
	}

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)

	if jsonOut {
		printJSON(filtered)
		return nil
	}

	if len(filtered) == 0 {
		fmt.Println(StyleDim.Render("No tasks found."))
		return nil
	}

	if treeMode {
		if plain {
			content := sprintTaskTreePlain(filtered)
			printPaged(cmd, content)
		} else {
			content := renderTaskTree(filtered)
			renderOrPage(cmd, "Tasks (tree)", content)
		}
		return nil
	}

	if plain {
		page, _ := getPageOpts(cmd)
		total := len(filtered)
		limit := defaultPlainItemLimit
		if page <= 0 {
			page = 1
		}
		start := (page - 1) * limit
		end := start + limit
		if start >= total {
			totalPages := (total + limit - 1) / limit
			fmt.Printf("PAGE: %d/%d (no more items)\n", page, totalPages)
			return nil
		}
		if end > total {
			end = total
		}
		pageItems := filtered[start:end]
		content := sprintTaskListPlain(pageItems)
		fmt.Print(content)
		if total > limit {
			totalPages := (total + limit - 1) / limit
			fmt.Printf("\nPAGE: %d/%d (items %d-%d of %d)\n", page, totalPages, start+1, end, total)
			if page < totalPages {
				fmt.Printf("Use --page %d to see more results.\n", page+1)
			}
		}
	} else {
		if !isTTY() || isPagerDisabled(cmd) {
			content := renderTaskTable(filtered)
			fmt.Print(content)
			return nil
		}
		items := buildTaskListItems(filtered)
		if err := RunListView("Tasks", items); err != nil {
			// Fallback to static table on TUI error
			content := renderTaskTable(filtered)
			fmt.Print(content)
		}
	}

	return nil
}

// --- task view ---

var taskViewCmd = &cobra.Command{
	Use:   "view <id>",
	Short: "View a task",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runTaskView(cmd, args[0])
	},
}

func runTaskView(cmd *cobra.Command, id string) error {
	store := getStore()

	task, err := store.Tasks.Get(id)
	if err != nil {
		return fmt.Errorf("task %q not found", id)
	}

	// Load active timer if any.
	task.ActiveTimer = store.Time.GetActiveTimer(task.ID)

	jsonOut := isJSON(cmd)
	plain := isPlain(cmd)

	if jsonOut {
		printJSON(task)
		return nil
	}

	if plain {
		content := sprintTaskPlain(task)
		printPaged(cmd, content)
	} else {
		content := renderTaskDetailed(task)
		renderOrPage(cmd, fmt.Sprintf("Task %s", task.ID), content)
	}

	return nil
}

// --- task edit ---

var taskEditCmd = &cobra.Command{
	Use:   "edit <id>",
	Short: "Edit a task",
	Args:  cobra.ExactArgs(1),
	RunE:  runTaskEdit,
}

func runTaskEdit(cmd *cobra.Command, args []string) error {
	id := args[0]
	store := getStore()
	service := newCLITaskLifecycleService(store)
	task, err := service.UpdateTask(cmd.Context(), id, tasklifecycle.TaskUpdateOptions{Actor: cliLifecycleActor(), Mutate: func(task *models.Task) error {

		// Apply flag updates
		if cmd.Flags().Changed("title") {
			v, _ := cmd.Flags().GetString("title")
			task.Title = v
		}
		if cmd.Flags().Changed("description") {
			v, _ := cmd.Flags().GetString("description")
			task.Description = unescapeText(v)
		}
		if cmd.Flags().Changed("status") {
			v, _ := cmd.Flags().GetString("status")
			task.Status = v
		}
		if cmd.Flags().Changed("priority") {
			v, _ := cmd.Flags().GetString("priority")
			task.Priority = v
		}
		if cmd.Flags().Changed("assignee") {
			v, _ := cmd.Flags().GetString("assignee")
			task.Assignee = v
		}
		if cmd.Flags().Changed("labels") {
			v, _ := cmd.Flags().GetString("labels")
			task.Labels = splitCSV(v)
		}
		if cmd.Flags().Changed("spec") {
			v, _ := cmd.Flags().GetString("spec")
			task.Spec = v
		}
		if cmd.Flags().Changed("parent") {
			v, _ := cmd.Flags().GetString("parent")
			task.Parent = v
		}
		if cmd.Flags().Changed("plan") {
			v, _ := cmd.Flags().GetString("plan")
			task.ImplementationPlan = unescapeText(v)
		}
		if cmd.Flags().Changed("notes") {
			v, _ := cmd.Flags().GetString("notes")
			task.ImplementationNotes = unescapeText(v)
		}
		if cmd.Flags().Changed("append-notes") {
			v, _ := cmd.Flags().GetString("append-notes")
			v = unescapeText(v)
			if task.ImplementationNotes == "" {
				task.ImplementationNotes = v
			} else {
				task.ImplementationNotes = task.ImplementationNotes + "\n" + v
			}
		}
		if cmd.Flags().Changed("fulfills") {
			fulfills, _ := cmd.Flags().GetStringArray("fulfills")
			task.Fulfills = fulfills
		}
		if cmd.Flags().Changed("order") {
			v, _ := cmd.Flags().GetInt("order")
			task.Order = &v
		}

		// Add AC
		if cmd.Flags().Changed("ac") {
			acList, _ := cmd.Flags().GetStringArray("ac")
			for _, ac := range acList {
				task.AcceptanceCriteria = append(task.AcceptanceCriteria, models.AcceptanceCriterion{
					Text:      ac,
					Completed: false,
				})
			}
		}

		// Check AC (1-based indices)
		if cmd.Flags().Changed("check-ac") {
			indices, _ := cmd.Flags().GetIntSlice("check-ac")
			for _, idx := range indices {
				if idx < 1 || idx > len(task.AcceptanceCriteria) {
					return fmt.Errorf("AC index %d out of range (task has %d criteria)", idx, len(task.AcceptanceCriteria))
				}
				task.AcceptanceCriteria[idx-1].Completed = true
			}
		}

		// Uncheck AC
		if cmd.Flags().Changed("uncheck-ac") {
			indices, _ := cmd.Flags().GetIntSlice("uncheck-ac")
			for _, idx := range indices {
				if idx < 1 || idx > len(task.AcceptanceCriteria) {
					return fmt.Errorf("AC index %d out of range (task has %d criteria)", idx, len(task.AcceptanceCriteria))
				}
				task.AcceptanceCriteria[idx-1].Completed = false
			}
		}

		// Remove AC (process in reverse order to keep indices stable)
		if cmd.Flags().Changed("remove-ac") {
			indices, _ := cmd.Flags().GetIntSlice("remove-ac")
			// Sort descending
			for i := 0; i < len(indices); i++ {
				for j := i + 1; j < len(indices); j++ {
					if indices[j] > indices[i] {
						indices[i], indices[j] = indices[j], indices[i]
					}
				}
			}
			for _, idx := range indices {
				if idx < 1 || idx > len(task.AcceptanceCriteria) {
					return fmt.Errorf("AC index %d out of range (task has %d criteria)", idx, len(task.AcceptanceCriteria))
				}
				task.AcceptanceCriteria = append(
					task.AcceptanceCriteria[:idx-1],
					task.AcceptanceCriteria[idx:]...,
				)
			}
		}

		return nil
	}})
	if err != nil {
		return fmt.Errorf("update task: %w", err)
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Updated task %s", task.ID)))
	return nil
}

// --- task delete ---

var taskDeleteCmd = &cobra.Command{
	Use:     "hard-delete <id>",
	Aliases: []string{"delete"},
	Short:   "Permanently delete a task and retain a content-free tombstone",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		reason, _ := cmd.Flags().GetString("reason")
		yes, _ := cmd.Flags().GetBool("yes")
		allowed, _ := cmd.Flags().GetBool("allow-hard-delete")
		request := tasklifecycle.Request{Operation: tasklifecycle.OperationHardDelete, TaskID: args[0], Execute: yes, Confirmed: yes, Reason: reason, Actor: cliLifecycleActor()}
		return runCLILifecycle(cmd, request, allowed)
	},
}

// --- task archive ---

var taskArchiveCmd = &cobra.Command{
	Use:   "archive <id>",
	Short: "Archive a task",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		yes, _ := cmd.Flags().GetBool("yes")
		return runCLILifecycle(cmd, tasklifecycle.Request{Operation: tasklifecycle.OperationArchive, TaskID: args[0], Execute: yes, Actor: cliLifecycleActor()}, false)
	},
}

// --- task unarchive ---

var taskUnarchiveCmd = &cobra.Command{
	Use:   "unarchive <id>",
	Short: "Restore a task from the archive",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		yes, _ := cmd.Flags().GetBool("yes")
		return runCLILifecycle(cmd, tasklifecycle.Request{Operation: tasklifecycle.OperationReopen, TaskID: args[0], Execute: yes, Actor: cliLifecycleActor()}, false)
	},
}

var taskBatchArchiveCmd = &cobra.Command{
	Use: "batch-archive [ids...]", Short: "Preview or execute a batch archive", Args: cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		yes, _ := cmd.Flags().GetBool("yes")
		return runCLILifecycle(cmd, tasklifecycle.Request{Operation: tasklifecycle.OperationBatchArchive, IDs: args, Execute: yes, Actor: cliLifecycleActor()}, false)
	},
}

var taskBatchUnarchiveCmd = &cobra.Command{
	Use: "batch-unarchive <ids...>", Short: "Preview or execute a batch unarchive", Args: cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		yes, _ := cmd.Flags().GetBool("yes")
		return runCLILifecycle(cmd, tasklifecycle.Request{Operation: tasklifecycle.OperationBatchUnarchive, IDs: args, Execute: yes, Actor: cliLifecycleActor()}, false)
	},
}

func newCLITaskLifecycleService(store *storage.Store) *tasklifecycle.Service {
	return tasklifecycle.New(store, tasklifecycle.WithHooks(tasklifecycle.Hooks{
		IndexTask:  func(id string) error { return search.ReconcileTaskIndex(store, id) },
		RemoveTask: func(id string) error { return search.ReconcileTaskRemoval(store, id) },
	}))
}

func cliLifecycleActor() string {
	if actor := strings.TrimSpace(os.Getenv("USER")); actor != "" {
		return actor
	}
	return "cli"
}

func runCLILifecycle(cmd *cobra.Command, request tasklifecycle.Request, hardDeleteAuthorized bool) error {
	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	response, err := newCLITaskLifecycleService(getStore()).ExecutePublic(ctx, request, hardDeleteAuthorized)
	if isJSON(cmd) {
		printJSON(response)
	} else {
		printLifecycleResponse(response)
	}
	if err != nil {
		return err
	}
	return nil
}

func printLifecycleResponse(response *tasklifecycle.Response) {
	if response == nil {
		return
	}
	mode := "preview"
	if response.Execute {
		mode = "execute"
	}
	fmt.Printf("%s %s: processed=%d changed=%d completed=%t\n", response.Operation, mode, response.Processed, response.Changed, response.Completed)
	if response.FailedTaskID != "" {
		fmt.Printf("failedTaskId=%s\n", response.FailedTaskID)
	}
	for index, item := range response.Items {
		fmt.Printf("  [%d/%d] %s: %s -> %s changed=%t eligible=%t", index+1, response.Processed, item.TaskID, item.Before, item.After, item.Changed, item.Eligible)
		if len(item.Reasons) > 0 {
			codes := make([]string, 0, len(item.Reasons))
			for _, reason := range item.Reasons {
				codes = append(codes, string(reason.Code))
			}
			fmt.Printf(" reasons=%s", strings.Join(codes, ","))
		}
		if item.CompletedAt != nil {
			fmt.Printf(" completedAt=%s", item.CompletedAt.UTC().Format(time.RFC3339Nano))
		}
		if item.ArchivedAt != nil {
			fmt.Printf(" archivedAt=%s", item.ArchivedAt.UTC().Format(time.RFC3339Nano))
		}
		if item.Deadline != nil {
			fmt.Printf(" deadline=%s", item.Deadline.UTC().Format(time.RFC3339Nano))
		}
		if item.Event != nil {
			fmt.Printf(" eventId=%s", item.Event.ID)
		}
		fmt.Println()
		for _, warning := range item.Warnings {
			fmt.Printf("    warning=%s message=%s", warning.Code, warning.Message)
			if len(warning.References) > 0 {
				fmt.Printf(" references=%s", strings.Join(warning.References, ","))
			}
			fmt.Println()
		}
	}
}

// --- task history ---

var taskHistoryCmd = &cobra.Command{
	Use:   "history <id>",
	Short: "Show version history of a task",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		store := getStore()
		history, err := store.Versions.GetHistory(args[0])
		if err != nil {
			return fmt.Errorf("get history: %w", err)
		}

		plain := isPlain(cmd)
		jsonOut := isJSON(cmd)

		if jsonOut {
			printJSON(history)
			return nil
		}

		if len(history.Versions) == 0 {
			fmt.Printf("No version history for task %s\n", args[0])
			return nil
		}

		if plain {
			var hb strings.Builder
			fmt.Fprintf(&hb, "TASK: %s\n", args[0])
			fmt.Fprintf(&hb, "VERSIONS: %d\n\n", history.CurrentVersion)
			for _, v := range history.Versions {
				fmt.Fprintf(&hb, "VERSION: %s\n", v.ID)
				fmt.Fprintf(&hb, "TIMESTAMP: %s\n", v.Timestamp.Format(time.RFC3339))
				if v.Author != "" {
					fmt.Fprintf(&hb, "AUTHOR: %s\n", v.Author)
				}
				for _, ch := range v.Changes {
					fmt.Fprintf(&hb, "  CHANGE: %s: %v -> %v\n", ch.Field, ch.OldValue, ch.NewValue)
				}
				fmt.Fprintln(&hb)
			}
			printPaged(cmd, hb.String())
		} else {
			content := renderTaskHistory(args[0], history)
			renderOrPage(cmd, "Task History", content)
		}
		return nil
	},
}

// ---- list view helpers ----

func buildTaskListItems(tasks []*models.Task) []listItem {
	items := make([]listItem, len(tasks))
	for i, t := range tasks {
		desc := StatusStyle(t.Status).Render(t.Status) + "  " + PriorityStyle(t.Priority).Render(t.Priority)
		if t.Assignee != "" {
			desc += "  " + StyleDim.Render(t.Assignee)
		}
		if len(t.Labels) > 0 {
			desc += "  " + RenderLabels(t.Labels)
		}
		items[i] = listItem{
			id:          t.ID,
			title:       t.Title,
			description: desc,
			detail:      renderTaskDetailed(t),
		}
	}
	return items
}

// ---- output helpers ----

// sprintTaskListPlain renders compact task list grouped by status as a string.
func sprintTaskListPlain(tasks []*models.Task) string {
	var b strings.Builder
	// Define status display order
	statusOrder := []struct {
		key   string
		label string
	}{
		{"urgent", "Urgent:"},
		{"blocked", "Blocked:"},
		{"todo", "To Do:"},
		{"in-progress", "In Progress:"},
		{"in-review", "In Review:"},
		{"on-hold", "On Hold:"},
		{"done", "Done:"},
	}

	// Group tasks by status
	byStatus := make(map[string][]*models.Task)
	for _, t := range tasks {
		byStatus[t.Status] = append(byStatus[t.Status], t)
	}

	first := true
	for _, s := range statusOrder {
		group, ok := byStatus[s.key]
		if !ok || len(group) == 0 {
			continue
		}
		if !first {
			fmt.Fprintln(&b)
		}
		first = false
		fmt.Fprintln(&b, s.label)
		for _, t := range group {
			fmt.Fprintf(&b, "  [%s] %s - %s\n", strings.ToUpper(t.Priority), t.ID, t.Title)
		}
	}

	// Any statuses not in our predefined order
	for _, t := range tasks {
		found := false
		for _, s := range statusOrder {
			if t.Status == s.key {
				found = true
				break
			}
		}
		if !found {
			if _, printed := byStatus["_other_printed"]; !printed {
				if !first {
					fmt.Fprintln(&b)
				}
				byStatus["_other_printed"] = nil
			}
			fmt.Fprintf(&b, "  [%s] %s - %s\n", strings.ToUpper(t.Priority), t.ID, t.Title)
		}
	}
	return b.String()
}

func sprintTaskPlain(t *models.Task) string {
	var b strings.Builder
	fmt.Fprintf(&b, "ID: %s\n", t.ID)
	fmt.Fprintf(&b, "TITLE: %s\n", t.Title)
	fmt.Fprintf(&b, "STATUS: %s\n", t.Status)
	fmt.Fprintf(&b, "PRIORITY: %s\n", t.Priority)
	if t.Assignee != "" {
		fmt.Fprintf(&b, "ASSIGNEE: %s\n", t.Assignee)
	}
	if len(t.Labels) > 0 {
		fmt.Fprintf(&b, "LABELS: %s\n", joinStrings(t.Labels, ", "))
	}
	if t.Parent != "" {
		fmt.Fprintf(&b, "PARENT: %s\n", t.Parent)
	}
	if t.Spec != "" {
		fmt.Fprintf(&b, "SPEC: %s\n", t.Spec)
	}
	if len(t.Fulfills) > 0 {
		fmt.Fprintf(&b, "FULFILLS: %s\n", joinStrings(t.Fulfills, ", "))
	}
	if t.Description != "" {
		fmt.Fprintf(&b, "DESCRIPTION:\n%s\n", t.Description)
	}
	if len(t.AcceptanceCriteria) > 0 {
		fmt.Fprintf(&b, "ACCEPTANCE CRITERIA:\n")
		for i, ac := range t.AcceptanceCriteria {
			check := " "
			if ac.Completed {
				check = "x"
			}
			fmt.Fprintf(&b, "  %d. [%s] %s\n", i+1, check, ac.Text)
		}
	}
	if t.ImplementationPlan != "" {
		fmt.Fprintf(&b, "PLAN:\n%s\n", t.ImplementationPlan)
	}
	if t.ImplementationNotes != "" {
		fmt.Fprintf(&b, "NOTES:\n%s\n", t.ImplementationNotes)
	}
	if t.TimeSpent > 0 {
		fmt.Fprintf(&b, "TIME SPENT: %s\n", formatDuration(t.TimeSpent))
	}
	if t.ActiveTimer != nil {
		status := "running"
		if t.ActiveTimer.PausedAt != nil {
			status = "paused"
		}
		fmt.Fprintf(&b, "TIMER: %s (started %s)\n", status, t.ActiveTimer.StartedAt)
	}
	fmt.Fprintf(&b, "CREATED: %s\n", t.CreatedAt.Format("2006-01-02T15:04:05Z"))
	fmt.Fprintf(&b, "UPDATED: %s\n", t.UpdatedAt.Format("2006-01-02T15:04:05Z"))
	if len(t.Subtasks) > 0 {
		fmt.Fprintf(&b, "SUBTASKS: %s\n", joinStrings(t.Subtasks, ", "))
	}
	return b.String()
}

func renderTaskDetailed(t *models.Task) string {
	var b strings.Builder
	// Header
	fmt.Fprintf(&b, "%s  %s\n", StyleID.Render(t.ID), StyleBold.Render(t.Title))
	fmt.Fprintf(&b, "%s %s  %s %s\n",
		StyleDim.Render("Status:"), RenderStatusBadge(t.Status),
		StyleDim.Render("Priority:"), RenderPriorityBadge(t.Priority))
	if t.Assignee != "" {
		fmt.Fprintln(&b, RenderKeyValue("Assignee", t.Assignee))
	}
	if len(t.Labels) > 0 {
		fmt.Fprintf(&b, "%s %s\n", StyleDim.Render("Labels:"), RenderLabels(t.Labels))
	}
	if t.Parent != "" {
		fmt.Fprintln(&b, RenderKeyValue("Parent", t.Parent))
	}
	if t.Spec != "" {
		fmt.Fprintln(&b, RenderKeyValue("Spec", t.Spec))
	}
	if len(t.Fulfills) > 0 {
		fmt.Fprintln(&b, RenderKeyValue("Fulfills", joinStrings(t.Fulfills, ", ")))
	}
	if t.Description != "" {
		fmt.Fprintf(&b, "\n%s\n%s\n", RenderSectionHeader("Description"), t.Description)
	}
	if len(t.AcceptanceCriteria) > 0 {
		fmt.Fprintf(&b, "\n%s\n", RenderSectionHeader("Acceptance Criteria"))
		for i, ac := range t.AcceptanceCriteria {
			fmt.Fprintln(&b, RenderACCheckbox(i+1, ac.Text, ac.Completed))
		}
	}
	if t.ImplementationPlan != "" {
		fmt.Fprintf(&b, "\n%s\n%s\n", RenderSectionHeader("Implementation Plan"), t.ImplementationPlan)
	}
	if t.ImplementationNotes != "" {
		fmt.Fprintf(&b, "\n%s\n%s\n", RenderSectionHeader("Implementation Notes"), t.ImplementationNotes)
	}
	if t.TimeSpent > 0 {
		fmt.Fprintf(&b, "\n%s %s\n", StyleDim.Render("Time Spent:"), StyleInfo.Render(formatDuration(t.TimeSpent)))
	}
	if t.ActiveTimer != nil {
		status := StyleSuccess.Render("● running")
		if t.ActiveTimer.PausedAt != nil {
			status = StyleWarning.Render("⏸ paused")
		}
		fmt.Fprintf(&b, "\n%s %s %s\n", StyleDim.Render("Timer:"), status, StyleDim.Render("(since "+t.ActiveTimer.StartedAt+")"))
	}
	fmt.Fprintf(&b, "\n%s\n",
		StyleDim.Render(fmt.Sprintf("Created: %s | Updated: %s",
			t.CreatedAt.Format("2006-01-02"),
			t.UpdatedAt.Format("2006-01-02"))))
	if len(t.Subtasks) > 0 {
		fmt.Fprintln(&b, RenderKeyValue("Subtasks", joinStrings(t.Subtasks, ", ")))
	}
	return b.String()
}

func renderTaskTable(tasks []*models.Task) string {
	var b strings.Builder
	fmt.Fprintf(&b, "  %s  %s  %s  %s  %s\n",
		StyleBold.Render(fmt.Sprintf("%-10s", "ID")),
		StyleBold.Render(fmt.Sprintf("%-40s", "TITLE")),
		StyleBold.Render(fmt.Sprintf("%-12s", "STATUS")),
		StyleBold.Render(fmt.Sprintf("%-8s", "PRIORITY")),
		StyleBold.Render(fmt.Sprintf("%-20s", "ASSIGNEE")))
	fmt.Fprintln(&b, "  "+RenderSeparator(96))
	for _, t := range tasks {
		title := t.Title
		if len(title) > 38 {
			title = title[:35] + "..."
		}
		assignee := t.Assignee
		if len(assignee) > 18 {
			assignee = assignee[:15] + "..."
		}
		fmt.Fprintf(&b, "  %s  %-40s  %s  %s  %-20s\n",
			StyleID.Render(fmt.Sprintf("%-10s", t.ID)),
			title,
			StatusStyle(t.Status).Render(fmt.Sprintf("%-12s", t.Status)),
			PriorityStyle(t.Priority).Render(fmt.Sprintf("%-8s", t.Priority)),
			assignee)
	}
	return b.String()
}

func sprintTaskTreePlain(tasks []*models.Task) string {
	var b strings.Builder

	byID := make(map[string]*models.Task)
	for _, t := range tasks {
		byID[t.ID] = t
	}

	var roots []*models.Task
	for _, t := range tasks {
		if t.Parent == "" {
			roots = append(roots, t)
		} else if _, ok := byID[t.Parent]; !ok {
			roots = append(roots, t)
		}
	}

	var writeTree func(t *models.Task, indent string)
	writeTree = func(t *models.Task, indent string) {
		fmt.Fprintf(&b, "%s%s: %s [%s]\n", indent, t.ID, t.Title, t.Status)
		for _, childID := range t.Subtasks {
			if child, ok := byID[childID]; ok {
				writeTree(child, indent+"  ")
			}
		}
	}

	for _, r := range roots {
		writeTree(r, "")
	}
	return b.String()
}

func renderTaskTree(tasks []*models.Task) string {
	var b strings.Builder

	byID := make(map[string]*models.Task)
	for _, t := range tasks {
		byID[t.ID] = t
	}

	var roots []*models.Task
	for _, t := range tasks {
		if t.Parent == "" {
			roots = append(roots, t)
		} else if _, ok := byID[t.Parent]; !ok {
			roots = append(roots, t)
		}
	}

	var writeTree func(t *models.Task, indent string)
	writeTree = func(t *models.Task, indent string) {
		fmt.Fprintf(&b, "%s%s %s %s\n", indent,
			StyleID.Render(t.ID),
			t.Title,
			StatusStyle(t.Status).Render("["+t.Status+"]"))
		for _, childID := range t.Subtasks {
			if child, ok := byID[childID]; ok {
				writeTree(child, indent+"  ")
			}
		}
	}

	for _, r := range roots {
		writeTree(r, "")
	}
	return b.String()
}

func renderTaskHistory(id string, history *models.TaskVersionHistory) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s\n\n",
		StyleID.Render(id),
		StyleDim.Render(fmt.Sprintf("— %d version(s)", history.CurrentVersion)))
	for _, v := range history.Versions {
		header := StyleDim.Render("["+v.ID+"]") + " " + v.Timestamp.Format("2006-01-02 15:04:05")
		if v.Author != "" {
			header += StyleDim.Render(" by ") + v.Author
		}
		fmt.Fprintln(&b, header)
		for _, ch := range v.Changes {
			fmt.Fprintf(&b, "  %s %s: %v → %v\n",
				StyleDim.Render("•"),
				StyleBold.Render(fmt.Sprintf("%v", ch.Field)),
				ch.OldValue, ch.NewValue)
		}
		fmt.Fprintln(&b)
	}
	return b.String()
}

func containsLabel(labels []string, label string) bool {
	for _, l := range labels {
		if l == label {
			return true
		}
	}
	return false
}

// ---- init ----

func init() {
	// task create flags
	taskCreateCmd.Flags().StringP("description", "d", "", "Task description")
	taskCreateCmd.Flags().StringArray("ac", nil, "Acceptance criterion (repeatable)")
	taskCreateCmd.Flags().StringP("status", "s", "", "Task status")
	taskCreateCmd.Flags().String("priority", "", "Task priority (low|medium|high)")
	taskCreateCmd.Flags().StringP("assignee", "a", "", "Task assignee")
	taskCreateCmd.Flags().StringArrayP("label", "l", nil, "Task label (repeatable)")
	taskCreateCmd.Flags().String("parent", "", "Parent task ID")
	taskCreateCmd.Flags().String("spec", "", "Linked spec document path")
	taskCreateCmd.Flags().StringArray("fulfills", nil, "Spec AC this task fulfills (repeatable)")
	taskCreateCmd.Flags().String("plan", "", "Implementation plan")
	taskCreateCmd.Flags().String("notes", "", "Implementation notes")

	// task list flags
	taskListCmd.Flags().String("status", "", "Filter by status")
	taskListCmd.Flags().String("assignee", "", "Filter by assignee")
	taskListCmd.Flags().String("priority", "", "Filter by priority")
	taskListCmd.Flags().String("label", "", "Filter by label")
	taskListCmd.Flags().Bool("tree", false, "Show tasks as tree hierarchy")

	// task edit flags
	taskEditCmd.Flags().StringP("title", "t", "", "New title")
	taskEditCmd.Flags().StringP("description", "d", "", "New description")
	taskEditCmd.Flags().StringP("status", "s", "", "New status")
	taskEditCmd.Flags().String("priority", "", "New priority")
	taskEditCmd.Flags().StringP("assignee", "a", "", "New assignee")
	taskEditCmd.Flags().String("labels", "", "New labels (comma-separated)")
	taskEditCmd.Flags().StringArray("ac", nil, "Add acceptance criterion (repeatable)")
	taskEditCmd.Flags().IntSlice("check-ac", nil, "Check AC by 1-based index (repeatable)")
	taskEditCmd.Flags().IntSlice("uncheck-ac", nil, "Uncheck AC by 1-based index (repeatable)")
	taskEditCmd.Flags().IntSlice("remove-ac", nil, "Remove AC by 1-based index (repeatable)")
	taskEditCmd.Flags().String("plan", "", "Set implementation plan")
	taskEditCmd.Flags().String("notes", "", "Set implementation notes (replaces existing)")
	taskEditCmd.Flags().String("append-notes", "", "Append to implementation notes")
	taskEditCmd.Flags().String("spec", "", "Linked spec document path")
	taskEditCmd.Flags().String("parent", "", "Parent task ID")
	taskEditCmd.Flags().StringArray("fulfills", nil, "Spec ACs this task fulfills (repeatable)")
	taskEditCmd.Flags().Int("order", 0, "Display order (lower = first)")

	// task delete flags
	taskDeleteCmd.Flags().String("reason", "", "Required deletion reason")
	taskDeleteCmd.Flags().Bool("yes", false, "Explicitly confirm permanent deletion")
	taskDeleteCmd.Flags().Bool("allow-hard-delete", false, "Grant this local CLI invocation hard-delete capability")
	taskArchiveCmd.Flags().Bool("yes", false, "Execute; otherwise preview only")
	taskUnarchiveCmd.Flags().Bool("yes", false, "Execute; otherwise preview only")
	taskBatchArchiveCmd.Flags().Bool("yes", false, "Execute; otherwise preview only")
	taskBatchUnarchiveCmd.Flags().Bool("yes", false, "Execute; otherwise preview only")

	// Wire up subcommands
	taskCmd.AddCommand(taskCreateCmd)
	taskCmd.AddCommand(taskListCmd)
	taskCmd.AddCommand(taskViewCmd)
	taskCmd.AddCommand(taskEditCmd)
	taskCmd.AddCommand(taskDeleteCmd)
	taskCmd.AddCommand(taskArchiveCmd)
	taskCmd.AddCommand(taskUnarchiveCmd)
	taskCmd.AddCommand(taskBatchArchiveCmd)
	taskCmd.AddCommand(taskBatchUnarchiveCmd)
	taskCmd.AddCommand(taskHistoryCmd)

	// Register under root
	rootCmd.AddCommand(taskCmd)
}

// Ensure unused imports don't cause issues
var _ = os.Stderr
