package cli

import (
	"charm.land/lipgloss/v2"
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
	"github.com/spf13/cobra"
)

var taskCmd = &cobra.Command{
	Use: "task [id]",
	Example: `  # The everyday loop
  knowns task list
  knowns task create "Add JWT auth"
  knowns task edit KN-A1B2C3 -s in-progress
  knowns task edit KN-A1B2C3 -s done

  # Read one task; the id alone is shorthand for "task view"
  knowns task KN-A1B2C3`,
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
	Use: "create <title>",
	Example: `  # A task with nothing but a title
  knowns task create "Add JWT auth"

  # With outcome-oriented acceptance criteria, repeat --ac per criterion
  knowns task create "Add JWT auth" \
    --ac "User can log in and receive a token" \
    --ac "Expired tokens are rejected"

  # With priority and labels
  knowns task create "Fix login timeout" --priority high -l auth,bug

  # As a subtask of an existing task
  knowns task create "Write auth tests" --parent KN-A1B2C3`,
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
	prefix, _ := cmd.Flags().GetString("prefix")

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

	if err := store.CreateTaskWithHistoryPrefixed(context.Background(), task, models.TaskVersion{
		Author:  assignee,
		Changes: store.Versions.TrackChanges(nil, task),
	}, prefix); err != nil {
		return fmt.Errorf("create task: %w", err)
	}

	search.BestEffortIndexTask(store, task.ID)

	fmt.Println(RenderSuccess(fmt.Sprintf("Created task %s: %s", task.ID, task.Title)))
	return nil
}

// --- task list ---

var taskListCmd = &cobra.Command{
	Use: "list",
	Example: `  # Every task
  knowns task list

  # Only what is being worked on
  knowns task list --status in-progress

  # Your own high-priority work
  knowns task list --assignee @me --priority high

  # As a parent/child tree
  knowns task list --tree`,
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
	includeHistorical, _ := cmd.Flags().GetBool("include-historical")

	list := store.Tasks.ListActive
	if includeHistorical {
		list = store.Tasks.ListAll
	}
	tasks, err := list()
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

	// One sort, above the fork into plain / table / interactive, so all three
	// render the same rows in the same order.
	filtered = sortTasksForList(filtered)

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
			return printContent(content)
		}
		return nil
	}

	if plain {
		page, _ := getPageOpts(cmd)
		total := len(filtered)
		limit := defaultPlainItemLimit
		if !plainPageRequested(cmd) {
			limit = max(total, 1)
		}
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
		fmt.Print(renderTaskTable(filtered))
	}

	return nil
}

// --- task view ---

var taskViewCmd = &cobra.Command{
	Use: "view <id>",
	Example: `  # Full task, styled
  knowns task view KN-A1B2C3

  # The same thing, since view is optional
  knowns task KN-A1B2C3

  # Parseable output for an agent
  knowns task KN-A1B2C3 --plain`,
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
		if isTTY() {
			content = renderTaskDetailedMarkdown(task, markdownDisplayWidth())
		}
		return printContent(content)
	}

	return nil
}

// --- task edit ---

var taskEditCmd = &cobra.Command{
	Use: "edit <id>",
	Example: `  # Take the task
  knowns task edit KN-A1B2C3 -s in-progress -a @me

  # Record the plan before writing code
  knowns task edit KN-A1B2C3 --plan $'1. Read the spec\n2. Add the middleware\n3. Test'

  # Tick criterion 1, one-indexed, only once the work is actually done
  knowns task edit KN-A1B2C3 --check-ac 1

  # Append progress without replacing the existing notes
  knowns task edit KN-A1B2C3 --append-notes "Middleware landed, tests next"

  # Finish
  knowns task edit KN-A1B2C3 -s done`,
	Short: "Edit a task",
	Args:  cobra.ExactArgs(1),
	RunE:  runTaskEdit,
}

