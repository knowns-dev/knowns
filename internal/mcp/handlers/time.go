package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
	"github.com/mark3labs/mcp-go/mcp"
)

// RegisterTimeTool registers the consolidated time tracking MCP tool.
func RegisterTimeTool(s toolRegistrar, getStore func() *storage.Store) {
	s.AddTool(
		mcp.NewTool("time",
			mcp.WithDescription(`Time tracking operations. Use 'action' to specify: start, stop, add, report.

- start: Start an active timer for a task. Required: taskId. Optional: none. Returns: timer start confirmation and task ID; errors if another timer is active.
- stop: Stop an active timer. Required: taskId. Optional: none. Returns: stopped timer entry with elapsed duration and task update confirmation.
- add: Add a manual time entry. Required: taskId, duration. Optional: note, date (YYYY-MM-DD; defaults to today). Returns: created time entry and updated task time total.
- report: Summarize time entries. Required: none. Optional: from, to, groupBy (task, label, status). Returns: time totals and grouped report rows for the requested date range.
`),
			mcp.WithString("action",
				mcp.Required(),
				mcp.Description("Action to perform"),
				mcp.Enum("start", "stop", "add", "report"),
			),
			mcp.WithString("taskId",
				mcp.Description("Task ID to track time for (required for start, stop, add)"),
			),
			mcp.WithString("duration",
				mcp.Description("Duration (e.g., '2h', '30m', '1h30m') (required for add)"),
			),
			mcp.WithString("note",
				mcp.Description("Optional note for this entry (add)"),
			),
			mcp.WithString("date",
				mcp.Description("Optional date (YYYY-MM-DD, defaults to now) (add)"),
			),
			mcp.WithString("from",
				mcp.Description("Start date (YYYY-MM-DD) (report)"),
			),
			mcp.WithString("to",
				mcp.Description("End date (YYYY-MM-DD) (report)"),
			),
			mcp.WithString("groupBy",
				mcp.Description("Group results by task, label, or status (report)"),
				mcp.Enum("task", "label", "status"),
			),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			action, err := req.RequireString("action")
			if err != nil {
				return errResult("action is required")
			}
			switch action {
			case "start":
				return handleTimeStart(getStore, req)
			case "stop":
				return handleTimeStop(getStore, req)
			case "add":
				return handleTimeAdd(getStore, req)
			case "report":
				return handleTimeReport(getStore, req)
			default:
				return errResultf("unknown time action: %s", action)
			}
		},
	)

	registerHelp(s, "time.start", HelpEntry{When: "Start mandatory task time tracking when beginning task work.", Params: map[string]string{"taskId": "required — task ID to track time for"}, Why: "Task workflow requires active time tracking for implementation work.", Flow: "Set task in-progress, start timer, implement, then stop timer before marking done."})
	registerHelp(s, "time.stop", HelpEntry{When: "Stop active task timer after finishing or pausing tracked work.", Params: map[string]string{"taskId": "required — task ID for active timer"}, Why: "Stopping timer records elapsed time on task; required before completion.", Flow: "Stop timer before setting task status to done."})
	registerHelp(s, "time.add", HelpEntry{When: "Add manual time for past work or to repair forgotten timer usage.", Params: map[string]string{"taskId": "required — task ID", "duration": "required — duration like 2h, 30m, 1h30m", "note": "optional entry note", "date": "YYYY-MM-DD; defaults to today"}, Examples: []string{`time({ action: "add", taskId: "abc123", duration: "30m", note: "Forgot timer" })`}})
	registerHelp(s, "time.report", HelpEntry{When: "Summarize tracked time over a date range for planning, review, or reporting.", Params: map[string]string{"from": "start date YYYY-MM-DD", "to": "end date YYYY-MM-DD", "groupBy": "task | label | status"}})
}

