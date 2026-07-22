package cli

import (
	"encoding/csv"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
	"github.com/spf13/cobra"
)

var timeCmd = &cobra.Command{
	Use:   "time",
	Short: "Time tracking",
}

// --- time start ---

var timeStartCmd = &cobra.Command{
	Use:   "start <taskId>",
	Short: "Start a timer for a task",
	Args:  cobra.ExactArgs(1),
	RunE:  runTimeStart,
}

func runTimeStart(cmd *cobra.Command, args []string) error {
	taskID := args[0]
	store := getStore()

	// Look up task title
	task, err := store.Tasks.Get(taskID)
	if err != nil {
		return fmt.Errorf("task %q not found", taskID)
	}

	if err := store.Time.Start(taskID, task.Title); err != nil {
		return fmt.Errorf("start timer: %w", err)
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Timer started for task %s (%s)", taskID, task.Title)))
	return nil
}

// --- time stop ---

var timeStopCmd = &cobra.Command{
	Use:   "stop [taskId]",
	Short: "Stop the active timer",
	Args:  cobra.MaximumNArgs(1),
	RunE:  runTimeStop,
}

func runTimeStop(cmd *cobra.Command, args []string) error {
	store := getStore()

	var taskID string
	if len(args) > 0 {
		taskID = args[0]
	} else {
		// Find the first (or only) active timer
		state, err := store.Time.GetState()
		if err != nil {
			return fmt.Errorf("get timer state: %w", err)
		}
		if len(state.Active) == 0 {
			return fmt.Errorf("no active timer")
		}
		if len(state.Active) > 1 {
			return fmt.Errorf("multiple timers active, please specify task ID")
		}
		taskID = state.Active[0].TaskID
	}

	entry, err := newCLITaskLifecycleService(store).StopTimer(cmd.Context(), taskID, cliLifecycleActor())
	if err != nil {
		return fmt.Errorf("stop timer: %w", err)
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Timer stopped for task %s. Duration: %s", taskID, formatDuration(entry.Duration))))
	return nil
}

// --- time pause ---

var timePauseCmd = &cobra.Command{
	Use:   "pause [taskId]",
	Short: "Pause the active timer",
	Args:  cobra.MaximumNArgs(1),
	RunE:  runTimePause,
}

func runTimePause(cmd *cobra.Command, args []string) error {
	store := getStore()

	var taskID string
	if len(args) > 0 {
		taskID = args[0]
	} else {
		state, err := store.Time.GetState()
		if err != nil {
			return fmt.Errorf("get timer state: %w", err)
		}
		if len(state.Active) == 0 {
			return fmt.Errorf("no active timer")
		}
		if len(state.Active) > 1 {
			return fmt.Errorf("multiple timers active, please specify task ID")
		}
		taskID = state.Active[0].TaskID
	}

	if err := store.Time.Pause(taskID); err != nil {
		return fmt.Errorf("pause timer: %w", err)
	}

	fmt.Println(StyleWarning.Render(fmt.Sprintf("⏸ Timer paused for task %s", taskID)))
	return nil
}

// --- time resume ---

var timeResumeCmd = &cobra.Command{
	Use:   "resume [taskId]",
	Short: "Resume a paused timer",
	Args:  cobra.MaximumNArgs(1),
	RunE:  runTimeResume,
}

func runTimeResume(cmd *cobra.Command, args []string) error {
	store := getStore()

	var taskID string
	if len(args) > 0 {
		taskID = args[0]
	} else {
		state, err := store.Time.GetState()
		if err != nil {
			return fmt.Errorf("get timer state: %w", err)
		}
		if len(state.Active) == 0 {
			return fmt.Errorf("no active timer")
		}
		// Find a paused timer
		for _, a := range state.Active {
			if a.PausedAt != nil {
				taskID = a.TaskID
				break
			}
		}
		if taskID == "" {
			return fmt.Errorf("no paused timer found")
		}
	}

	if err := store.Time.Resume(taskID); err != nil {
		return fmt.Errorf("resume timer: %w", err)
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Timer resumed for task %s", taskID)))
	return nil
}

// --- time add ---

var timeAddCmd = &cobra.Command{
	Use:   "add <taskId> <duration>",
	Short: "Manually add a time entry (e.g. 2h, 30m)",
	Args:  cobra.ExactArgs(2),
	RunE:  runTimeAdd,
}

func runTimeAdd(cmd *cobra.Command, args []string) error {
	taskID := args[0]
	durationStr := args[1]
	store := getStore()

	durationSecs, err := models.ParseDuration(durationStr)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", durationStr, err)
	}

	note, _ := cmd.Flags().GetString("note")
	dateStr, _ := cmd.Flags().GetString("date")

	var entryTime time.Time
	if dateStr != "" {
		entryTime, err = time.Parse("2006-01-02", dateStr)
		if err != nil {
			return fmt.Errorf("invalid date %q (use YYYY-MM-DD): %w", dateStr, err)
		}
		entryTime = entryTime.UTC()
	} else {
		entryTime = time.Now().UTC()
	}

	// Verify task exists
	_, err = store.Tasks.Get(taskID)
	if err != nil {
		return fmt.Errorf("task %q not found", taskID)
	}

	endTime := entryTime.Add(time.Duration(durationSecs) * time.Second)
	entryID := fmt.Sprintf("te-%d-%s", entryTime.UnixMilli(), taskID)
	entry := models.TimeEntry{
		ID:        entryID,
		StartedAt: entryTime,
		EndedAt:   &endTime,
		Duration:  durationSecs,
		Note:      note,
	}

	if _, err := newCLITaskLifecycleService(store).AddTimeEntry(cmd.Context(), taskID, tasklifecycle.TimeMutationOptions{Actor: cliLifecycleActor(), Entry: entry}); err != nil {
		return fmt.Errorf("save time entry: %w", err)
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Added %s to task %s", formatDuration(durationSecs), taskID)))
	return nil
}

// --- time status ---

var timeStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show current timer status",
	RunE:  runTimeStatus,
}

func runTimeStatus(cmd *cobra.Command, args []string) error {
	store := getStore()

	state, err := store.Time.GetState()
	if err != nil {
		return fmt.Errorf("get timer state: %w", err)
	}

	plain := isPlain(cmd)

	if len(state.Active) == 0 {
		if plain {
			fmt.Println("STATUS: no active timer")
		} else {
			fmt.Println(StyleDim.Render("No active timer."))
		}
		return nil
	}

	now := time.Now()
	if plain {
		fmt.Printf("ACTIVE TIMERS: %d\n\n", len(state.Active))
		for _, a := range state.Active {
			elapsed := elapsedSeconds(a, now)
			status := "running"
			if a.PausedAt != nil {
				status = "paused"
			}
			fmt.Printf("TASK: %s\n", a.TaskID)
			if a.TaskTitle != "" {
				fmt.Printf("TITLE: %s\n", a.TaskTitle)
			}
			fmt.Printf("STATUS: %s\n", status)
			fmt.Printf("ELAPSED: %s\n", formatDuration(elapsed))
			fmt.Printf("STARTED: %s\n", a.StartedAt)
			fmt.Println()
		}
	} else {
		fmt.Printf("%s %d\n\n", StyleBold.Render("Active timers:"), len(state.Active))
		for _, a := range state.Active {
			elapsed := elapsedSeconds(a, now)
			title := a.TaskTitle
			if title == "" {
				title = a.TaskID
			}
			statusIndicator := StyleSuccess.Render("● running")
			if a.PausedAt != nil {
				statusIndicator = StyleWarning.Render("● paused")
			}
			fmt.Printf("  %s %s — %s  %s\n",
				StyleID.Render("["+a.TaskID+"]"),
				title,
				StyleInfo.Render(formatDuration(elapsed)),
				statusIndicator)
		}
	}
	return nil
}

// --- time report ---

var timeReportCmd = &cobra.Command{
	Use:   "report",
	Short: "Generate time tracking report",
	RunE:  runTimeReport,
}

func runTimeReport(cmd *cobra.Command, args []string) error {
	store := getStore()

	fromStr, _ := cmd.Flags().GetString("from")
	toStr, _ := cmd.Flags().GetString("to")
	byLabel, _ := cmd.Flags().GetBool("by-label")
	byStatus, _ := cmd.Flags().GetBool("by-status")
	csvMode, _ := cmd.Flags().GetBool("csv")

	var fromTime, toTime time.Time
	var err error
	if fromStr != "" {
		fromTime, err = time.Parse("2006-01-02", fromStr)
		if err != nil {
			return fmt.Errorf("invalid --from date: %w", err)
		}
	}
	if toStr != "" {
		toTime, err = time.Parse("2006-01-02", toStr)
		if err != nil {
			return fmt.Errorf("invalid --to date: %w", err)
		}
		// Include the full day
		toTime = toTime.Add(24*time.Hour - time.Second)
	}

	allEntries, err := store.Time.GetAllEntries()
	if err != nil {
		return fmt.Errorf("get time entries: %w", err)
	}

	tasks, _ := store.Tasks.List()
	taskByID := make(map[string]*models.Task)
	for _, t := range tasks {
		taskByID[t.ID] = t
	}

	type reportRow struct {
		TaskID    string
		TaskTitle string
		Labels    []string
		Duration  int
		Date      string
		Note      string
	}

	var rows []reportRow
	totalSecs := 0

	for taskID, entries := range allEntries {
		for _, entry := range entries {
			// Apply date filter
			if !fromTime.IsZero() && entry.StartedAt.Before(fromTime) {
				continue
			}
			if !toTime.IsZero() && entry.StartedAt.After(toTime) {
				continue
			}

			title := taskID
			var labels []string
			if t, ok := taskByID[taskID]; ok {
				title = t.Title
				labels = t.Labels
			}

			rows = append(rows, reportRow{
				TaskID:    taskID,
				TaskTitle: title,
				Labels:    labels,
				Duration:  entry.Duration,
				Date:      entry.StartedAt.Format("2006-01-02"),
				Note:      entry.Note,
			})
			totalSecs += entry.Duration
		}
	}

	if csvMode {
		w := csv.NewWriter(os.Stdout)
		_ = w.Write([]string{"date", "task_id", "title", "labels", "duration_secs", "duration", "note"})
		for _, r := range rows {
			_ = w.Write([]string{
				r.Date,
				r.TaskID,
				r.TaskTitle,
				strings.Join(r.Labels, ";"),
				fmt.Sprintf("%d", r.Duration),
				formatDuration(r.Duration),
				r.Note,
			})
		}
		w.Flush()
		return nil
	}

	plain := isPlain(cmd)

	if byLabel {
		// Group by label
		labelTotals := make(map[string]int)
		for _, r := range rows {
			if len(r.Labels) == 0 {
				labelTotals["(unlabeled)"] += r.Duration
			}
			for _, l := range r.Labels {
				labelTotals[l] += r.Duration
			}
		}
		if plain {
			fmt.Println("TIME REPORT BY LABEL:")
			for label, secs := range labelTotals {
				fmt.Printf("  %s: %s\n", label, formatDuration(secs))
			}
			fmt.Printf("\nTOTAL: %s\n", formatDuration(totalSecs))
		} else {
			fmt.Println(RenderSectionHeader("Time Report by Label"))
			fmt.Println(RenderSeparator(40))
			for label, secs := range labelTotals {
				fmt.Printf("  %-25s %s\n", label, StyleInfo.Render(formatDuration(secs)))
			}
			fmt.Println(RenderSeparator(40))
			fmt.Printf("  %s %s\n", StyleBold.Render(fmt.Sprintf("%-25s", "TOTAL")), StyleInfo.Render(formatDuration(totalSecs)))
		}
		return nil
	}

	if byStatus {
		// Group by task status
		statusTotals := make(map[string]int)
		for _, r := range rows {
			status := "unknown"
			if t, ok := taskByID[r.TaskID]; ok {
				status = t.Status
			}
			statusTotals[status] += r.Duration
		}
		if plain {
			fmt.Println("TIME REPORT BY STATUS:")
			for status, secs := range statusTotals {
				fmt.Printf("  %s: %s\n", status, formatDuration(secs))
			}
			fmt.Printf("\nTOTAL: %s\n", formatDuration(totalSecs))
		} else {
			fmt.Println(RenderSectionHeader("Time Report by Status"))
			fmt.Println(RenderSeparator(40))
			for status, secs := range statusTotals {
				fmt.Printf("  %s %s\n",
					StatusStyle(status).Render(fmt.Sprintf("%-25s", status)),
					StyleInfo.Render(formatDuration(secs)))
			}
			fmt.Println(RenderSeparator(40))
			fmt.Printf("  %s %s\n", StyleBold.Render(fmt.Sprintf("%-25s", "TOTAL")), StyleInfo.Render(formatDuration(totalSecs)))
		}
		return nil
	}

	// Default: per-task summary
	taskTotals := make(map[string]int)
	taskTitles := make(map[string]string)
	for _, r := range rows {
		taskTotals[r.TaskID] += r.Duration
		taskTitles[r.TaskID] = r.TaskTitle
	}

	if plain {
		fmt.Println("TIME REPORT:")
		for id, secs := range taskTotals {
			fmt.Printf("  TASK: %s (%s): %s\n", id, taskTitles[id], formatDuration(secs))
		}
		fmt.Printf("\nTOTAL: %s\n", formatDuration(totalSecs))
	} else {
		fmt.Println(RenderSectionHeader("Time Report"))
		if !fromTime.IsZero() || !toTime.IsZero() {
			fmt.Println(StyleDim.Render(fmt.Sprintf("Period: %s - %s", fromStr, toStr)))
		}
		fmt.Println(RenderSeparator(60))
		for id, secs := range taskTotals {
			title := taskTitles[id]
			if len(title) > 35 {
				title = title[:32] + "..."
			}
			fmt.Printf("  %s %-35s %s\n",
				StyleID.Render(fmt.Sprintf("%-8s", id)),
				title,
				StyleInfo.Render(formatDuration(secs)))
		}
		fmt.Println(RenderSeparator(60))
		fmt.Printf("  %-8s %s %s\n", "", StyleBold.Render(fmt.Sprintf("%-35s", "TOTAL")), StyleInfo.Render(formatDuration(totalSecs)))
	}
	return nil
}

// elapsedSeconds calculates elapsed active seconds for a timer.
func elapsedSeconds(a models.ActiveTimer, now time.Time) int {
	var startTime time.Time
	for _, f := range []string{
		"2006-01-02T15:04:05.000Z",
		time.RFC3339Nano,
		time.RFC3339,
	} {
		if t, err := time.Parse(f, a.StartedAt); err == nil {
			startTime = t
			break
		}
	}
	if startTime.IsZero() {
		return 0
	}

	elapsed := now.Sub(startTime).Milliseconds() - a.TotalPausedMs
	if a.PausedAt != nil {
		// Currently paused: don't include time since pause
		var pausedAt time.Time
		for _, f := range []string{
			"2006-01-02T15:04:05.000Z",
			time.RFC3339Nano,
			time.RFC3339,
		} {
			if t, err := time.Parse(f, *a.PausedAt); err == nil {
				pausedAt = t
				break
			}
		}
		if !pausedAt.IsZero() {
			elapsed -= now.Sub(pausedAt).Milliseconds()
		}
	}
	if elapsed < 0 {
		return 0
	}
	return int(elapsed / 1000)
}

// --- time log ---

var timeLogCmd = &cobra.Command{
	Use:   "log <taskId>",
	Short: "Show time log for a specific task",
	Args:  cobra.ExactArgs(1),
	RunE:  runTimeLog,
}

func runTimeLog(cmd *cobra.Command, args []string) error {
	taskID := args[0]
	store := getStore()

	entries, err := store.Time.GetEntries(taskID)
	if err != nil {
		return fmt.Errorf("get time entries for task %s: %w", taskID, err)
	}

	plain := isPlain(cmd)

	if len(entries) == 0 {
		if plain {
			fmt.Printf("TASK: %s\nENTRIES: 0\n", taskID)
		} else {
			fmt.Println(StyleDim.Render(fmt.Sprintf("No time entries for task %s.", taskID)))
		}
		return nil
	}

	totalSecs := 0
	for _, e := range entries {
		totalSecs += e.Duration
	}

	if plain {
		fmt.Printf("TASK: %s\n", taskID)
		fmt.Printf("ENTRIES: %d\n", len(entries))
		fmt.Printf("TOTAL: %s\n\n", formatDuration(totalSecs))
		for _, e := range entries {
			fmt.Printf("ENTRY: %s\n", e.ID)
			fmt.Printf("  STARTED: %s\n", e.StartedAt.Format(time.RFC3339))
			if e.EndedAt != nil {
				fmt.Printf("  ENDED: %s\n", e.EndedAt.Format(time.RFC3339))
			}
			fmt.Printf("  DURATION: %s\n", formatDuration(e.Duration))
			if e.Note != "" {
				fmt.Printf("  NOTE: %s\n", e.Note)
			}
			fmt.Println()
		}
	} else {
		fmt.Printf("%s %s\n\n",
			RenderSectionHeader(fmt.Sprintf("Time log for task %s", taskID)),
			StyleDim.Render(fmt.Sprintf("(%d entries, total: %s)", len(entries), formatDuration(totalSecs))))
		fmt.Printf("  %s  %s  %s  %s\n",
			StyleBold.Render(fmt.Sprintf("%-20s", "STARTED")),
			StyleBold.Render(fmt.Sprintf("%-20s", "ENDED")),
			StyleBold.Render(fmt.Sprintf("%-12s", "DURATION")),
			StyleBold.Render("NOTE"))
		fmt.Println("  " + RenderSeparator(70))
		for _, e := range entries {
			ended := StyleDim.Render("-")
			if e.EndedAt != nil {
				ended = e.EndedAt.Format("2006-01-02 15:04")
			}
			fmt.Printf("  %-20s  %-20s  %s  %s\n",
				e.StartedAt.Format("2006-01-02 15:04"),
				ended,
				StyleInfo.Render(fmt.Sprintf("%-12s", formatDuration(e.Duration))),
				e.Note,
			)
		}
		fmt.Println("  " + RenderSeparator(70))
		fmt.Printf("  %-20s  %s  %s\n", "", StyleBold.Render(fmt.Sprintf("%-20s", "TOTAL")), StyleInfo.Render(formatDuration(totalSecs)))
	}
	return nil
}

func init() {
	timeAddCmd.Flags().StringP("note", "n", "", "Note for this time entry")
	timeAddCmd.Flags().StringP("date", "d", "", "Date (YYYY-MM-DD, defaults to today)")

	timeReportCmd.Flags().String("from", "", "Start date (YYYY-MM-DD)")
	timeReportCmd.Flags().String("to", "", "End date (YYYY-MM-DD)")
	timeReportCmd.Flags().Bool("by-label", false, "Group by label")
	timeReportCmd.Flags().Bool("by-status", false, "Group by status")
	timeReportCmd.Flags().Bool("csv", false, "Output as CSV")

	timeCmd.AddCommand(timeStartCmd)
	timeCmd.AddCommand(timeStopCmd)
	timeCmd.AddCommand(timePauseCmd)
	timeCmd.AddCommand(timeResumeCmd)
	timeCmd.AddCommand(timeAddCmd)
	timeCmd.AddCommand(timeStatusCmd)
	timeCmd.AddCommand(timeReportCmd)
	timeCmd.AddCommand(timeLogCmd)

	rootCmd.AddCommand(timeCmd)
}
