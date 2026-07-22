package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"charm.land/bubbles/v2/progress"
	tea "charm.land/bubbletea/v2"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

var searchCmd = &cobra.Command{
	Use:   "search <query>",
	Short: "Search tasks and documentation",
	Args:  cobra.ArbitraryArgs,
	RunE:  runSearch,
}

var retrieveCmd = &cobra.Command{
	Use:   "retrieve <query>",
	Short: "Retrieve ranked context for docs, tasks, and memories",
	Args:  cobra.ArbitraryArgs,
	RunE:  runRetrieve,
}

func runSearch(cmd *cobra.Command, args []string) error {
	reindex, _ := cmd.Flags().GetBool("reindex")
	setup, _ := cmd.Flags().GetBool("setup")
	statusCheck, _ := cmd.Flags().GetBool("status-check")

	if statusCheck {
		return runStatusCheck()
	}

	if setup {
		return runSetup()
	}

	if reindex {
		return runReindex()
	}

	if len(args) == 0 {
		return fmt.Errorf("search query required (use --help for usage)")
	}

	query := strings.Join(args, " ")
	store := getStore()

	typeFilter, _ := cmd.Flags().GetString("type")
	statusFilter, _ := cmd.Flags().GetString("status")
	priorityFilter, _ := cmd.Flags().GetString("priority")
	labelFilter, _ := cmd.Flags().GetString("label")
	tagFilter, _ := cmd.Flags().GetString("tag")
	assigneeFilter, _ := cmd.Flags().GetString("assignee")
	keywordOnly, _ := cmd.Flags().GetBool("keyword")
	includeHistorical, _ := cmd.Flags().GetBool("include-historical")
	limit, _ := cmd.Flags().GetInt("limit")
	if limit <= 0 {
		limit = 20
	}

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)

	// Determine search mode.
	mode := "hybrid"
	if keywordOnly {
		mode = "keyword"
	}

	opts := search.SearchOptions{
		Query:             query,
		Type:              typeFilter,
		Mode:              mode,
		Status:            statusFilter,
		Priority:          priorityFilter,
		Assignee:          assigneeFilter,
		Label:             labelFilter,
		Tag:               tagFilter,
		Limit:             limit,
		IncludeHistorical: includeHistorical,
	}

	response, err := search.SearchWithRuntime(store, opts)
	if err != nil {
		return err
	}
	results := response.Results

	if jsonOut {
		printJSON(results)
		return nil
	}
	if response.Runtime != nil && response.Runtime.Degraded {
		fmt.Println(searchWarnStyle.Render(response.Runtime.Message))
	}

	if len(results) == 0 {
		if plain {
			fmt.Println("No results found.")
		} else {
			fmt.Println(RenderWarning(fmt.Sprintf("No results for %q", query)))
		}
		return nil
	}

	// Detect actual mode used.
	actualMode := mode
	if response.Runtime != nil && response.Runtime.Degraded {
		actualMode = string(search.ModeKeyword)
	}

	// Normalize scores for percentage display.
	maxScore := 0.0
	for _, r := range results {
		if r.Score > maxScore {
			maxScore = r.Score
		}
	}

	var taskResults, docResults, memoryResults, decisionResults []models.SearchResult
	filteredResults := make([]models.SearchResult, 0, len(results))
	for _, r := range results {
		switch r.Type {
		case "task":
			taskResults = append(taskResults, r)
			filteredResults = append(filteredResults, r)
		case "doc":
			docResults = append(docResults, r)
			filteredResults = append(filteredResults, r)
		case "memory":
			memoryResults = append(memoryResults, r)
			filteredResults = append(filteredResults, r)
		case "decision":
			decisionResults = append(decisionResults, r)
			filteredResults = append(filteredResults, r)
		}
	}

	if plain {
		content := sprintPlainResults(taskResults, docResults, memoryResults, decisionResults, maxScore)
		printPaged(cmd, content)
	} else {
		content := renderPrettyResults(query, actualMode, filteredResults, taskResults, docResults, memoryResults, decisionResults, maxScore)
		renderOrPage(cmd, fmt.Sprintf("Search: %s", query), content)
	}
	return nil
}

