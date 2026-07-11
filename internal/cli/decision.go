package cli

import (
	"fmt"
	"strings"

	"github.com/howznguyen/knowns/internal/decisionreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/spf13/cobra"
)

var decisionCmd = &cobra.Command{
	Use:   "decision",
	Short: "Manage decision records",
	Long:  "Create, list, view, link, and supersede project decision records.",
	Args:  cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) == 0 {
			return cmd.Help()
		}
		return runDecisionGet(cmd, args[0])
	},
}

var decisionCreateCmd = &cobra.Command{
	Use:   "create <title>",
	Short: "Create a decision record",
	Args:  cobra.MinimumNArgs(1),
	RunE:  runDecisionCreate,
}

var decisionListCmd = &cobra.Command{
	Use:   "list",
	Short: "List decision records",
	RunE:  runDecisionList,
}

var decisionGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "View a decision record",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runDecisionGet(cmd, args[0])
	},
}

var decisionLinkCmd = &cobra.Command{
	Use:   "link <id>",
	Short: "Link docs, tasks, or sources to a decision",
	Args:  cobra.ExactArgs(1),
	RunE:  runDecisionLink,
}

var decisionSupersedeCmd = &cobra.Command{
	Use:   "supersede <old-id> <new-id>",
	Short: "Mark one decision as superseded by another",
	Args:  cobra.ExactArgs(2),
	RunE:  runDecisionSupersede,
}

func runDecisionCreate(cmd *cobra.Command, args []string) error {
	title := strings.Join(args, " ")
	store := getStore()
	decision, err := decisionFromFlags(cmd, title)
	if err != nil {
		return err
	}
	result, err := decisionreview.New(store).Add(decision, decisionreview.AddOptions{})
	if err != nil {
		return fmt.Errorf("create decision: %w", err)
	}
	if result.Status == decisionreview.ResultReviewRequired {
		if isJSON(cmd) {
			printJSON(result)
			return nil
		}
		printDecisionReviewRequired(cmd, result)
		return nil
	}
	decision = result.Decision
	search.BestEffortIndexDecision(store, decision.ID)
	if isJSON(cmd) {
		printJSON(decision)
		return nil
	}
	if isPlain(cmd) {
		printDecisionPlain(cmd, decision)
		return nil
	}
	fmt.Println(RenderSuccess(fmt.Sprintf("Created decision: %s (%s, status: %s)", decision.ID, decision.Title, decision.Status)))
	return nil
}

func printDecisionReviewRequired(cmd *cobra.Command, result *decisionreview.Result) {
	var b strings.Builder
	fmt.Fprintln(&b, RenderWarning("Decision review required: similar or conflicting current decisions already exist."))
	for _, match := range result.Matches {
		fmt.Fprintf(&b, "DECISION: %s\n", match.ID)
		fmt.Fprintf(&b, "  TITLE: %s\n", match.Title)
		if match.Status != "" {
			fmt.Fprintf(&b, "  STATUS: %s\n", match.Status)
		}
		if match.Kind != "" {
			fmt.Fprintf(&b, "  KIND: %s\n", match.Kind)
		}
		fmt.Fprintf(&b, "  SCORE: %.2f\n", match.Score)
		if len(match.MatchedBy) > 0 {
			fmt.Fprintf(&b, "  MATCHED_BY: %s\n", strings.Join(match.MatchedBy, ", "))
		}
		fmt.Fprintln(&b)
	}
	fmt.Fprintf(&b, "Allowed resolutions: %s\n", strings.Join(result.AllowedResolutions, ", "))
	printPaged(cmd, b.String())
}

func runDecisionList(cmd *cobra.Command, args []string) error {
	store := getStore()
	status, _ := cmd.Flags().GetString("status")
	includeAll, _ := cmd.Flags().GetBool("all-statuses")
	tag, _ := cmd.Flags().GetString("tag")
	if status != "" && !models.ValidDecisionStatus(status) {
		return fmt.Errorf("invalid decision status: %q", status)
	}
	decisions, err := store.Decisions.List()
	if err != nil {
		return fmt.Errorf("list decisions: %w", err)
	}
	decisions = filterDecisions(decisions, status, tag, includeAll)
	if isJSON(cmd) {
		printJSON(decisions)
		return nil
	}
	if isPlain(cmd) {
		var b strings.Builder
		for _, decision := range decisions {
			fmt.Fprintf(&b, "DECISION: %s\n", decision.ID)
			fmt.Fprintf(&b, "  TITLE: %s\n", decision.Title)
			fmt.Fprintf(&b, "  STATUS: %s\n", decision.Status)
			if len(decision.Tags) > 0 {
				fmt.Fprintf(&b, "  TAGS: %s\n", strings.Join(decision.Tags, ", "))
			}
			fmt.Fprintln(&b)
		}
		if b.Len() == 0 {
			fmt.Fprintln(&b, "No decisions found")
		}
		printPaged(cmd, b.String())
		return nil
	}
	fmt.Print(renderDecisionList(decisions))
	return nil
}

