package cli

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/memoryreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/spf13/cobra"
)

// Default soft limit per layer.
const defaultMemorySoftLimit = 100

var memoryCmd = &cobra.Command{
	Use:   "memory",
	Short: "Manage memory entries",
	Long:  "Create, view, and manage project and global memory entries.",
	Args:  cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) == 0 {
			return cmd.Help()
		}
		return runMemoryView(cmd, args[0])
	},
}

// --- memory list ---

var memoryListCmd = &cobra.Command{
	Use:   "list",
	Short: "List memory entries",
	RunE:  runMemoryList,
}

func runMemoryList(cmd *cobra.Command, args []string) error {
	store := getStore()
	layer, _ := cmd.Flags().GetString("layer")
	category, _ := cmd.Flags().GetString("category")
	tagFilter, _ := cmd.Flags().GetString("tag")
	statusFilter, _ := cmd.Flags().GetString("status")
	allStatuses, _ := cmd.Flags().GetBool("all-statuses")

	entries, err := store.Memory.List(layer)
	if err != nil {
		return fmt.Errorf("list memory: %w", err)
	}
	if statusFilter != "" && !models.ValidMemoryStatus(statusFilter) {
		return fmt.Errorf("invalid memory status: %q", statusFilter)
	}

	// Apply filters.
	if category != "" {
		filtered := entries[:0]
		for _, e := range entries {
			if e.Category == category {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
	}
	if statusFilter != "" {
		filtered := entries[:0]
		for _, e := range entries {
			if e.Status == statusFilter {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
	} else if !allStatuses {
		filtered := entries[:0]
		for _, e := range entries {
			if e.CurrentForDefaultRetrieval() {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
	}
	if tagFilter != "" {
		filtered := entries[:0]
		for _, e := range entries {
			if containsTag(e.Tags, tagFilter) {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
	}

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)

	if jsonOut {
		printJSON(entries)
		return nil
	}

	if len(entries) == 0 {
		fmt.Println(StyleDim.Render("No memory entries found."))
		return nil
	}

	if plain {
		page, _ := getPageOpts(cmd)
		total := len(entries)
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
		pageEntries := entries[start:end]
		var pb strings.Builder
		for _, e := range pageEntries {
			fmt.Fprintf(&pb, "MEMORY: %s\n", e.ID)
			fmt.Fprintf(&pb, "  TITLE: %s\n", e.Title)
			fmt.Fprintf(&pb, "  LAYER: %s\n", e.Layer)
			if e.Category != "" {
				fmt.Fprintf(&pb, "  CATEGORY: %s\n", e.Category)
			}
			if len(e.Tags) > 0 {
				fmt.Fprintf(&pb, "  TAGS: %s\n", strings.Join(e.Tags, ", "))
			}
			fmt.Fprintln(&pb)
		}
		fmt.Print(pb.String())
		if total > limit {
			totalPages := (total + limit - 1) / limit
			fmt.Printf("PAGE: %d/%d (items %d-%d of %d)\n", page, totalPages, start+1, end, total)
			if page < totalPages {
				fmt.Printf("Use --page %d to see more results.\n", page+1)
			}
		}
	} else {
		content := renderMemoryList(entries)
		if !isTTY() || isPagerDisabled(cmd) {
			fmt.Print(content)
		} else {
			renderOrPage(cmd, "Memory Entries", content)
		}
	}
	return nil
}

// --- memory cleanup ---

var memoryCleanupCmd = &cobra.Command{
	Use:   "cleanup",
	Short: "List stale memory cleanup candidates",
	RunE:  runMemoryCleanup,
}

type memoryCleanupCandidate struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Layer     string    `json:"layer"`
	Category  string    `json:"category,omitempty"`
	Tags      []string  `json:"tags,omitempty"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	AgeDays   int       `json:"ageDays"`
}

func runMemoryCleanup(cmd *cobra.Command, args []string) error {
	store := getStore()
	olderThanDays, _ := cmd.Flags().GetInt("older-than")
	layer, _ := cmd.Flags().GetString("layer")
	limit, _ := cmd.Flags().GetInt("limit")
	if layer == "" {
		layer = models.MemoryLayerProject
	}
	if !models.ValidPersistentMemoryLayer(layer) {
		return fmt.Errorf("layer must be 'project' or 'global'")
	}
	if olderThanDays <= 0 {
		olderThanDays = 7
	}
	if limit <= 0 {
		limit = 20
	}

	entries, err := store.Memory.ListPersistent(layer)
	if err != nil {
		return fmt.Errorf("list memory cleanup candidates: %w", err)
	}
	candidates := cleanupMemoryCandidates(entries, olderThanDays, limit, time.Now().UTC())

	if isJSON(cmd) {
		printJSON(candidates)
		return nil
	}
	if isPlain(cmd) {
		printMemoryCleanupPlain(cmd, candidates)
		return nil
	}
	if len(candidates) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), StyleDim.Render("No stale memories found."))
		return nil
	}
	printMemoryCleanupPlain(cmd, candidates)
	return nil
}

func cleanupMemoryCandidates(entries []*models.MemoryEntry, olderThanDays, limit int, now time.Time) []memoryCleanupCandidate {
	threshold := now.Add(-time.Duration(olderThanDays) * 24 * time.Hour)
	candidates := make([]memoryCleanupCandidate, 0)
	for _, entry := range entries {
		effective := entry.UpdatedAt
		if effective.IsZero() {
			effective = entry.CreatedAt
		}
		if effective.IsZero() || !effective.Before(threshold) {
			continue
		}
		candidates = append(candidates, memoryCleanupCandidate{
			ID:        entry.ID,
			Title:     entry.Title,
			Layer:     entry.Layer,
			Category:  entry.Category,
			Tags:      entry.Tags,
			Content:   entry.Content,
			CreatedAt: entry.CreatedAt,
			UpdatedAt: entry.UpdatedAt,
			AgeDays:   int(now.Sub(effective).Hours() / 24),
		})
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].AgeDays > candidates[j].AgeDays
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	return candidates
}

func printMemoryCleanupPlain(cmd *cobra.Command, candidates []memoryCleanupCandidate) {
	var pb strings.Builder
	if len(candidates) == 0 {
		fmt.Fprintln(&pb, "No stale memories found")
		printPaged(cmd, pb.String())
		return
	}
	for _, c := range candidates {
		fmt.Fprintf(&pb, "MEMORY: %s\n", c.ID)
		fmt.Fprintf(&pb, "  TITLE: %s\n", c.Title)
		fmt.Fprintf(&pb, "  LAYER: %s\n", c.Layer)
		if c.Category != "" {
			fmt.Fprintf(&pb, "  CATEGORY: %s\n", c.Category)
		}
		if len(c.Tags) > 0 {
			fmt.Fprintf(&pb, "  TAGS: %s\n", strings.Join(c.Tags, ", "))
		}
		fmt.Fprintf(&pb, "  AGE_DAYS: %d\n", c.AgeDays)
		fmt.Fprintf(&pb, "  CREATED_AT: %s\n", c.CreatedAt.Format(time.RFC3339))
		fmt.Fprintf(&pb, "  UPDATED_AT: %s\n", c.UpdatedAt.Format(time.RFC3339))
		if c.Content != "" {
			fmt.Fprintf(&pb, "  CONTENT:\n%s\n", c.Content)
		}
		fmt.Fprintln(&pb)
	}
	printPaged(cmd, pb.String())
}

// --- memory view ---

var memoryViewCmd = &cobra.Command{
	Use:   "view <id>",
	Short: "View a memory entry",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runMemoryView(cmd, args[0])
	},
}

func runMemoryView(cmd *cobra.Command, id string) error {
	store := getStore()

	entry, err := store.Memory.Get(id)
	if err != nil {
		return fmt.Errorf("memory %q not found", id)
	}

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)

	if jsonOut {
		printJSON(entry)
		return nil
	}

	if plain {
		var pb strings.Builder
		fmt.Fprintf(&pb, "ID: %s\n", entry.ID)
		fmt.Fprintf(&pb, "TITLE: %s\n", entry.Title)
		fmt.Fprintf(&pb, "LAYER: %s\n", entry.Layer)
		if entry.Category != "" {
			fmt.Fprintf(&pb, "CATEGORY: %s\n", entry.Category)
		}
		if len(entry.Tags) > 0 {
			fmt.Fprintf(&pb, "TAGS: %s\n", strings.Join(entry.Tags, ", "))
		}
		fmt.Fprintf(&pb, "UPDATED: %s\n\n", entry.UpdatedAt.Format("2006-01-02"))
		if entry.Content != "" {
			fmt.Fprintln(&pb, entry.Content)
		}
		printPaged(cmd, pb.String())
	} else {
		content := renderMemoryView(entry)
		renderOrPage(cmd, entry.Title, content)
	}
	return nil
}

// --- memory create ---

var memoryCreateCmd = &cobra.Command{
	Use:   "create <title>",
	Short: "Create a new memory entry",
	Args:  cobra.MinimumNArgs(1),
	RunE:  runMemoryCreate,
}

func runMemoryCreate(cmd *cobra.Command, args []string) error {
	title := strings.Join(args, " ")
	store := getStore()

	layer, _ := cmd.Flags().GetString("layer")
	category, _ := cmd.Flags().GetString("category")
	tags, _ := cmd.Flags().GetStringArray("tag")
	content, _ := cmd.Flags().GetString("content")
	content = unescapeText(content)
	createAnyway, _ := cmd.Flags().GetBool("create-anyway")
	status, _ := cmd.Flags().GetString("status")
	if status != "" && !models.ValidMemoryStatus(status) {
		return fmt.Errorf("invalid memory status: %q", status)
	}

	if layer == "" {
		layer = models.MemoryLayerProject
	}

	// Soft limit warning.
	count, _ := store.Memory.CountByLayer(layer)
	if count >= defaultMemorySoftLimit {
		fmt.Println(RenderWarning(fmt.Sprintf("Layer %q has %d entries (soft limit: %d). Consider cleaning up.", layer, count, defaultMemorySoftLimit)))
	}

	now := time.Now().UTC()
	entry := &models.MemoryEntry{
		Title:     title,
		Layer:     layer,
		Category:  category,
		Content:   content,
		Tags:      tags,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if entry.Tags == nil {
		entry.Tags = []string{}
	}

	svc := memoryreview.New(store)
	var result *memoryreview.Result
	var err error
	if createAnyway {
		result, err = svc.Add(entry, memoryreview.AddOptions{SkipReview: true, Status: firstNonEmpty(status, models.MemoryStatusProposed)})
	} else {
		result, err = svc.Add(entry, memoryreview.AddOptions{Status: status})
	}
	if err != nil {
		return fmt.Errorf("create memory: %w", err)
	}
	if result.Status == memoryreview.ResultReviewRequired {
		if isJSON(cmd) {
			printJSON(result)
			return nil
		}
		printMemoryReviewRequired(cmd, result)
		return nil
	}

	for _, id := range result.ChangedIDs {
		search.BestEffortIndexMemory(store, id)
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Created memory: %s (%s, layer: %s, status: %s)", result.Memory.ID, result.Memory.Title, result.Memory.Layer, result.Memory.Status)))
	return nil
}

func printMemoryReviewRequired(cmd *cobra.Command, result *memoryreview.Result) {
	var b strings.Builder
	fmt.Fprintln(&b, RenderWarning("Memory review required: similar memories already exist."))
	for _, match := range result.Matches {
		fmt.Fprintf(&b, "MEMORY: %s\n", match.ID)
		fmt.Fprintf(&b, "  TITLE: %s\n", match.Title)
		fmt.Fprintf(&b, "  LAYER: %s\n", match.Layer)
		if match.Category != "" {
			fmt.Fprintf(&b, "  CATEGORY: %s\n", match.Category)
		}
		if match.Status != "" {
			fmt.Fprintf(&b, "  STATUS: %s\n", match.Status)
		}
		fmt.Fprintf(&b, "  SCORE: %.2f\n", match.Score)
		if len(match.MatchedBy) > 0 {
			fmt.Fprintf(&b, "  MATCHED_BY: %s\n", strings.Join(match.MatchedBy, ", "))
		}
		fmt.Fprintln(&b)
	}
	fmt.Fprintf(&b, "Allowed resolutions: %s\n", strings.Join(result.AllowedResolutions, ", "))
	fmt.Fprintln(&b, "Use --create-anyway to create this memory explicitly.")
	printPaged(cmd, b.String())
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// --- memory edit ---

var memoryEditCmd = &cobra.Command{
	Use:   "edit <id>",
	Short: "Edit a memory entry",
	Args:  cobra.ExactArgs(1),
	RunE:  runMemoryEdit,
}

func runMemoryEdit(cmd *cobra.Command, args []string) error {
	id := args[0]
	store := getStore()

	entry, err := store.Memory.Get(id)
	if err != nil {
		return fmt.Errorf("memory %q not found", id)
	}

	if cmd.Flags().Changed("title") {
		v, _ := cmd.Flags().GetString("title")
		entry.Title = v
	}
	if cmd.Flags().Changed("category") {
		v, _ := cmd.Flags().GetString("category")
		entry.Category = v
	}
	if cmd.Flags().Changed("tag") {
		v, _ := cmd.Flags().GetStringArray("tag")
		entry.Tags = v
	}
	if cmd.Flags().Changed("content") {
		v, _ := cmd.Flags().GetString("content")
		entry.Content = unescapeText(v)
	}
	if cmd.Flags().Changed("append") {
		v, _ := cmd.Flags().GetString("append")
		v = unescapeText(v)
		if entry.Content == "" {
			entry.Content = v
		} else {
			if !strings.HasSuffix(entry.Content, "\n") {
				entry.Content += "\n"
			}
			entry.Content += v
		}
	}

	entry.UpdatedAt = time.Now().UTC()

	if err := store.Memory.Update(entry); err != nil {
		return fmt.Errorf("update memory: %w", err)
	}

	search.BestEffortIndexMemory(store, entry.ID)

	fmt.Println(RenderSuccess(fmt.Sprintf("Updated memory: %s", entry.ID)))
	return nil
}

// --- memory delete ---

var memoryDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete a memory entry",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		store := getStore()
		dryRun, _ := cmd.Flags().GetBool("dry-run")
		force, _ := cmd.Flags().GetBool("force")

		entry, err := store.Memory.Get(args[0])
		if err != nil {
			return fmt.Errorf("memory %q not found", args[0])
		}

		if dryRun {
			fmt.Println(RenderDim(fmt.Sprintf("Would delete memory: %s (%s, layer: %s)", entry.ID, entry.Title, entry.Layer)))
			return nil
		}

		if !force {
			fmt.Printf("%s %s (%s)? %s: ", StyleWarning.Render("Delete memory"), StyleBold.Render(entry.ID), entry.Title, StyleDim.Render("This cannot be undone. (y/n)"))
			var answer string
			fmt.Scanln(&answer)
			if answer != "y" && answer != "yes" {
				fmt.Println(StyleDim.Render("Aborted."))
				return nil
			}
		}

		if err := store.Memory.Delete(args[0]); err != nil {
			return fmt.Errorf("delete memory: %w", err)
		}
		search.BestEffortRemoveMemory(store, args[0])
		fmt.Println(RenderSuccess(fmt.Sprintf("Deleted memory: %s", entry.ID)))
		return nil
	},
}

// --- memory promote ---

var memoryPromoteCmd = &cobra.Command{
	Use:   "promote <id>",
	Short: "Promote a memory entry up one layer",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		store := getStore()

		entry, err := store.Memory.Promote(args[0])
		if err != nil {
			return err
		}

		search.BestEffortIndexMemory(store, entry.ID)
		fmt.Println(RenderSuccess(fmt.Sprintf("Promoted memory %s to layer: %s", entry.ID, entry.Layer)))
		return nil
	},
}

// --- memory demote ---

var memoryDemoteCmd = &cobra.Command{
	Use:   "demote <id>",
	Short: "Demote a memory entry down one layer",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		store := getStore()

		entry, err := store.Memory.Demote(args[0])
		if err != nil {
			return err
		}

		search.BestEffortIndexMemory(store, entry.ID)
		fmt.Println(RenderSuccess(fmt.Sprintf("Demoted memory %s to layer: %s", entry.ID, entry.Layer)))
		return nil
	},
}

// ---- render helpers ----

func renderMemoryList(entries []*models.MemoryEntry) string {
	var b strings.Builder
	fmt.Fprintf(&b, "  %s  %s  %s  %s\n",
		StyleBold.Render(fmt.Sprintf("%-8s", "ID")),
		StyleBold.Render(fmt.Sprintf("%-30s", "TITLE")),
		StyleBold.Render(fmt.Sprintf("%-10s", "LAYER")),
		StyleBold.Render("CATEGORY"))
	fmt.Fprintln(&b, "  "+RenderSeparator(70))
	for _, e := range entries {
		title := e.Title
		if len(title) > 28 {
			title = title[:25] + "..."
		}
		fmt.Fprintf(&b, "  %s  %-30s  %-10s  %s\n",
			StyleID.Render(fmt.Sprintf("%-8s", e.ID)),
			title,
			layerStyle(e.Layer),
			StyleDim.Render(e.Category))
	}
	return b.String()
}

func renderMemoryView(entry *models.MemoryEntry) string {
	var b strings.Builder
	fmt.Fprintln(&b, StyleTitle.Render(entry.Title))
	fmt.Fprintf(&b, "%s %s  %s %s\n",
		StyleDim.Render("Layer:"), layerStyle(entry.Layer),
		StyleDim.Render("Category:"), entry.Category)
	if len(entry.Tags) > 0 {
		fmt.Fprintf(&b, "%s %s\n", StyleDim.Render("Tags:"), RenderTags(entry.Tags))
	}
	fmt.Fprintln(&b, RenderSeparator(60))
	if entry.Content != "" {
		fmt.Fprintln(&b, entry.Content)
	}
	return b.String()
}

func layerStyle(layer string) string {
	switch layer {
	case models.MemoryLayerProject:
		return StyleSuccess.Render(layer)
	case models.MemoryLayerGlobal:
		return StyleInfo.Render(layer)
	default:
		return layer
	}
}

func init() {
	// memory list flags
	memoryListCmd.Flags().String("layer", "", "Filter by layer (working, project, global)")
	memoryListCmd.Flags().String("category", "", "Filter by category")
	memoryListCmd.Flags().String("tag", "", "Filter by tag")
	memoryListCmd.Flags().String("status", "", "Filter by memory status")
	memoryListCmd.Flags().Bool("all-statuses", false, "Include non-active memory statuses")

	// memory cleanup flags
	memoryCleanupCmd.Flags().Int("older-than", 7, "Minimum stale age in days")
	memoryCleanupCmd.Flags().String("layer", models.MemoryLayerProject, "Memory layer (project, global; default: project)")
	memoryCleanupCmd.Flags().Int("limit", 20, "Maximum cleanup candidates to return")

	// memory create flags
	memoryCreateCmd.Flags().String("layer", "", "Memory layer (working, project, global; default: project)")
	memoryCreateCmd.Flags().String("category", "", "Memory category (pattern, decision, convention, preference)")
	memoryCreateCmd.Flags().StringArrayP("tag", "t", nil, "Memory tag (repeatable)")
	memoryCreateCmd.Flags().StringP("content", "c", "", "Memory content")
	memoryCreateCmd.Flags().String("status", "", "Explicit memory status for human create/override")
	memoryCreateCmd.Flags().Bool("create-anyway", false, "Create even when duplicate review candidates are found")

	// memory edit flags
	memoryEditCmd.Flags().StringP("title", "t", "", "New title")
	memoryEditCmd.Flags().String("category", "", "New category")
	memoryEditCmd.Flags().StringArray("tag", nil, "New tags (replaces existing)")
	memoryEditCmd.Flags().StringP("content", "c", "", "Replace content")
	memoryEditCmd.Flags().StringP("append", "a", "", "Append to content")

	// memory delete flags
	memoryDeleteCmd.Flags().Bool("dry-run", false, "Preview what would be deleted")
	memoryDeleteCmd.Flags().Bool("force", false, "Skip confirmation prompt")

	memoryCmd.AddCommand(memoryListCmd)
	memoryCmd.AddCommand(memoryCleanupCmd)
	memoryCmd.AddCommand(memoryViewCmd)
	memoryCmd.AddCommand(memoryCreateCmd)
	memoryCmd.AddCommand(memoryEditCmd)
	memoryCmd.AddCommand(memoryDeleteCmd)
	memoryCmd.AddCommand(memoryPromoteCmd)
	memoryCmd.AddCommand(memoryDemoteCmd)

	rootCmd.AddCommand(memoryCmd)
}