func runRetrieve(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("retrieve query required (use --help for usage)")
	}

	query := strings.Join(args, " ")
	store := getStore()

	statusFilter, _ := cmd.Flags().GetString("status")
	priorityFilter, _ := cmd.Flags().GetString("priority")
	labelFilter, _ := cmd.Flags().GetString("label")
	tagFilter, _ := cmd.Flags().GetString("tag")
	assigneeFilter, _ := cmd.Flags().GetString("assignee")
	keywordOnly, _ := cmd.Flags().GetBool("keyword")
	includeHistorical, _ := cmd.Flags().GetBool("include-historical")
	expandReferences, _ := cmd.Flags().GetBool("expand-references")
	sourceTypes := splitCSV(getFlagString(cmd, "source-types"))
	limit, _ := cmd.Flags().GetInt("limit")
	if limit <= 0 {
		limit = 20
	}

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)

	mode := "hybrid"
	if keywordOnly {
		mode = "keyword"
	}

	resp, runtimeMeta, err := search.RetrieveWithRuntime(store, models.RetrievalOptions{
		Query:             query,
		Mode:              mode,
		Limit:             limit,
		SourceTypes:       sourceTypes,
		ExpandReferences:  expandReferences,
		Status:            statusFilter,
		Priority:          priorityFilter,
		Assignee:          assigneeFilter,
		Label:             labelFilter,
		Tag:               tagFilter,
		IncludeHistorical: includeHistorical,
	})
	if err != nil {
		return err
	}

	if jsonOut {
		if runtimeMeta != nil {
			printJSON(struct {
				*models.RetrievalResponse
				Runtime *search.RuntimeMetadata `json:"_runtime,omitempty"`
			}{
				RetrievalResponse: resp,
				Runtime:           runtimeMeta,
			})
			return nil
		}
		printJSON(resp)
		return nil
	}
	if runtimeMeta != nil && runtimeMeta.Degraded {
		fmt.Println(searchWarnStyle.Render(runtimeMeta.Message))
	}

	if len(resp.Candidates) == 0 {
		if plain {
			fmt.Println("No retrieval results found.")
		} else {
			fmt.Println(RenderWarning(fmt.Sprintf("No retrieval results for %q", query)))
		}
		return nil
	}

	if plain {
		printPaged(cmd, sprintPlainRetrieval(resp))
	} else {
		renderOrPage(cmd, fmt.Sprintf("Retrieve: %s", query), renderPrettyRetrieval(resp))
	}
	return nil
}

func sprintPlainResults(taskResults, docResults, memoryResults, decisionResults []models.SearchResult, maxScore float64) string {
	var b strings.Builder
	if len(taskResults) > 0 {
		fmt.Fprintln(&b, "Tasks:")
		for _, r := range taskResults {
			pct := scoreToPercent(r.Score, maxScore)
			fmt.Fprintf(&b, "  #%s [%s] [%s] (%d%%)\n", r.ID, r.Status, r.Priority, pct)
			if r.Snippet != "" {
				snip := truncate(r.Snippet, 100)
				fmt.Fprintf(&b, "    %s\n", snip)
			}
			fmt.Fprintf(&b, "    Matched by: %s\n", formatMatchedBy(r.MatchedBy))
		}
		fmt.Fprintln(&b)
	}
	if len(docResults) > 0 {
		fmt.Fprintln(&b, "Docs:")
		for _, r := range docResults {
			pct := scoreToPercent(r.Score, maxScore)
			fmt.Fprintf(&b, "  %s (%d%%)\n", r.Path, pct)
			if r.Snippet != "" {
				snip := truncate(r.Snippet, 100)
				fmt.Fprintf(&b, "    %s\n", snip)
			}
			fmt.Fprintf(&b, "    Matched by: %s\n", formatMatchedBy(r.MatchedBy))
		}
		fmt.Fprintln(&b)
	}
	if len(memoryResults) > 0 {
		fmt.Fprintln(&b, "Memories:")
		for _, r := range memoryResults {
			pct := scoreToPercent(r.Score, maxScore)
			fmt.Fprintf(&b, "  %s (%d%%)\n", r.ID, pct)
			if r.Snippet != "" {
				snip := truncate(r.Snippet, 100)
				fmt.Fprintf(&b, "    %s\n", snip)
			}
			fmt.Fprintf(&b, "    Scope: %s\n", formatMemoryScope(r.MemoryLayer, r.MemoryStore))
			fmt.Fprintf(&b, "    Matched by: %s\n", formatMatchedBy(r.MatchedBy))
		}
		fmt.Fprintln(&b)
	}
	if len(decisionResults) > 0 {
		fmt.Fprintln(&b, "Decisions:")
		for _, r := range decisionResults {
			pct := scoreToPercent(r.Score, maxScore)
			fmt.Fprintf(&b, "  %s [%s] (%d%%)\n", r.ID, r.Status, pct)
			if r.Snippet != "" {
				snip := truncate(r.Snippet, 100)
				fmt.Fprintf(&b, "    %s\n", snip)
			}
			fmt.Fprintf(&b, "    Matched by: %s\n", formatMatchedBy(r.MatchedBy))
		}
		fmt.Fprintln(&b)
	}
	return b.String()
}