func handleTimeStart(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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

	if err := store.Time.Start(task.ID, task.Title); err != nil {
		return errFailed("start timer", err)
	}

	go notifyTimeUpdated(store)

	result := map[string]any{
		"success": true,
		"taskId":  task.ID,
		"message": fmt.Sprintf(MsgTimerStarted, task.Title),
	}
	out, _ := json.MarshalIndent(result, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleTimeStop(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	taskID, err := req.RequireString("taskId")
	if err != nil {
		return errResult(ErrTaskIDReq)
	}

	entry, err := newMCPTaskLifecycleService(store).StopTimer(context.Background(), taskID, "mcp")
	if err != nil {
		return errFailed("stop timer", err)
	}

	go notifyTimeUpdated(store)

	result := map[string]any{
		"success":  true,
		"taskId":   taskID,
		"duration": entry.Duration,
		"entry":    entry,
		"message":  fmt.Sprintf("Timer stopped. Duration: %s", formatDuration(entry.Duration)),
	}
	out, _ := json.MarshalIndent(result, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleTimeAdd(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	taskID, err := req.RequireString("taskId")
	if err != nil {
		return errResult(ErrTaskIDReq)
	}
	durationStr, err := req.RequireString("duration")
	if err != nil {
		return errResult(err.Error())
	}

	durationSecs, err := models.ParseDuration(durationStr)
	if err != nil {
		return errResultf("Invalid duration %q: %s", durationStr, err.Error())
	}

	task, err := store.Tasks.Get(taskID)
	if err != nil {
		return errNotFound("Task", err)
	}

	args := req.GetArguments()

	startedAt := time.Now().UTC()
	if dateStr, ok := stringArg(args, "date"); ok && dateStr != "" {
		parsed, parseErr := time.Parse("2006-01-02", dateStr)
		if parseErr == nil {
			startedAt = parsed.UTC()
		}
	}
	endedAt := startedAt.Add(time.Duration(durationSecs) * time.Second)

	entryID := fmt.Sprintf("te-%d-%s", time.Now().UnixMilli(), taskID)
	entry := models.TimeEntry{
		ID:        entryID,
		StartedAt: startedAt,
		EndedAt:   &endedAt,
		Duration:  durationSecs,
	}
	if note, ok := stringArg(args, "note"); ok {
		entry.Note = note
	}

	if _, err := newMCPTaskLifecycleService(store).AddTimeEntry(context.Background(), taskID, tasklifecycle.TimeMutationOptions{Actor: "mcp", Entry: entry}); err != nil {
		return errFailed("save time entry", err)
	}

	go notifyTimeUpdated(store)

	result := map[string]any{
		"success":  true,
		"taskId":   taskID,
		"duration": durationSecs,
		"entry":    entry,
		"message":  fmt.Sprintf("Added %s to task '%s'", durationStr, task.Title),
	}
	out, _ := json.MarshalIndent(result, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleTimeReport(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	args := req.GetArguments()
	fromStr, _ := stringArg(args, "from")
	toStr, _ := stringArg(args, "to")
	groupBy, _ := stringArg(args, "groupBy")

	var fromTime, toTime time.Time
	if fromStr != "" {
		fromTime, _ = time.Parse("2006-01-02", fromStr)
	}
	if toStr != "" {
		t, err := time.Parse("2006-01-02", toStr)
		if err == nil {
			toTime = t.Add(24*time.Hour - time.Second)
		}
	}

	allEntries, err := store.Time.GetAllEntries()
	if err != nil {
		return errFailed("load time entries", err)
	}

	tasks, _ := store.Tasks.List()
	taskMap := make(map[string]*models.Task)
	for _, t := range tasks {
		taskMap[t.ID] = t
	}

	type reportEntry struct {
		TaskID    string `json:"taskId"`
		TaskTitle string `json:"taskTitle,omitempty"`
		Duration  int    `json:"duration"`
		Note      string `json:"note,omitempty"`
		Date      string `json:"date,omitempty"`
	}

	var entries []reportEntry
	totalSecs := 0

	for taskID, taskEntries := range allEntries {
		for _, e := range taskEntries {
			if !fromTime.IsZero() && e.StartedAt.Before(fromTime) {
				continue
			}
			if !toTime.IsZero() && e.StartedAt.After(toTime) {
				continue
			}

			re := reportEntry{
				TaskID:   taskID,
				Duration: e.Duration,
				Note:     e.Note,
				Date:     e.StartedAt.Format("2006-01-02"),
			}
			if t, ok := taskMap[taskID]; ok {
				re.TaskTitle = t.Title
			}
			entries = append(entries, re)
			totalSecs += e.Duration
		}
	}

	state, _ := store.Time.GetState()
	if state != nil {
		for _, at := range state.Active {
			startedAt, err := time.Parse("2006-01-02T15:04:05.000Z", at.StartedAt)
			if err != nil {
				continue
			}
			if !fromTime.IsZero() && startedAt.Before(fromTime) {
				continue
			}
			elapsed := int(time.Since(startedAt).Seconds()) - int(at.TotalPausedMs/1000)
			if elapsed < 0 {
				elapsed = 0
			}
			re := reportEntry{
				TaskID:   at.TaskID,
				Duration: elapsed,
				Note:     "(active timer)",
				Date:     startedAt.Format("2006-01-02"),
			}
			if t, ok := taskMap[at.TaskID]; ok {
				re.TaskTitle = t.Title
			}
			entries = append(entries, re)
			totalSecs += elapsed
		}
	}

	var reportData any

	if groupBy != "" {
		type group struct {
			Key      string `json:"key"`
			Duration int    `json:"duration"`
			Count    int    `json:"count"`
		}
		groupMap := make(map[string]*group)

		for _, e := range entries {
			var key string
			switch groupBy {
			case "task":
				key = e.TaskID
				if e.TaskTitle != "" {
					key = e.TaskTitle + " (" + e.TaskID + ")"
				}
			case "label":
				task := taskMap[e.TaskID]
				if task != nil && len(task.Labels) > 0 {
					for _, label := range task.Labels {
						if g, ok := groupMap[label]; ok {
							g.Duration += e.Duration
							g.Count++
						} else {
							groupMap[label] = &group{Key: label, Duration: e.Duration, Count: 1}
						}
					}
					continue
				}
				key = "(no label)"
			case "status":
				task := taskMap[e.TaskID]
				if task != nil {
					key = task.Status
				} else {
					key = "(unknown)"
				}
			}
			if g, ok := groupMap[key]; ok {
				g.Duration += e.Duration
				g.Count++
			} else {
				groupMap[key] = &group{Key: key, Duration: e.Duration, Count: 1}
			}
		}

		var groups []*group
		for _, g := range groupMap {
			groups = append(groups, g)
		}
		reportData = map[string]any{
			"groups":    groups,
			"total":     totalSecs,
			"formatted": formatDuration(totalSecs),
			"groupBy":   groupBy,
			"from":      fromStr,
			"to":        toStr,
		}
	} else {
		reportData = map[string]any{
			"entries":   entries,
			"total":     totalSecs,
			"formatted": formatDuration(totalSecs),
			"from":      fromStr,
			"to":        toStr,
		}
	}

	out, _ := json.MarshalIndent(reportData, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

// formatDuration formats a duration in seconds to a human-readable string.
func formatDuration(secs int) string {
	h := secs / 3600
	m := (secs % 3600) / 60
	s := secs % 60
	if h > 0 {
		if m > 0 || s > 0 {
			return fmt.Sprintf("%dh%02dm", h, m)
		}
		return fmt.Sprintf("%dh", h)
	}
	if m > 0 {
		if s > 0 {
			return fmt.Sprintf("%dm%02ds", m, s)
		}
		return fmt.Sprintf("%dm", m)
	}
	return fmt.Sprintf("%ds", s)
}