func runDecisionGet(cmd *cobra.Command, id string) error {
	store := getStore()
	decision, err := store.Decisions.Get(id)
	if err != nil {
		return fmt.Errorf("decision %q not found", id)
	}
	if isJSON(cmd) {
		printJSON(decision)
		return nil
	}
	printDecisionPlain(cmd, decision)
	return nil
}

func runDecisionLink(cmd *cobra.Command, args []string) error {
	store := getStore()
	docs, _ := cmd.Flags().GetStringArray("doc")
	tasks, _ := cmd.Flags().GetStringArray("task")
	sources, _ := cmd.Flags().GetStringArray("source")
	decision, err := store.Decisions.Link(args[0], docs, tasks, sources)
	if err != nil {
		return fmt.Errorf("link decision: %w", err)
	}
	search.BestEffortIndexDecision(store, decision.ID)
	if isJSON(cmd) {
		printJSON(decision)
		return nil
	}
	fmt.Println(RenderSuccess(fmt.Sprintf("Linked decision: %s", decision.ID)))
	return nil
}

func runDecisionSupersede(cmd *cobra.Command, args []string) error {
	store := getStore()
	oldDecision, newDecision, err := store.Decisions.Supersede(args[0], args[1])
	if err != nil {
		return fmt.Errorf("supersede decision: %w", err)
	}
	search.BestEffortIndexDecision(store, oldDecision.ID)
	search.BestEffortIndexDecision(store, newDecision.ID)
	result := map[string]any{
		"superseded": oldDecision,
		"current":    newDecision,
	}
	if isJSON(cmd) {
		printJSON(result)
		return nil
	}
	fmt.Println(RenderSuccess(fmt.Sprintf("Decision %s superseded by %s", oldDecision.ID, newDecision.ID)))
	return nil
}

func decisionFromFlags(cmd *cobra.Command, title string) (*models.DecisionEntry, error) {
	status, _ := cmd.Flags().GetString("status")
	if status != "" && !models.ValidDecisionStatus(status) {
		return nil, fmt.Errorf("invalid decision status: %q", status)
	}
	tags, _ := cmd.Flags().GetStringArray("tag")
	sources, _ := cmd.Flags().GetStringArray("source")
	relatedDocs, _ := cmd.Flags().GetStringArray("doc")
	relatedTasks, _ := cmd.Flags().GetStringArray("task")
	body, _ := cmd.Flags().GetString("body")
	context, _ := cmd.Flags().GetString("context")
	decisionText, _ := cmd.Flags().GetString("decision")
	alternatives, _ := cmd.Flags().GetString("alternatives")
	consequences, _ := cmd.Flags().GetString("consequences")
	return &models.DecisionEntry{
		Title:                  title,
		Status:                 status,
		Tags:                   tags,
		Sources:                sources,
		RelatedDocs:            relatedDocs,
		RelatedTasks:           relatedTasks,
		Content:                unescapeText(body),
		Context:                unescapeText(context),
		Decision:               unescapeText(decisionText),
		AlternativesConsidered: unescapeText(alternatives),
		Consequences:           unescapeText(consequences),
	}, nil
}

func filterDecisions(decisions []*models.DecisionEntry, status, tag string, includeAll bool) []*models.DecisionEntry {
	filtered := decisions[:0]
	for _, decision := range decisions {
		if status != "" {
			if decision.Status != status {
				continue
			}
		} else if !includeAll && !decision.CurrentForDefaultRetrieval() {
			continue
		}
		if tag != "" && !containsTag(decision.Tags, tag) {
			continue
		}
		filtered = append(filtered, decision)
	}
	return filtered
}