func renderPrettyResults(query, mode string, results []models.SearchResult, taskResults, docResults, memoryResults, decisionResults []models.SearchResult, maxScore float64) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s %s\n\n",
		StyleBold.Render(fmt.Sprintf("Found %d result(s)", len(results))),
		StyleDim.Render("for"),
		StyleInfo.Render(fmt.Sprintf("%q", query))+" "+StyleDim.Render(fmt.Sprintf("(%s mode)", mode)))

	if len(taskResults) > 0 {
		fmt.Fprintln(&b, RenderSectionHeader("Tasks"))
		fmt.Fprintln(&b)
		for _, r := range taskResults {
			pct := scoreToPercent(r.Score, maxScore)
			fmt.Fprintf(&b, "  %s %s %s  %s %s %s\n",
				RenderBadge("TASK", colorBlue),
				StyleID.Render("#"+r.ID),
				StyleBold.Render("— "+r.Title),
				RenderStatusBadge(r.Status),
				RenderPriorityBadge(r.Priority),
				StyleDim.Render(fmt.Sprintf("(%d%%)", pct)))
			if r.Snippet != "" {
				snip := truncate(r.Snippet, 100)
				fmt.Fprintf(&b, "    %s\n", StyleDim.Render(snip))
			}
			fmt.Fprintf(&b, "    %s\n", StyleDim.Render("Matched by: "+formatMatchedBy(r.MatchedBy)))
			fmt.Fprintln(&b)
		}
	}

	if len(docResults) > 0 {
		fmt.Fprintln(&b, RenderSectionHeader("Docs"))
		fmt.Fprintln(&b)
		for _, r := range docResults {
			pct := scoreToPercent(r.Score, maxScore)
			tags := ""
			if len(r.Tags) > 0 {
				tags = " " + RenderTags(r.Tags)
			}
			fmt.Fprintf(&b, "  %s %s %s%s %s\n",
				RenderBadge("DOC", colorMagenta),
				StyleID.Render(r.Path),
				StyleBold.Render("— "+r.Title),
				tags,
				StyleDim.Render(fmt.Sprintf("(%d%%)", pct)))
			if r.Snippet != "" {
				snip := truncate(r.Snippet, 100)
				fmt.Fprintf(&b, "    %s\n", StyleDim.Render(snip))
			}
			fmt.Fprintf(&b, "    %s\n", StyleDim.Render("Matched by: "+formatMatchedBy(r.MatchedBy)))
			fmt.Fprintln(&b)
		}
	}

	if len(memoryResults) > 0 {
		fmt.Fprintln(&b, RenderSectionHeader("Memories"))
		fmt.Fprintln(&b)
		for _, r := range memoryResults {
			pct := scoreToPercent(r.Score, maxScore)
			fmt.Fprintf(&b, "  %s %s %s %s\n",
				RenderBadge("MEMORY", colorPurple),
				StyleID.Render(r.ID),
				StyleBold.Render("— "+r.Title),
				StyleDim.Render(fmt.Sprintf("(%d%%)", pct)))
			if r.Snippet != "" {
				snip := truncate(r.Snippet, 100)
				fmt.Fprintf(&b, "    %s\n", StyleDim.Render(snip))
			}
			fmt.Fprintf(&b, "    %s\n", StyleDim.Render("Scope: "+formatMemoryScope(r.MemoryLayer, r.MemoryStore)))
			fmt.Fprintf(&b, "    %s\n", StyleDim.Render("Matched by: "+formatMatchedBy(r.MatchedBy)))
			fmt.Fprintln(&b)
		}
	}
	if len(decisionResults) > 0 {
		fmt.Fprintln(&b, RenderSectionHeader("Decisions"))
		fmt.Fprintln(&b)
		for _, r := range decisionResults {
			pct := scoreToPercent(r.Score, maxScore)
			fmt.Fprintf(&b, "  %s %s %s %s %s\n",
				RenderBadge("DECISION", colorCyan),
				StyleID.Render(r.ID),
				StyleBold.Render("— "+r.Title),
				RenderStatusBadge(r.Status),
				StyleDim.Render(fmt.Sprintf("(%d%%)", pct)))
			if r.Snippet != "" {
				snip := truncate(r.Snippet, 100)
				fmt.Fprintf(&b, "    %s\n", StyleDim.Render(snip))
			}
			fmt.Fprintf(&b, "    %s\n", StyleDim.Render("Matched by: "+formatMatchedBy(r.MatchedBy)))
			fmt.Fprintln(&b)
		}
	}
	return b.String()
}

