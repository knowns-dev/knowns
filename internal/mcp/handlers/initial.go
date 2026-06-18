package handlers

import (
	"context"
	"fmt"
	"github.com/mark3labs/mcp-go/server"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/readiness"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

func RegisterInitialTool(s *server.MCPServer, getStore func() *storage.Store, getLSPManager ...func() *lsp.Manager) {
	s.AddTool(
		mcp.NewTool("initial",
			mcp.WithDescription(`Provides the Knowns session-ready instructions for AI agents.

- initial: Return dynamic project state, required code-intelligence rules, workflow guidance, and tool summary. Required: none. Optional: none. Returns: plain-text instructions to read before performing project work.
`),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var manager *lsp.Manager
			if len(getLSPManager) > 0 && getLSPManager[0] != nil {
				manager = getLSPManager[0]()
			}
			return mcp.NewToolResultText(buildInitialInstructions(getStore, manager)), nil
		},
	)
}

func buildInitialInstructions(getStore func() *storage.Store, manager *lsp.Manager) string {
	var b strings.Builder
	store := getStore()

	b.WriteString("# Knowns MCP — Session Ready\n\n")
	writeProjectState(&b, store, manager)
	b.WriteString("\n")
	writeCodeIntelligenceRules(&b)
	b.WriteString("\n")
	writeWorkflow(&b)
	b.WriteString("\n")
	writeKnowledgeLifecycle(&b)
	b.WriteString("\n")
	writeToolsSummary(&b)

	return b.String()
}

func writeProjectState(b *strings.Builder, store *storage.Store, manager *lsp.Manager) {
	b.WriteString("## Project State\n")
	if store == nil {
		b.WriteString("Project: not connected\n")
		return
	}

	payload := readiness.BuildReadiness(store, readiness.Options{})
	inProgress := countInProgressTasks(store)
	fmt.Fprintf(b, "Project: %s\n", payload.ProjectName)
	if payload.Knowledge != nil {
		k := payload.Knowledge
		fmt.Fprintf(b, "Knowledge: docs: %d | tasks: %d (%d in-progress) | templates: %d | memories: %dp, %dg\n",
			k.Docs, k.Tasks, inProgress, k.Templates, k.Memories.Project, k.Memories.Global)
	}

	if timerLine := activeTimerLine(store); timerLine != "" {
		b.WriteString(timerLine)
		b.WriteString("\n")
	}
	if lspLine := lspWarningsLine(manager); lspLine != "" {
		b.WriteString(lspLine)
		b.WriteString("\n")
	}

	symbols, relations := codeIndexCounts(store)
	fmt.Fprintf(b, "Code index: symbols: %d | relations: %d\n", symbols, relations)
}

func countInProgressTasks(store *storage.Store) int {
	tasks, err := store.Tasks.List()
	if err != nil {
		return 0
	}
	count := 0
	for _, task := range tasks {
		if task.Status == "in-progress" {
			count++
		}
	}
	return count
}

func activeTimerLine(store *storage.Store) string {
	state, err := store.Time.GetState()
	if err != nil || len(state.Active) == 0 {
		return ""
	}
	timer := state.Active[0]
	startedAt, err := time.Parse(time.RFC3339Nano, timer.StartedAt)
	if err != nil {
		return fmt.Sprintf("⏱ Active timer: %s \"%s\"", timer.TaskID, timer.TaskTitle)
	}
	elapsed := time.Since(startedAt) - time.Duration(timer.TotalPausedMs)*time.Millisecond
	if timer.PausedAt != nil {
		if pausedAt, err := time.Parse(time.RFC3339Nano, *timer.PausedAt); err == nil {
			elapsed = pausedAt.Sub(startedAt) - time.Duration(timer.TotalPausedMs)*time.Millisecond
		}
	}
	if elapsed < 0 {
		elapsed = 0
	}
	return fmt.Sprintf("⏱ Active timer: %s \"%s\" (%s)", timer.TaskID, timer.TaskTitle, formatInitialDuration(elapsed))
}

func formatInitialDuration(d time.Duration) string {
	d = d.Round(time.Minute)
	if d < time.Minute {
		return "0m"
	}
	hours := int(d.Hours())
	minutes := int(d.Minutes()) % 60
	if hours > 0 {
		return fmt.Sprintf("%dh%dm", hours, minutes)
	}
	return fmt.Sprintf("%dm", minutes)
}

func lspWarningsLine(manager *lsp.Manager) string {
	if manager == nil {
		return ""
	}
	statuses := manager.RuntimeStatuses(context.Background())
	parts := make([]string, 0, len(statuses))
	for _, status := range statuses {
		if status.ID == lsp.CSharpLanguageID {
			parts = append(parts, formatInitialLSPStatus(status))
			continue
		}
		if !status.Detected && status.Status != lsp.RuntimeRunningCrashed {
			continue
		}
		if status.InstallState != lsp.RuntimeInstallInstalled || status.Status == lsp.RuntimeRunningCrashed {
			parts = append(parts, formatInitialLSPStatus(status))
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "LSP runtime: " + strings.Join(parts, "; ")
}

func formatInitialLSPStatus(status lsp.LanguageRuntimeStatus) string {
	parts := []string{status.ID}
	if status.Backend != "" {
		parts = append(parts, "backend="+status.Backend)
	}
	if status.Source != "" {
		parts = append(parts, "source="+status.Source)
	}
	if status.InstallState != "" {
		parts = append(parts, "install="+status.InstallState)
	}
	if status.ReadinessState != "" && status.ReadinessState != lsp.RuntimeReadinessNotApplicable {
		parts = append(parts, "readiness="+status.ReadinessState)
	}
	if status.InstallState != lsp.RuntimeInstallInstalled && status.InstallCmd != "" {
		parts = append(parts, "run="+status.InstallCmd)
	}
	if status.LogPath != "" {
		parts = append(parts, "log="+status.LogPath)
	}
	return strings.Join(parts, " ")
}

func codeIndexCounts(store *storage.Store) (symbols int, relations int) {
	if !store.CodeRefIndexExists() {
		return 0, 0
	}
	db := store.SemanticDB()
	if db == nil {
		return 0, 0
	}
	defer db.Close()
	_ = db.QueryRow("SELECT COUNT(*) FROM code_symbols").Scan(&symbols)
	_ = db.QueryRow("SELECT COUNT(*) FROM code_edges").Scan(&relations)
	return symbols, relations
}

func writeCodeIntelligenceRules(b *strings.Builder) {
	b.WriteString(`## Code Intelligence Rules
**CRITICAL**: Use Knowns code actions for code discovery, navigation, and structural edits. This is the operating path for code work.

Discovery and navigation:
- code.find: search symbols before opening files
- code.symbols: inspect file structure
- code.definition / code.references / code.implementations: navigate with LSP precision
- code.diagnostics: inspect current language-server errors

Editing actions:
- code.rename: rename symbols with LSP workspace edits
- code.replace: replace exact text after code tools locate the target
- code.replace_body: replace an entire symbol body by name
- code.insert / code.delete: structural insert/delete by symbol anchor

**FORBIDDEN**: Do not use built-in read/grep/edit as the first step for code. Use them only for shell/tests or after code tools identify the target and surrounding context is needed.

If an action schema is not visible, call help("code.*") or help("workflow.code-edit") before editing.
`)
}

func writeWorkflow(b *strings.Builder) {
	b.WriteString(`## Workflow
Bootstrap:     initial → help("workflow.*") or help("<domain>.*") as needed
Discovery:     search(query) → docs/tasks(get) for details
Docs:          docs.get(smart:true) → docs.get(toc:true) → docs.get(section:"...") for large docs
Code context:  code.find → code.symbols → code.references/definition
Code edits:    code.rename/replace/replace_body/insert/delete → diagnostics/tests
Task flow:     tasks(get/create) → follow refs → plan → implement → validate → done
Time:          time(start) when taking task, time(stop) when done
Progress:      tasks(update, appendNotes:"...") — not notes (replaces)

Use help on demand instead of assuming the visible MCP tool schema is complete.
`)
}

func writeKnowledgeLifecycle(b *strings.Builder) {
	b.WriteString(`## Knowledge Lifecycle
Memory and Decision writes use semantic review before becoming trusted.

- Agent/MCP Memory writes default to proposed unless explicitly resolved; default retrieval only uses active Memories.
- Decision writes are review-gated; accepted/current Decisions use supersession links instead of overwrite/delete.
- Default retrieval/search returns active Memories and accepted non-superseded Decisions.
- Use review/resolution commands or the WebUI inbox before treating new or conflicting knowledge as trusted.
`)
}

func writeToolsSummary(b *strings.Builder) {
	b.WriteString("## Tools (discover with help)\n")
	b.WriteString("code | tasks | docs | search | time | templates | validate | memory | project | help\n")
	b.WriteString("Recipes: help(\"workflow.code-edit\"), help(\"workflow.doc-read\"), help(\"workflow.plan-new\"), help(\"workflow.spec\"), help(\"workflow.verify\")")
}