func renderDecisionList(decisions []*models.DecisionEntry) string {
	var b strings.Builder
	fmt.Fprintf(&b, "  %s  %s  %s\n",
		StyleBold.Render(fmt.Sprintf("%-22s", "ID")),
		StyleBold.Render(fmt.Sprintf("%-36s", "TITLE")),
		StyleBold.Render("STATUS"))
	fmt.Fprintln(&b, "  "+RenderSeparator(76))
	for _, decision := range decisions {
		title := decision.Title
		if len(title) > 34 {
			title = title[:31] + "..."
		}
		fmt.Fprintf(&b, "  %s  %-36s  %s\n",
			StyleID.Render(fmt.Sprintf("%-22s", decision.ID)),
			title,
			decision.Status)
	}
	if len(decisions) == 0 {
		fmt.Fprintln(&b, StyleDim.Render("No decisions found."))
	}
	return b.String()
}

func printDecisionPlain(cmd *cobra.Command, decision *models.DecisionEntry) {
	var b strings.Builder
	fmt.Fprintf(&b, "ID: %s\n", decision.ID)
	fmt.Fprintf(&b, "TITLE: %s\n", decision.Title)
	fmt.Fprintf(&b, "STATUS: %s\n", decision.Status)
	if len(decision.Supersedes) > 0 {
		fmt.Fprintf(&b, "SUPERSEDES: %s\n", strings.Join(decision.Supersedes, ", "))
	}
	if len(decision.SupersededBy) > 0 {
		fmt.Fprintf(&b, "SUPERSEDED_BY: %s\n", strings.Join(decision.SupersededBy, ", "))
	}
	if len(decision.Sources) > 0 {
		fmt.Fprintf(&b, "SOURCES: %s\n", strings.Join(decision.Sources, ", "))
	}
	if len(decision.RelatedDocs) > 0 {
		fmt.Fprintf(&b, "RELATED_DOCS: %s\n", strings.Join(decision.RelatedDocs, ", "))
	}
	if len(decision.RelatedTasks) > 0 {
		fmt.Fprintf(&b, "RELATED_TASKS: %s\n", strings.Join(decision.RelatedTasks, ", "))
	}
	if len(decision.Tags) > 0 {
		fmt.Fprintf(&b, "TAGS: %s\n", strings.Join(decision.Tags, ", "))
	}
	fmt.Fprintf(&b, "REF: %s\n\n", models.DecisionRef(decision.ID))
	if decision.Content != "" {
		fmt.Fprintln(&b, decision.Content)
	}
	printPaged(cmd, b.String())
}

func init() {
	decisionCreateCmd.Flags().String("status", "", "Explicit decision status")
	decisionCreateCmd.Flags().StringArrayP("tag", "t", nil, "Decision tag (repeatable)")
	decisionCreateCmd.Flags().StringArray("source", nil, "Source reference (repeatable)")
	decisionCreateCmd.Flags().StringArray("doc", nil, "Related doc path (repeatable)")
	decisionCreateCmd.Flags().StringArray("task", nil, "Related task ID (repeatable)")
	decisionCreateCmd.Flags().String("body", "", "Full markdown decision body")
	decisionCreateCmd.Flags().String("context", "", "Context section body")
	decisionCreateCmd.Flags().String("decision", "", "Decision section body")
	decisionCreateCmd.Flags().String("alternatives", "", "Alternatives Considered section body")
	decisionCreateCmd.Flags().String("consequences", "", "Consequences section body")

	decisionListCmd.Flags().String("status", "", "Filter by decision status")
	decisionListCmd.Flags().Bool("all-statuses", false, "Include draft, superseded, rejected, and archived decisions")
	decisionListCmd.Flags().String("tag", "", "Filter by tag")

	decisionLinkCmd.Flags().StringArray("doc", nil, "Related doc path (repeatable)")
	decisionLinkCmd.Flags().StringArray("task", nil, "Related task ID (repeatable)")
	decisionLinkCmd.Flags().StringArray("source", nil, "Source reference (repeatable)")

	decisionCmd.AddCommand(decisionCreateCmd)
	decisionCmd.AddCommand(decisionListCmd)
	decisionCmd.AddCommand(decisionGetCmd)
	decisionCmd.AddCommand(decisionLinkCmd)
	decisionCmd.AddCommand(decisionSupersedeCmd)

	rootCmd.AddCommand(decisionCmd)
}