func runTaskEdit(cmd *cobra.Command, args []string) error {
	id := args[0]
	store := getStore()
	service := newCLITaskLifecycleService(store)
	expectedHash, _ := cmd.Flags().GetString("expected-hash")
	task, err := service.UpdateTask(cmd.Context(), id, tasklifecycle.TaskUpdateOptions{Actor: cliLifecycleActor(), ExpectedHash: expectedHash, Mutate: func(task *models.Task) error {

		// Apply flag updates
		if cmd.Flags().Changed("title") {
			v, _ := cmd.Flags().GetString("title")
			task.Title = v
		}
		if cmd.Flags().Changed("description") {
			v, _ := cmd.Flags().GetString("description")
			task.Description = v
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
			task.ImplementationPlan = v
		}
		if cmd.Flags().Changed("notes") {
			v, _ := cmd.Flags().GetString("notes")
			task.ImplementationNotes = v
		}
		if cmd.Flags().Changed("append-notes") {
			v, _ := cmd.Flags().GetString("append-notes")
			if task.ImplementationNotes == "" {
				task.ImplementationNotes = v
			} else {
				// Blank line so each appended entry stays its own markdown block.
				task.ImplementationNotes = task.ImplementationNotes + "\n\n" + v
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
		expectedHash, _ := cmd.Flags().GetString("expected-hash")
		return runCLILifecycle(cmd, tasklifecycle.Request{Operation: tasklifecycle.OperationArchive, TaskID: args[0], Execute: yes, Actor: cliLifecycleActor(), ExpectedHash: expectedHash}, false)
	},
}

// --- task unarchive ---

var taskUnarchiveCmd = &cobra.Command{
	Use:   "unarchive <id>",
	Short: "Restore a task from the archive",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		yes, _ := cmd.Flags().GetBool("yes")
		expectedHash, _ := cmd.Flags().GetString("expected-hash")
		return runCLILifecycle(cmd, tasklifecycle.Request{Operation: tasklifecycle.OperationReopen, TaskID: args[0], Execute: yes, Actor: cliLifecycleActor(), ExpectedHash: expectedHash}, false)
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
		IndexTask: func(id string) error {
			search.BestEffortIndexTask(store, id)
			return nil
		},
		RemoveTask: func(id string) error {
			search.BestEffortRemoveTask(store, id)
			return nil
		},
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
		revision, _ := cmd.Flags().GetString("revision")
		metadata, _ := cmd.Flags().GetBool("metadata")
		offset, _ := cmd.Flags().GetInt("offset")
		limit, _ := cmd.Flags().GetInt("limit")
		if revision != "" {
			version, err := store.Versions.GetTaskRevisionDetail(args[0], revision)
			if err != nil {
				return fmt.Errorf("get task revision: %w", err)
			}
			if isJSON(cmd) {
				printJSON(version)
			} else {
				history := &models.TaskVersionHistory{TaskID: args[0], CurrentVersion: version.Version, Versions: []models.TaskVersion{*version}}
				if isPlain(cmd) {
					printPaged(cmd, renderPlainTaskHistory(args[0], history))
				} else {
					return printContent(renderTaskHistory(args[0], history))
				}
			}
			return nil
		}
		if metadata || offset != 0 || limit != 0 {
			page, err := store.Versions.ListTaskHistoryMetadata(args[0], offset, limit)
			if err != nil {
				return fmt.Errorf("list task history metadata: %w", err)
			}
			if isJSON(cmd) {
				printJSON(page)
			} else {
				var b strings.Builder
				fmt.Fprintf(&b, "TASK: %s\nOFFSET: %d\nLIMIT: %d\nCURRENT_VERSION: %d\nHAS_MORE: %t\n", args[0], page.Offset, page.Limit, page.CurrentVersion, page.HasMore)
				if page.TailTruncated {
					fmt.Fprintln(&b, "TAIL_TRUNCATED: true")
				}
				for _, item := range page.Items {
					fmt.Fprintf(&b, "VERSION: %s\nTIMESTAMP: %s\n", item.ID, item.Timestamp.Format(time.RFC3339))
					if item.Source != "" {
						fmt.Fprintf(&b, "SOURCE: %s\n", item.Source)
					}
					if item.NewHash != "" {
						fmt.Fprintf(&b, "NEW_HASH: %s\n", item.NewHash)
					}
					fmt.Fprintln(&b)
				}
				printPaged(cmd, b.String())
			}
			return nil
		}
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
			return printContent(content)
		}
		return nil
	},
}

// ---- list view helpers ----

// sortTasksForList is the order a task list is presented in: status rank, then
// explicit display order, then priority, then most recently updated, then ID.
//
// It used to live inside buildTaskListItems, which only the interactive path
// calls, so the same command answered in three different orders depending on how
// it was rendered: sorted when attached to a terminal, raw store order when piped,
// and raw store order again under --plain. Order is a property of the list, not of
// the renderer that draws it.
func sortTasksForList(tasks []*models.Task) []*models.Task {
	sorted := append([]*models.Task(nil), tasks...)
	sort.SliceStable(sorted, func(i, j int) bool {
		left, right := sorted[i], sorted[j]
		if rank := taskStatusListRank(left.Status) - taskStatusListRank(right.Status); rank != 0 {
			return rank < 0
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
		if rank := taskPriorityListRank(left.Priority) - taskPriorityListRank(right.Priority); rank != 0 {
			return rank < 0
		}
		if !left.UpdatedAt.Equal(right.UpdatedAt) {
			return left.UpdatedAt.After(right.UpdatedAt)
		}
		return left.ID < right.ID
	})
	return sorted
}

func taskStatusListRank(status string) int {
	switch status {
	case "urgent":
		return 0
	case "blocked":
		return 1
	case "in-progress":
		return 2
	case "in-review":
		return 3
	case "todo":
		return 4
	case "on-hold":
		return 5
	case "done":
		return 6
	default:
		return 5
	}
}

// isRankedTaskStatus reports whether taskStatusListRank recognises a status by
// name rather than falling through to its default.
func isRankedTaskStatus(status string) bool {
	switch status {
	case "urgent", "blocked", "in-progress", "in-review", "todo", "on-hold", "done":
		return true
	}
	return false
}

func taskPriorityListRank(priority string) int {
	switch priority {
	case "high":
		return 0
	case "medium":
		return 1
	case "low":
		return 2
	default:
		return 3
	}
}

// ---- output helpers ----

// sprintTaskListPlain renders one task per line, in a fixed field order.
//
// It used to group under status headings ("To Do:", "Done:") with the status
// carried only by the heading. That makes the format unusable for the consumer it
// is named after: `knowns task list --plain | grep <id>` returned a line with no
// status in it, and reading a row's status meant tracking which heading it fell
// under. Every field a row is about now lives on that row.
//
// Fields are ID, STATUS, PRIORITY, ASSIGNEE, TITLE. Assignee prints "-" when
// empty rather than collapsing the column, so the field a value lands in does not
// depend on which task it belongs to. Title comes last, being the only field that
// can contain spaces.
func sprintTaskListPlain(tasks []*models.Task) string {
	var b strings.Builder

	idW, statusW, prioW, assigneeW := 0, 0, 0, 0
	for _, t := range tasks {
		idW = max(idW, len(t.ID))
		statusW = max(statusW, len(t.Status))
		prioW = max(prioW, len(t.Priority))
		assigneeW = max(assigneeW, len(plainAssignee(t)))
	}

	for _, t := range tasks {
		fmt.Fprintf(&b, "%-*s  %-*s  %-*s  %-*s  %s\n",
			idW, t.ID,
			statusW, t.Status,
			prioW, t.Priority,
			assigneeW, plainAssignee(t),
			t.Title,
		)
	}

	if len(tasks) > 0 {
		fmt.Fprintf(&b, "\nTotal: %d %s (%s)\n", len(tasks), pluralTasks(len(tasks)), plainStatusSummary(tasks))
	}
	return b.String()
}

// plainAssignee keeps the assignee column present on every row.
func plainAssignee(t *models.Task) string {
	if t.Assignee == "" {
		return "-"
	}
	return t.Assignee
}

func pluralTasks(n int) string {
	if n == 1 {
		return "task"
	}
	return "tasks"
}

// plainStatusSummary counts tasks per status, ordered by taskStatusListRank so the
// summary reads in the same order the rows above it are sorted.
func plainStatusSummary(tasks []*models.Task) string {
	counts := map[string]int{}
	for _, t := range tasks {
		counts[t.Status]++
	}

	// Order by the same rank the list itself sorts on. A second ordering of the
	// same statuses would be free to drift from the first, and the summary would
	// then describe the rows in an order they are not printed in.
	statuses := make([]string, 0, len(counts))
	for status := range counts {
		statuses = append(statuses, status)
	}
	sort.SliceStable(statuses, func(i, j int) bool {
		return taskStatusListRank(statuses[i]) < taskStatusListRank(statuses[j])
	})

	var parts []string
	seen := map[string]bool{}
	for _, status := range statuses {
		if isRankedTaskStatus(status) {
			parts = append(parts, fmt.Sprintf("%d %s", counts[status], status))
			seen[status] = true
		}
	}
	// Any status the canonical order does not name still gets counted.
	var extra []string
	for status, n := range counts {
		if !seen[status] {
			extra = append(extra, fmt.Sprintf("%d %s", n, status))
		}
	}
	sort.Strings(extra)
	return strings.Join(append(parts, extra...), ", ")
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
	return renderTaskDetailedWithBodyRenderer(t, passthroughMarkdown)
}

func renderTaskDetailedMarkdown(t *models.Task, width int) string {
	return renderTaskDetailedMarkdownWithStyle(t, width, terminalMarkdownStyle())
}

func renderTaskDetailedMarkdownWithStyle(t *models.Task, width int, style string) string {
	return renderTaskDetailedWithBodyRenderer(t, newTerminalMarkdownBodyRenderer(width, style))
}

func renderTaskDetailedWithBodyRenderer(t *models.Task, renderBody markdownBodyRenderer) string {
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
		fmt.Fprintf(&b, "\n%s\n%s\n", RenderSectionHeader("Description"), renderBody(t.Description))
	}
	if len(t.AcceptanceCriteria) > 0 {
		fmt.Fprintf(&b, "\n%s\n", RenderSectionHeader("Acceptance Criteria"))
		for i, ac := range t.AcceptanceCriteria {
			fmt.Fprintln(&b, RenderACCheckbox(i+1, ac.Text, ac.Completed))
		}
	}
	if t.ImplementationPlan != "" {
		fmt.Fprintf(&b, "\n%s\n%s\n", RenderSectionHeader("Implementation Plan"), renderBody(t.ImplementationPlan))
	}
	if t.ImplementationNotes != "" {
		fmt.Fprintf(&b, "\n%s\n%s\n", RenderSectionHeader("Implementation Notes"), renderBody(t.ImplementationNotes))
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

// renderTaskTable renders the styled task table.
//
// Column widths come from the data and from the terminal, not from constants. The
// old fixed 96-column layout cut every title at 35 bytes however much room the
// terminal had, and it cut by byte, so a title carrying any multi-byte character
// was sliced mid-rune and the command emitted invalid UTF-8. That is not only ugly:
// it breaks anything reading the output, as sed refusing the stream with "illegal
// byte sequence" showed.
func renderTaskTable(tasks []*models.Task) string {
	const (
		indent    = 2
		gap       = 2
		minTitle  = 24
		maxAssign = 20
	)

	idW, assigneeW, titleW := len("ID"), len("ASSIGNEE"), len("TITLE")
	statusW, prioW := len("STATUS"), len("PRIORITY")
	for _, t := range tasks {
		idW = max(idW, lipgloss.Width(t.ID))
		statusW = max(statusW, lipgloss.Width(t.Status))
		prioW = max(prioW, lipgloss.Width(t.Priority))
		assigneeW = max(assigneeW, lipgloss.Width(t.Assignee))
		titleW = max(titleW, lipgloss.Width(t.Title))
	}
	assigneeW = min(assigneeW, maxAssign)

	// The title column takes whatever the fixed columns leave, and no more than it
	// needs. Titles that all fit are never truncated.
	fixed := indent + idW + statusW + prioW + assigneeW + gap*4
	if room := terminalWidth() - fixed; room < titleW {
		titleW = max(room, minTitle)
	}

	var b strings.Builder
	sep := strings.Repeat(" ", gap)
	pad := strings.Repeat(" ", indent)

	fmt.Fprintln(&b, pad+strings.Join([]string{
		StyleBold.Render(padRight("ID", idW)),
		StyleBold.Render(padRight("TITLE", titleW)),
		StyleBold.Render(padRight("STATUS", statusW)),
		StyleBold.Render(padRight("PRIORITY", prioW)),
		StyleBold.Render("ASSIGNEE"),
	}, sep))
	fmt.Fprintln(&b, pad+RenderSeparator(fixed+titleW-indent))

	for _, t := range tasks {
		fmt.Fprintln(&b, pad+strings.Join([]string{
			StyleID.Render(padRight(t.ID, idW)),
			padRight(truncateVisible(t.Title, titleW), titleW),
			StatusStyle(t.Status).Render(padRight(t.Status, statusW)),
			PriorityStyle(t.Priority).Render(padRight(t.Priority, prioW)),
			truncateVisible(t.Assignee, assigneeW),
		}, sep))
	}

	if len(tasks) > 0 {
		fmt.Fprintf(&b, "\n%s%s\n", pad,
			StyleDim.Render(fmt.Sprintf("Total: %d %s (%s)", len(tasks), pluralTasks(len(tasks)), plainStatusSummary(tasks))))
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

func renderPlainTaskHistory(id string, history *models.TaskVersionHistory) string {
	var b strings.Builder
	fmt.Fprintf(&b, "TASK: %s\nVERSIONS: %d\n\n", id, history.CurrentVersion)
	if history.TailTruncated {
		fmt.Fprintln(&b, "TAIL_TRUNCATED: true")
		fmt.Fprintln(&b)
	}
	for _, v := range history.Versions {
		fmt.Fprintf(&b, "VERSION: %s\nTIMESTAMP: %s\n", v.ID, v.Timestamp.Format(time.RFC3339))
		for _, ch := range v.Changes {
			fmt.Fprintf(&b, "  CHANGE: %s: %v -> %v\n", ch.Field, ch.OldValue, ch.NewValue)
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
	taskCreateCmd.Flags().String("prefix", "", "Custom task ID prefix (2-8 alphanumeric characters)")

	// task list flags
	taskListCmd.Flags().String("status", "", "Filter by status")
	taskListCmd.Flags().String("assignee", "", "Filter by assignee")
	taskListCmd.Flags().String("priority", "", "Filter by priority")
	taskListCmd.Flags().String("label", "", "Filter by label")
	taskListCmd.Flags().Bool("tree", false, "Show tasks as tree hierarchy")
	taskListCmd.Flags().Bool("include-historical", false, "Include historical entities, including archived Tasks")

	// task history flags (additive; no flags preserve the legacy full output)
	taskHistoryCmd.Flags().Bool("metadata", false, "List payload-free revision metadata")
	taskHistoryCmd.Flags().Int("offset", 0, "Metadata page offset (newest first)")
	taskHistoryCmd.Flags().Int("limit", 0, "Metadata page size (0 means all)")
	taskHistoryCmd.Flags().String("revision", "", "Load one revision detail (vN or numeric)")

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
	taskEditCmd.Flags().String("expected-hash", "", "Expected canonical hash for optimistic concurrency")
	taskEditCmd.Flags().StringArray("fulfills", nil, "Spec ACs this task fulfills (repeatable)")
	taskEditCmd.Flags().Int("order", 0, "Display order (lower = first)")

	// task delete flags
	taskDeleteCmd.Flags().String("reason", "", "Required deletion reason")
	taskDeleteCmd.Flags().Bool("yes", false, "Explicitly confirm permanent deletion")
	taskDeleteCmd.Flags().Bool("allow-hard-delete", false, "Grant this local CLI invocation hard-delete capability")
	taskArchiveCmd.Flags().Bool("yes", false, "Execute; otherwise preview only")
	taskArchiveCmd.Flags().String("expected-hash", "", "Expected canonical hash for optimistic concurrency")
	taskUnarchiveCmd.Flags().Bool("yes", false, "Execute; otherwise preview only")
	taskUnarchiveCmd.Flags().String("expected-hash", "", "Expected canonical hash for optimistic concurrency")
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