func sprintPlainRetrieval(resp *models.RetrievalResponse) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Query: %s\n", resp.Query)
	fmt.Fprintf(&b, "Mode: %s\n", resp.Mode)
	fmt.Fprintf(&b, "Candidates: %d\n", len(resp.Candidates))
	fmt.Fprintf(&b, "Context items: %d\n\n", len(resp.ContextPack.Items))

	fmt.Fprintln(&b, "Candidates:")
	for _, candidate := range resp.Candidates {
		fmt.Fprintf(&b, "  [%s] %s (%s)\n", strings.ToUpper(candidate.Type), candidate.Title, candidate.ID)
		fmt.Fprintf(&b, "    Score: %.3f\n", candidate.Score)
		fmt.Fprintf(&b, "    Direct: %t\n", candidate.DirectMatch)
		if len(candidate.ExpandedFrom) > 0 {
			fmt.Fprintf(&b, "    Expanded from: %s\n", strings.Join(candidate.ExpandedFrom, ", "))
		}
		fmt.Fprintf(&b, "    Citation: %s\n", formatRetrievalCitation(candidate.Citation))
		if candidate.Type == "memory" {
			fmt.Fprintf(&b, "    Scope: %s\n", formatMemoryScope(candidate.MemoryLayer, candidate.MemoryStore))
		}
		if candidate.Type == "decision" && candidate.Status != "" {
			fmt.Fprintf(&b, "    Status: %s\n", candidate.Status)
		}
		if candidate.Snippet != "" {
			fmt.Fprintf(&b, "    %s\n", truncate(candidate.Snippet, 120))
		}
	}

	fmt.Fprintln(&b)
	fmt.Fprintln(&b, "Context Pack:")
	for _, item := range resp.ContextPack.Items {
		fmt.Fprintf(&b, "  [%s] %s (%s)\n", strings.ToUpper(item.Type), item.Title, item.ID)
		fmt.Fprintf(&b, "    Citation: %s\n", formatRetrievalCitation(item.Citation))
		fmt.Fprintf(&b, "    Direct: %t\n", item.DirectMatch)
		if len(item.ExpandedFrom) > 0 {
			fmt.Fprintf(&b, "    Expanded from: %s\n", strings.Join(item.ExpandedFrom, ", "))
		}
		if item.Content != "" {
			fmt.Fprintf(&b, "    %s\n", truncate(item.Content, 160))
		}
	}

	return b.String()
}

func renderPrettyRetrieval(resp *models.RetrievalResponse) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s %s\n\n",
		StyleBold.Render(fmt.Sprintf("Retrieved %d candidate(s)", len(resp.Candidates))),
		StyleDim.Render("for"),
		StyleInfo.Render(fmt.Sprintf("%q", resp.Query))+" "+StyleDim.Render(fmt.Sprintf("(%s mode)", resp.Mode)))

	fmt.Fprintln(&b, RenderSectionHeader("Candidates"))
	fmt.Fprintln(&b)
	for _, candidate := range resp.Candidates {
		badgeColor := colorBlue
		switch candidate.Type {
		case "doc":
			badgeColor = colorMagenta
		case "memory":
			badgeColor = colorPurple
		case "decision":
			badgeColor = colorCyan
		}
		fmt.Fprintf(&b, "  %s %s %s %s\n",
			RenderBadge(strings.ToUpper(candidate.Type), badgeColor),
			StyleID.Render(candidate.ID),
			StyleBold.Render("— "+candidate.Title),
			StyleDim.Render(fmt.Sprintf("(%.3f)", candidate.Score)))
		fmt.Fprintf(&b, "    %s\n", StyleDim.Render("Citation: "+formatRetrievalCitation(candidate.Citation)))
		if candidate.Type == "memory" {
			fmt.Fprintf(&b, "    %s\n", StyleDim.Render("Scope: "+formatMemoryScope(candidate.MemoryLayer, candidate.MemoryStore)))
		}
		if candidate.Type == "decision" && candidate.Status != "" {
			fmt.Fprintf(&b, "    %s\n", StyleDim.Render("Status: "+candidate.Status))
		}
		fmt.Fprintf(&b, "    %s\n", StyleDim.Render(fmt.Sprintf("Direct match: %t", candidate.DirectMatch)))
		if len(candidate.ExpandedFrom) > 0 {
			fmt.Fprintf(&b, "    %s\n", StyleDim.Render("Expanded from: "+strings.Join(candidate.ExpandedFrom, ", ")))
		}
		if candidate.Snippet != "" {
			fmt.Fprintf(&b, "    %s\n", StyleDim.Render(truncate(candidate.Snippet, 120)))
		}
		fmt.Fprintln(&b)
	}

	fmt.Fprintln(&b, RenderSectionHeader("Context Pack"))
	fmt.Fprintln(&b)
	for _, item := range resp.ContextPack.Items {
		badgeColor := colorBlue
		switch item.Type {
		case "doc":
			badgeColor = colorMagenta
		case "memory":
			badgeColor = colorPurple
		case "decision":
			badgeColor = colorCyan
		}
		fmt.Fprintf(&b, "  %s %s %s\n",
			RenderBadge(strings.ToUpper(item.Type), badgeColor),
			StyleID.Render(item.ID),
			StyleBold.Render("— "+item.Title))
		fmt.Fprintf(&b, "    %s\n", StyleDim.Render("Citation: "+formatRetrievalCitation(item.Citation)))
		fmt.Fprintf(&b, "    %s\n", StyleDim.Render(fmt.Sprintf("Direct match: %t", item.DirectMatch)))
		if len(item.ExpandedFrom) > 0 {
			fmt.Fprintf(&b, "    %s\n", StyleDim.Render("Expanded from: "+strings.Join(item.ExpandedFrom, ", ")))
		}
		if item.Content != "" {
			fmt.Fprintf(&b, "    %s\n", StyleDim.Render(truncate(item.Content, 160)))
		}
		fmt.Fprintln(&b)
	}

	return b.String()
}

