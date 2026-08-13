package cli

import (
	"fmt"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/spf13/cobra"
)

var boardCmd = &cobra.Command{
	Use:   "board",
	Short: "Show the Kanban board",
	RunE:  runBoard,
}

func runBoard(cmd *cobra.Command, args []string) error {
	store := getStore()

	tasks, err := store.Tasks.List()
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}

	// Load config for status order
	cfg, _ := store.Config.Load()
	var statuses []string
	if cfg != nil && len(cfg.Settings.Statuses) > 0 {
		statuses = cfg.Settings.Statuses
	} else {
		statuses = models.DefaultStatuses()
	}

	// Group tasks by status
	columns := make(map[string][]*models.Task)
	for _, t := range tasks {
		columns[t.Status] = append(columns[t.Status], t)
	}

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)

	if jsonOut {
		type boardColumn struct {
			Status string         `json:"status"`
			Tasks  []*models.Task `json:"tasks"`
			Count  int            `json:"count"`
		}
		var cols []boardColumn
		for _, s := range statuses {
			cols = append(cols, boardColumn{
				Status: s,
				Tasks:  columns[s],
				Count:  len(columns[s]),
			})
		}
		printJSON(cols)
		return nil
	}

	if plain {
		var pb strings.Builder
		for _, status := range statuses {
			col := columns[status]
			fmt.Fprintf(&pb, "COLUMN: %s (%d tasks)\n", strings.ToUpper(status), len(col))
			for _, t := range col {
				fmt.Fprintf(&pb, "  TASK: %s\n", t.ID)
				fmt.Fprintf(&pb, "    TITLE: %s\n", t.Title)
				if t.Assignee != "" {
					fmt.Fprintf(&pb, "    ASSIGNEE: %s\n", t.Assignee)
				}
				if t.Priority != "" {
					fmt.Fprintf(&pb, "    PRIORITY: %s\n", t.Priority)
				}
				acTotal := len(t.AcceptanceCriteria)
				acDone := 0
				for _, ac := range t.AcceptanceCriteria {
					if ac.Completed {
						acDone++
					}
				}
				if acTotal > 0 {
					fmt.Fprintf(&pb, "    AC: %d/%d\n", acDone, acTotal)
				}
			}
			fmt.Fprintln(&pb)
		}
		printPaged(cmd, pb.String())
	} else {
		content := renderBoard(tasks, statuses, columns)
		return renderOrPage(cmd, "Board", content)
	}

	return nil
}

func renderBoard(tasks []*models.Task, statuses []string, columns map[string][]*models.Task) string {
	var b strings.Builder
	colWidth := 30

	// Header row
	for _, status := range statuses {
		label := formatBoardHeader(status, len(columns[status]))
		styled := StatusStyle(status).Bold(true).Render(fmt.Sprintf("%-*s", colWidth, label))
		fmt.Fprintf(&b, "%s  ", styled)
	}
	fmt.Fprintln(&b)

	// Separator
	for range statuses {
		fmt.Fprintf(&b, "%s  ", RenderSeparator(colWidth))
	}
	fmt.Fprintln(&b)

	// Find max rows
	maxRows := 0
	for _, s := range statuses {
		if len(columns[s]) > maxRows {
			maxRows = len(columns[s])
		}
	}

	// Rows
	for row := 0; row < maxRows; row++ {
		for _, status := range statuses {
			col := columns[status]
			if row < len(col) {
				cell := formatBoardCard(col[row], colWidth)
				fmt.Fprintf(&b, "%-*s  ", colWidth, cell)
			} else {
				fmt.Fprintf(&b, "%-*s  ", colWidth, "")
			}
		}
		fmt.Fprintln(&b)
	}
	fmt.Fprintln(&b)

	// Summary
	total := len(tasks)
	fmt.Fprintln(&b, StyleDim.Render(fmt.Sprintf("Total: %d tasks across %d columns", total, len(statuses))))
	return b.String()
}

func formatBoardHeader(status string, count int) string {
	return fmt.Sprintf("%s (%d)", strings.ToUpper(status), count)
}

func formatBoardCard(t *models.Task, width int) string {
	title := t.Title
	maxTitle := width - len(t.ID) - 3
	if maxTitle < 10 {
		maxTitle = 10
	}
	if len(title) > maxTitle {
		title = title[:maxTitle-3] + "..."
	}
	return StyleID.Render("["+t.ID+"]") + " " + title
}

func init() {
	rootCmd.AddCommand(boardCmd)
}
