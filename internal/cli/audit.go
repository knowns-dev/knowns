package cli

import (
	"fmt"
	"sort"
	"strings"

	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

var auditCmd = &cobra.Command{
	Use:   "audit",
	Short: "Inspect MCP tool call audit trail",
}

var auditRecentCmd = &cobra.Command{
	Use:   "recent",
	Short: "Show recent MCP tool calls",
	RunE:  runAuditRecent,
}

var auditStatsCmd = &cobra.Command{
	Use:   "stats",
	Short: "Show MCP tool call statistics",
	RunE:  runAuditStats,
}

func auditStore() *storage.AuditStore {
	return storage.NewGlobalAuditStore()
}

func auditFilter(cmd *cobra.Command) *storage.AuditFilter {
	f := &storage.AuditFilter{}
	f.ToolName, _ = cmd.Flags().GetString("tool")
	f.Result, _ = cmd.Flags().GetString("result")
	f.Project, _ = cmd.Flags().GetString("project")
	if f.ToolName == "" && f.Result == "" && f.Project == "" {
		return nil
	}
	return f
}

func runAuditRecent(cmd *cobra.Command, args []string) error {
	store := auditStore()
	limit, _ := cmd.Flags().GetInt("limit")
	filter := auditFilter(cmd)

	events, err := store.Recent(limit, filter)
	if err != nil {
		return fmt.Errorf("audit recent: %w", err)
	}

	if isJSON(cmd) {
		printJSON(events)
		return nil
	}

	if len(events) == 0 {
		if isPlain(cmd) {
			fmt.Println("No audit events found.")
		} else {
			fmt.Println(RenderInfo("No audit events found."))
		}
		return nil
	}

	if isPlain(cmd) {
		for _, e := range events {
			ts := e.Timestamp.Format("2006-01-02 15:04:05")
			tool := e.ToolName
			if e.Action != "" {
				tool += "." + e.Action
			}
			line := fmt.Sprintf("%s  %-22s  %-7s  %-7s  %dms",
				ts, tool, e.ActionClass, e.Result, e.DurationMs)
			if e.DryRun {
				line += "  [dry-run]"
			}
			if e.ErrorMessage != "" {
				line += "  err=" + e.ErrorMessage
			}
			if len(e.EntityRefs) > 0 {
				line += "  refs=" + strings.Join(e.EntityRefs, ",")
			}
			fmt.Println(line)
		}
		return nil
	}

	// Styled output.
	fmt.Println(RenderSectionHeader(fmt.Sprintf("Recent MCP Activity (%d events)", len(events))))
	fmt.Println(RenderSeparator(60))
	fmt.Println()

	for _, e := range events {
		ts := StyleDim.Render(e.Timestamp.Format("15:04:05"))
		tool := e.ToolName
		if e.Action != "" {
			tool += "." + e.Action
		}
		toolStyled := StyleInfo.Render(tool)

		var resultStyled string
		switch e.Result {
		case "success":
			resultStyled = StyleSuccess.Render("✓")
		case "error":
			resultStyled = StyleError.Render("✗")
		case "denied":
			resultStyled = StyleWarning.Render("⊘")
		default:
			resultStyled = e.Result
		}

		classStyled := StyleDim.Render("[" + e.ActionClass + "]")
		durStyled := StyleDim.Render(fmt.Sprintf("%dms", e.DurationMs))

		line := fmt.Sprintf("  %s  %s %s  %s  %s", ts, resultStyled, toolStyled, classStyled, durStyled)
		if e.DryRun {
			line += "  " + StyleWarning.Render("[dry-run]")
		}
		fmt.Println(line)

		if e.ErrorMessage != "" {
			fmt.Println("         " + StyleError.Render(e.ErrorMessage))
		}
		if len(e.EntityRefs) > 0 {
			fmt.Println("         " + StyleDim.Render(strings.Join(e.EntityRefs, ", ")))
		}
	}
	fmt.Println()
	return nil
}

func runAuditStats(cmd *cobra.Command, args []string) error {
	store := auditStore()
	filter := auditFilter(cmd)

	stats, err := store.Stats(filter)
	if err != nil {
		return fmt.Errorf("audit stats: %w", err)
	}

	if isJSON(cmd) {
		printJSON(stats)
		return nil
	}

	if stats.TotalCalls == 0 {
		if isPlain(cmd) {
			fmt.Println("No audit events found.")
		} else {
			fmt.Println(RenderInfo("No audit events found."))
		}
		return nil
	}

	if isPlain(cmd) {
		fmt.Printf("Total calls: %d\n", stats.TotalCalls)
		fmt.Printf("Executed: %d  Dry-run: %d\n\n", stats.ExecuteCount, stats.DryRunCount)

		fmt.Println("By result:")
		for result, count := range stats.ByResult {
			fmt.Printf("  %-10s %d\n", result, count)
		}

		fmt.Println("\nBy action class:")
		for class, count := range stats.ByActionClass {
			fmt.Printf("  %-10s %d\n", class, count)
		}

		fmt.Println("\nBy tool:")
		toolKeys := sortedKeys(stats.ByTool)
		for _, tool := range toolKeys {
			count := stats.ByTool[tool]
			results := stats.ByToolResult[tool]
			parts := []string{}
			for r, c := range results {
				parts = append(parts, fmt.Sprintf("%s:%d", r, c))
			}
			fmt.Printf("  %-25s %4d  (%s)\n", tool, count, strings.Join(parts, ", "))
		}
		return nil
	}

	// Styled output.
	fmt.Println(RenderSectionHeader("MCP Audit Statistics"))
	fmt.Println(RenderSeparator(50))
	fmt.Println()
	fmt.Println(RenderField("Total calls", fmt.Sprintf("%d", stats.TotalCalls)))
	fmt.Println(RenderField("Executed", fmt.Sprintf("%d", stats.ExecuteCount)))
	fmt.Println(RenderField("Dry-run", fmt.Sprintf("%d", stats.DryRunCount)))
	fmt.Println()

	// By result.
	fmt.Println(RenderSectionHeader("By Result"))
	for result, count := range stats.ByResult {
		var styled string
		switch result {
		case "success":
			styled = StyleSuccess.Render(result)
		case "error":
			styled = StyleError.Render(result)
		case "denied":
			styled = StyleWarning.Render(result)
		default:
			styled = result
		}
		fmt.Printf("  %-20s %d\n", styled, count)
	}
	fmt.Println()

	// By action class.
	fmt.Println(RenderSectionHeader("By Action Class"))
	for class, count := range stats.ByActionClass {
		fmt.Printf("  %-15s %d\n", class, count)
	}
	fmt.Println()

	// By tool.
	fmt.Println(RenderSectionHeader("By Tool"))
	toolKeys := sortedKeys(stats.ByTool)
	for _, tool := range toolKeys {
		count := stats.ByTool[tool]
		results := stats.ByToolResult[tool]
		parts := []string{}
		for r, c := range results {
			parts = append(parts, fmt.Sprintf("%s:%d", r, c))
		}
		fmt.Printf("  %-25s %s  %s\n",
			StyleInfo.Render(tool),
			StyleBold.Render(fmt.Sprintf("%4d", count)),
			StyleDim.Render("("+strings.Join(parts, ", ")+")"),
		)
	}
	fmt.Println()
	return nil
}

// sortedKeys returns the keys of a map sorted alphabetically.
func sortedKeys(m map[string]int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func init() {
	auditRecentCmd.Flags().Int("limit", 50, "Maximum number of events to show")
	auditRecentCmd.Flags().String("tool", "", "Filter by tool name")
	auditRecentCmd.Flags().String("result", "", "Filter by result (success, error, denied)")
	auditRecentCmd.Flags().String("project", "", "Filter by project root path")

	auditStatsCmd.Flags().String("tool", "", "Filter by tool name")
	auditStatsCmd.Flags().String("project", "", "Filter by project root path")

	auditCmd.AddCommand(auditRecentCmd)
	auditCmd.AddCommand(auditStatsCmd)

	rootCmd.AddCommand(auditCmd)
}