func formatRetrievalCitation(citation models.Citation) string {
	if citation.Path != "" {
		return citation.Type + ":" + citation.Path
	}
	return citation.Type + ":" + citation.ID
}

func getFlagString(cmd *cobra.Command, name string) string {
	v, _ := cmd.Flags().GetString(name)
	return v
}

func formatMatchedBy(methods []string) string {
	if len(methods) == 0 {
		return "keyword"
	}
	return strings.Join(methods, " + ")
}

func formatMemoryScope(layer, store string) string {
	parts := make([]string, 0, 2)
	if layer != "" {
		parts = append(parts, layer)
	}
	if store != "" {
		parts = append(parts, store)
	}
	if len(parts) == 0 {
		return "unknown"
	}
	return strings.Join(parts, " / ")
}

// ─── status check ────────────────────────────────────────────────────

func runStatusCheck() error {
	store := getStore()
	cfg, _ := store.Config.Load()

	onnxAvail, onnxPath := search.IsONNXAvailable()

	fmt.Println()
	fmt.Println(StyleBold.Render("Semantic Search Status"))
	fmt.Println(RenderSeparator(40))

	// ONNX runtime.
	if onnxAvail {
		fmt.Println(searchSuccessStyle.Render("  ONNX runtime: installed"))
		fmt.Println(searchDimStyle.Render(fmt.Sprintf("    Path: %s", onnxPath)))
	} else {
		fmt.Println(searchWarnStyle.Render("  ONNX runtime: not found"))
		fmt.Println(searchDimStyle.Render("    Reinstall knowns to restore the ONNX runtime library"))
	}

	// Model.
	if cfg != nil && cfg.Settings.SemanticSearch != nil {
		ss := cfg.Settings.SemanticSearch
		fmt.Println(RenderField("Model", ss.Model))
		fmt.Println(RenderField("Enabled", fmt.Sprintf("%v", ss.Enabled)))
		fmt.Println(RenderField("Dimensions", fmt.Sprintf("%d", ss.Dimensions)))
		fmt.Println(RenderField("Max Tokens", fmt.Sprintf("%d", ss.MaxTokens)))
	} else {
		fmt.Println(RenderField("Model", StyleDim.Render("not configured")))
		fmt.Println(searchDimStyle.Render("    Set up: knowns search --setup"))
	}

	// Vector index.
	searchDir := filepath.Join(store.Root, ".search")
	vs := search.NewSQLiteVectorStore(searchDir, "", 0)
	count, model, indexedAt := vs.Stats()
	if count > 0 {
		fmt.Println(RenderField("Index", fmt.Sprintf("%d chunks (model: %s)", count, model)))
		fmt.Println(RenderField("Indexed at", indexedAt.Format(time.RFC3339)))
	} else {
		fmt.Println(RenderField("Index", StyleDim.Render("empty")))
		fmt.Println(searchDimStyle.Render("    Build: knowns search --reindex"))
	}

	// Overall status.
	fmt.Println()
	if onnxAvail && cfg != nil && cfg.Settings.SemanticSearch != nil && cfg.Settings.SemanticSearch.Enabled && count > 0 {
		fmt.Println(searchSuccessStyle.Render("  Status: ready (hybrid search active)"))
	} else if onnxAvail && cfg != nil && cfg.Settings.SemanticSearch != nil && cfg.Settings.SemanticSearch.Enabled {
		fmt.Println(searchWarnStyle.Render("  Status: needs search reindex (run: knowns search --reindex)"))
	} else {
		fmt.Println(searchDimStyle.Render("  Status: keyword-only mode"))
	}
	fmt.Println()

	return nil
}

// ─── setup ───────────────────────────────────────────────────────────

func runSetup() error {
	store := getStore()
	cfg, err := store.Config.Load()
	if err != nil {
		return err
	}

	// Check ONNX runtime.
	onnxAvail, _ := search.IsONNXAvailable()
	if !onnxAvail {
		fmt.Println(searchWarnStyle.Render("ONNX runtime not found."))
		fmt.Println()
		fmt.Println(RenderHint("Reinstall knowns to restore the ONNX runtime library."))
		fmt.Println()
		return nil
	}

	// Check if a model is set.
	if cfg.Settings.SemanticSearch == nil || cfg.Settings.SemanticSearch.Model == "" {
		fmt.Println(searchWarnStyle.Render("No embedding model configured."))
		fmt.Println()
		fmt.Println(RenderHint("Set a model first:"))
		fmt.Println(RenderHint("  " + RenderCmd("knowns model set gte-small")))
		fmt.Println()
		return nil
	}

	ss := cfg.Settings.SemanticSearch
	if !ss.Enabled {
		ss.Enabled = true
		_ = store.Config.Set("settings.semanticSearch.enabled", true)
		fmt.Println(searchSuccessStyle.Render("Semantic search enabled."))
	} else {
		fmt.Println(StyleDim.Render("Semantic search is already enabled."))
	}

	fmt.Println()
	fmt.Println(RenderNextSteps(
		RenderCmd("knowns search --reindex"),
		RenderCmd("knowns search \"your query\""),
	))

	return nil
}

// ─── reindex with bubbletea progress ─────────────────────────────────

var (
	searchSuccessStyle = StyleSuccess
	searchWarnStyle    = StyleWarning
	searchDimStyle     = StyleDim
)

// reindexTickMsg polls shared state from the background goroutine.
type reindexTickMsg struct{}

// reindexDoneMsg signals the reindex finished.
type reindexDoneMsg struct {
	err        error
	chunkCount int
}

// reindexState is shared between the bubbletea model and the reindex goroutine.
type reindexState struct {
	mu        sync.RWMutex
	phase     string
	processed int
	total     int
	done      bool
	err       error
}

func (s *reindexState) snapshot() (string, int, int, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.phase, s.processed, s.total, s.done, s.err
}

func (s *reindexState) setProgress(phase string, processed, total int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if phase != "" {
		s.phase = phase
	}
	s.processed = processed
	s.total = total
}

func (s *reindexState) complete(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.done = true
	s.err = err
}

func (s *reindexState) errValue() error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.err
}

// completedPhase records a finished indexing phase.
type completedPhase struct {
	name  string
	count int
}

type reindexModel struct {
	bar             progress.Model
	state           *reindexState
	quit            bool
	startTime       time.Time
	phaseStartTime  time.Time
	prog            *tea.Program
	lastPhase       string
	lastTotal       int
	completedPhases []completedPhase
}

func reindexTickCmd() tea.Cmd {
	return tea.Tick(80*time.Millisecond, func(t time.Time) tea.Msg {
		return reindexTickMsg{}
	})
}

func (m *reindexModel) Init() tea.Cmd {
	return reindexTickCmd()
}

func (m *reindexModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "ctrl+c" {
			m.quit = true
			return m, tea.Quit
		}
	case reindexTickMsg:
		if m.quit {
			return m, nil
		}
		phase, processed, total, _, _ := m.state.snapshot()
		if phase != m.lastPhase && m.lastPhase != "" {
			m.completedPhases = append(m.completedPhases, completedPhase{
				name:  m.lastPhase,
				count: m.lastTotal,
			})
			m.phaseStartTime = time.Now()
		}
		m.lastPhase = phase
		m.lastTotal = total

		pct := 0.0
		if total > 0 {
			pct = float64(processed) / float64(total)
		}
		cmd := m.bar.SetPercent(pct)
		return m, tea.Batch(cmd, reindexTickCmd())
	case reindexDoneMsg:
		if m.lastPhase != "" {
			m.completedPhases = append(m.completedPhases, completedPhase{
				name:  m.lastPhase,
				count: m.lastTotal,
			})
		}
		m.state.complete(msg.err)
		m.quit = true
		cmd := m.bar.SetPercent(1.0)
		return m, tea.Batch(cmd, tea.Quit)
	case progress.FrameMsg:
		var cmd tea.Cmd
		m.bar, cmd = m.bar.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m *reindexModel) View() tea.View {
	var b strings.Builder

	if m.quit {
		for _, cp := range m.completedPhases {
			b.WriteString(fmt.Sprintf("  %s Indexed %s (%d)\n",
				searchSuccessStyle.Render("✓"), cp.name, cp.count))
		}
		return tea.NewView(b.String())
	}

	// Completed phases.
	for _, cp := range m.completedPhases {
		b.WriteString(fmt.Sprintf("  %s Indexed %s (%d)\n",
			searchSuccessStyle.Render("✓"), cp.name, cp.count))
	}

	// Active phase bar.
	phase, processed, total, _, _ := m.state.snapshot()

	elapsed := time.Since(m.phaseStartTime)
	eta := ""
	if elapsed.Seconds() > 0.5 && processed > 0 && processed < total {
		itemsPerSec := float64(processed) / elapsed.Seconds()
		remaining := float64(total-processed) / itemsPerSec
		if remaining >= 1 {
			eta = fmt.Sprintf("  %s remaining", formatDuration(int(remaining)))
		}
	}

	info := fmt.Sprintf("  Indexing %s (%d/%d)%s",
		phase, processed, total, eta)
	b.WriteString(fmt.Sprintf("  %s%s\n", m.bar.View(), searchDimStyle.Render(info)))
	return tea.NewView(b.String())
}

func runRuntimeReindexWithProgress(storeRoot, jobID string) error {
	state := &reindexState{phase: "queued", total: 1}
	m := &reindexModel{
		bar:            NewBrandProgressBar(),
		state:          state,
		startTime:      time.Now(),
		phaseStartTime: time.Now(),
	}
	p := tea.NewProgram(m, tea.WithInput(os.Stdin))
	m.prog = p

	go func() {
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			if _, _, _, done, _ := state.snapshot(); done {
				return
			}
			snapshot, err := runtimequeue.LoadJobSnapshot(storeRoot, jobID)
			if err == nil && snapshot.Found && !snapshot.Completed {
				phase := snapshot.Phase()
				if phase == "" {
					phase = "queued"
				}
				processed := snapshot.Processed()
				total := snapshot.Total()
				if total <= 0 {
					total = 1
				}
				state.setProgress(phase, processed, total)
			}
			<-ticker.C
		}
	}()

	go func() {
		_, err := runtimequeue.WaitForJob(storeRoot, jobID, 5*time.Minute)
		p.Send(reindexDoneMsg{err: err})
	}()

	if _, err := p.Run(); err != nil {
		return err
	}
	if err := state.errValue(); err != nil {
		return err
	}
	return nil
}

func runReindex() error {
	store := getStore()

	tasks, _ := store.Tasks.List()
	docs, _ := store.Docs.List()
	decisions, _ := store.Decisions.List()
	taskCount := len(tasks)
	docCount := len(docs)
	decisionCount := len(decisions)
	total := taskCount + docCount + decisionCount

	if total == 0 {
		fmt.Println(RenderWarning("No tasks, docs, or decisions to index."))
		return nil
	}

	if !runtimequeue.ShouldBypassDaemon() {
		handle, err := runtimequeue.AcquireClient("cli-reindex", store.Root, false)
		if err != nil {
			return fmt.Errorf("start runtime reindex: %w", err)
		}
		defer handle.Release()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		runtimequeue.StartHeartbeat(ctx, handle)

		job, err := runtimequeue.Enqueue(store.Root, runtimequeue.JobReindex, "")
		if err != nil {
			return fmt.Errorf("enqueue reindex: %w", err)
		}
		fmt.Printf("%s\n\n", RenderInfo(fmt.Sprintf("Queued runtime reindex (%d tasks, %d docs, %d decisions)...", taskCount, docCount, decisionCount)))
		if err := runRuntimeReindexWithProgress(store.Root, job.ID); err != nil {
			return fmt.Errorf("reindex failed: %w", err)
		}
		searchDir := filepath.Join(store.Root, ".search")
		vs := search.NewSQLiteVectorStore(searchDir, "", 0)
		count, _, _ := vs.Stats()
		fmt.Println(searchSuccessStyle.Render(
			fmt.Sprintf("✓ Search index rebuilt via runtime (%d tasks, %d docs, %d decisions, %d chunks)", taskCount, docCount, decisionCount, count)))
		return nil
	}

	// Verify ONNX runtime is available.
	if avail, _ := search.IsONNXAvailable(); !avail {
		fmt.Println(searchWarnStyle.Render("  Warning: ONNX runtime not found"))
		fmt.Println(searchDimStyle.Render("  Falling back to keyword-only search."))
		fmt.Println()
	}

	// Auto-download default model if ONNX is available but no model configured.
	if avail, _ := search.IsONNXAvailable(); avail {
		cfg, _ := store.Config.Load()
		if cfg != nil && (cfg.Settings.SemanticSearch == nil || cfg.Settings.SemanticSearch.Model == "") {
			defaultModel := "multilingual-e5-small"
			fmt.Println(searchDimStyle.Render(fmt.Sprintf("  No model configured — downloading default model (%s)...", defaultModel)))
			fmt.Println()
			if err := runSemanticSetup(defaultModel); err != nil {
				fmt.Println(searchWarnStyle.Render(fmt.Sprintf("  Warning: model download failed: %s", err)))
				fmt.Println()
			} else {
				// Auto-configure the model.
				for i := range supportedModels {
					if supportedModels[i].ID == defaultModel {
						m := &supportedModels[i]
						_ = store.Config.Set("settings.semanticSearch.model", m.ID)
						_ = store.Config.Set("settings.semanticSearch.huggingFaceId", m.HuggingFace)
						_ = store.Config.Set("settings.semanticSearch.dimensions", m.Dimensions)
						_ = store.Config.Set("settings.semanticSearch.maxTokens", m.MaxTokens)
						_ = store.Config.Set("settings.semanticSearch.enabled", true)
						fmt.Println(searchSuccessStyle.Render(fmt.Sprintf("✓ Configured %s as default model", defaultModel)))
						fmt.Println()
						break
					}
				}
			}
		}
	}

	if err := reindexSemanticStores(store); err == nil {
		return nil
	} else if err != search.ErrSemanticNotConfigured {
		fmt.Println(searchWarnStyle.Render(fmt.Sprintf("Semantic search initialization failed: %s", err)))
		fmt.Println()
	}

	// Fallback: keyword-only — no index to rebuild.
	if true {
		fmt.Println(searchDimStyle.Render("Semantic search is not configured."))
		fmt.Println()
		fmt.Println(RenderNextSteps(
			RenderCmd("knowns model download multilingual-e5-small"),
			RenderCmd("knowns search --reindex"),
		))
	}
	fmt.Println(searchDimStyle.Render("Keyword search does not require indexing (scans tasks/docs on each query)."))
	fmt.Println(RenderInfo(fmt.Sprintf("Found %d tasks, %d docs, and %d decisions available for keyword search.", taskCount, docCount, decisionCount)))
	return nil
}

func reindexSemanticStores(store *storage.Store) error {
	if store == nil {
		return search.ErrSemanticNotConfigured
	}
	if err := reindexSemanticStore(store, "project"); err != nil && err != search.ErrSemanticNotConfigured {
		return err
	}
	if err := reindexSemanticStore(storage.NewGlobalSemanticStore(), "global"); err != nil && err != search.ErrSemanticNotConfigured {
		return err
	}
	return nil
}

func reindexSemanticStore(store *storage.Store, label string) error {
	embedder, vecStore, err := search.InitSemantic(store)
	if err != nil {
		return err
	}
	if embedder == nil || vecStore == nil {
		return search.ErrSemanticNotConfigured
	}
	defer embedder.Close()
	defer vecStore.Close()
	engine := search.NewEngine(store, embedder, vecStore)
	if err := engine.Reindex(nil); err != nil {
		return err
	}
	count := vecStore.Count()
	fmt.Println(searchSuccessStyle.Render(fmt.Sprintf("✓ %s semantic index rebuilt (%d chunks)", strings.Title(label), count)))
	return nil
}

func scoreToPercent(score, maxScore float64) int {
	if maxScore <= 0 {
		return 0
	}
	pct := int((score / maxScore) * 100)
	if pct > 100 {
		pct = 100
	}
	if pct < 1 && score > 0 {
		pct = 1
	}
	return pct
}

func truncate(s string, maxLen int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > maxLen {
		return s[:maxLen] + "..."
	}
	return s
}

func init() {
	searchCmd.Flags().String("type", "", "Search type: all|task|doc|memory|decision (default: all)")
	searchCmd.Flags().String("status", "", "Filter by task, memory, or decision status")
	searchCmd.Flags().String("priority", "", "Filter tasks by priority")
	searchCmd.Flags().String("label", "", "Filter tasks by label")
	searchCmd.Flags().String("tag", "", "Filter docs, memories, or decisions by tag")
	searchCmd.Flags().String("assignee", "", "Filter tasks by assignee")
	searchCmd.Flags().Bool("keyword", false, "Force keyword-only search")
	searchCmd.Flags().Bool("include-historical", false, "Include historical entities, including archived Tasks")
	searchCmd.Flags().Int("limit", 20, "Limit search results")
	searchCmd.Flags().Bool("reindex", false, "Rebuild the search index")
	searchCmd.Flags().Bool("setup", false, "Set up semantic search")
	searchCmd.Flags().Bool("status-check", false, "Show semantic search status")

	retrieveCmd.Flags().String("status", "", "Filter by task, memory, or decision status")
	retrieveCmd.Flags().String("priority", "", "Filter tasks by priority")
	retrieveCmd.Flags().String("label", "", "Filter tasks by label")
	retrieveCmd.Flags().String("tag", "", "Filter docs, memories, or decisions by tag")
	retrieveCmd.Flags().String("assignee", "", "Filter tasks by assignee")
	retrieveCmd.Flags().Bool("keyword", false, "Force keyword-only retrieval")
	retrieveCmd.Flags().Bool("expand-references", false, "Expand @doc/@task/@memory/@decision references into the result")
	retrieveCmd.Flags().Bool("include-historical", false, "Include historical entities; Task retrieval adds done and archived Tasks")
	retrieveCmd.Flags().String("source-types", "", "Comma-separated source types: doc,task,memory,decision")
	retrieveCmd.Flags().Int("limit", 20, "Limit ranked candidates")

	rootCmd.AddCommand(searchCmd)
	rootCmd.AddCommand(retrieveCmd)
}
