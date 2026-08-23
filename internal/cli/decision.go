package cli

import (
	"fmt"
	"strings"

	"github.com/howznguyen/knowns/internal/decisionmigration"
	"github.com/howznguyen/knowns/internal/decisionreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/spf13/cobra"
)

var decisionCmd = &cobra.Command{
	Use:   "decision",
	Short: "Manage System Decision records",
	Long:  "Create draft System Decisions, link evidence, verify acceptance, supersede current guidance, and migrate Legacy Decision Memories.",
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

var decisionInboxCmd = &cobra.Command{
	Use:   "inbox",
	Short: "List unresolved persisted Decision candidates",
	Args:  cobra.NoArgs,
	RunE:  runDecisionInbox,
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

var decisionAcceptCmd = &cobra.Command{
	Use:   "accept <id>",
	Short: "Accept a verified draft decision",
	Args:  cobra.ExactArgs(1),
	RunE:  runDecisionAccept,
}

var decisionResolveCmd = &cobra.Command{
	Use:   "resolve <resolution> <candidate-id>",
	Short: "Resolve a persisted System Decision candidate",
	Long:  "Resolve a persisted candidate with accept_new, link_as_related, reject_new, or supersede_existing. Link and replace require --target.",
	Args:  cobra.ExactArgs(2),
	RunE:  runDecisionResolve,
}

var decisionMigrateCmd = &cobra.Command{
	Use:   "migrate",
	Short: "Review and migrate legacy Decision Memories",
	Long:  "Preview legacy Decision Memories without writes, apply one explicit reviewed resolution, or roll back a prior migration.",
}

var decisionMigratePreviewCmd = &cobra.Command{
	Use:   "preview",
	Short: "Preview legacy Decision Memory candidates without writing",
	Args:  cobra.NoArgs,
	RunE:  runDecisionMigrationPreview,
}

var decisionMigrateApplyCmd = &cobra.Command{
	Use:   "apply",
	Short: "Apply one explicit reviewed migration resolution",
	Args:  cobra.NoArgs,
	RunE:  runDecisionMigrationApply,
}

var decisionMigrateRollbackCmd = &cobra.Command{
	Use:   "rollback <memory-id>",
	Short: "Roll back a reviewed legacy Decision Memory migration",
	Args:  cobra.ExactArgs(1),
	RunE:  runDecisionMigrationRollback,
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
	if result.Candidate != nil {
		fmt.Fprintf(&b, "Persisted candidate: %s\n", result.Candidate.ID)
		fmt.Fprintf(&b, "Run `knowns decision resolve <resolution> %s` with --target when required.\n", result.Candidate.ID)
	}
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

func runDecisionInbox(cmd *cobra.Command, args []string) error {
	candidates, err := decisionreview.New(getStore()).ReviewCandidates()
	if err != nil {
		return fmt.Errorf("list Decision review inbox: %w", err)
	}
	if isJSON(cmd) {
		printJSON(candidates)
		return nil
	}
	var b strings.Builder
	for _, candidate := range candidates {
		fmt.Fprintf(&b, "CANDIDATE: %s\n", candidate.ID)
		fmt.Fprintf(&b, "  TITLE: %s\n", candidate.Title)
		fmt.Fprintf(&b, "  REVIEW_STATE: %s\n", candidate.ReviewState)
		for _, blocker := range candidate.ReviewBlockers {
			fmt.Fprintf(&b, "  BLOCKER: %s\n", blocker)
		}
		fmt.Fprintln(&b)
	}
	if b.Len() == 0 {
		fmt.Fprintln(&b, "No unresolved Decision candidates")
	}
	printPaged(cmd, b.String())
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
	if decision.Status == models.DecisionStatusDraft {
		decision, err = decisionreview.New(store).RefreshCandidate(decision.ID)
		if err != nil {
			return fmt.Errorf("refresh Decision candidate: %w", err)
		}
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

func runDecisionAccept(cmd *cobra.Command, args []string) error {
	store := getStore()
	supersedes, _ := cmd.Flags().GetStringArray("supersede")
	result, err := decisionreview.New(store).Accept(args[0], decisionreview.AcceptOptions{Supersedes: supersedes})
	if err != nil {
		return fmt.Errorf("accept decision: %w", err)
	}
	for _, id := range result.ChangedIDs {
		search.BestEffortIndexDecision(store, id)
	}
	if isJSON(cmd) {
		printJSON(result)
		return nil
	}
	fmt.Println(RenderSuccess(fmt.Sprintf("Accepted verified decision: %s", result.Decision.ID)))
	return nil
}

func runDecisionResolve(cmd *cobra.Command, args []string) error {
	resolution := args[0]
	candidateID := args[1]
	targetID, _ := cmd.Flags().GetString("target")
	replacementID, _ := cmd.Flags().GetString("replacement-id")
	result, err := decisionreview.New(getStore()).Resolve(nil, decisionreview.ResolveOptions{
		CandidateID:   candidateID,
		Resolution:    resolution,
		TargetID:      targetID,
		ReplacementID: replacementID,
	})
	if err != nil {
		return fmt.Errorf("resolve decision review: %w", err)
	}
	for _, id := range result.ChangedIDs {
		search.BestEffortIndexDecision(getStore(), id)
	}
	if isJSON(cmd) {
		printJSON(result)
		return nil
	}
	decision := result.Decision
	if decision == nil {
		decision = result.Current
	}
	if isPlain(cmd) && decision != nil {
		printDecisionPlain(cmd, decision)
		return nil
	}
	if decision != nil {
		fmt.Println(RenderSuccess(fmt.Sprintf("Resolved Decision review with %s: %s", resolution, decision.ID)))
		return nil
	}
	fmt.Println(RenderSuccess(fmt.Sprintf("Resolved Decision review with %s", resolution)))
	return nil
}

func runDecisionMigrationPreview(cmd *cobra.Command, args []string) error {
	report, err := decisionmigration.New(getStore()).Preview()
	if err != nil {
		return fmt.Errorf("preview Decision Memory migration: %w", err)
	}
	if isJSON(cmd) {
		printJSON(report)
		return nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Legacy Decision Memories: %d (high-noise: %d, duplicate members: %d, source issues: %d)\n\n",
		report.Counts.Total, report.Counts.HighNoise, report.Counts.Duplicate, report.Counts.WithIssue)
	for _, candidate := range report.Candidates {
		fmt.Fprintf(&b, "MEMORY: %s\n", candidate.MemoryID)
		fmt.Fprintf(&b, "  TITLE: %s\n", candidate.Title)
		fmt.Fprintf(&b, "  LAYER: %s\n", candidate.Layer)
		fmt.Fprintf(&b, "  STATUS: %s\n", candidate.Status)
		fmt.Fprintf(&b, "  NOISE: %s\n", candidate.NoiseLikelihood)
		if len(candidate.DuplicateMembers) > 0 {
			fmt.Fprintf(&b, "  DUPLICATES: %s (%s)\n", strings.Join(candidate.DuplicateMembers, ", "), candidate.DuplicateGroup)
		}
		if len(candidate.Sources) > 0 {
			fmt.Fprintf(&b, "  SOURCES: %s\n", strings.Join(candidate.Sources, ", "))
		}
		if len(candidate.SourceIssues) > 0 {
			fmt.Fprintf(&b, "  SOURCE_ISSUES: %s\n", strings.Join(candidate.SourceIssues, ", "))
		}
		fmt.Fprintf(&b, "  PROPOSED_RESOLUTION: %s\n", candidate.ProposedResolution)
		if candidate.ProposedDecisionID != "" {
			fmt.Fprintf(&b, "  PROPOSED_DECISION: %s\n", candidate.ProposedDecisionID)
		}
		if candidate.ProposedTargetID != "" {
			fmt.Fprintf(&b, "  PROPOSED_TARGET: %s\n", candidate.ProposedTargetID)
		}
		if candidate.ProposedCategory != "" {
			fmt.Fprintf(&b, "  PROPOSED_CATEGORY: %s\n", candidate.ProposedCategory)
		}
		if candidate.JournalState != "" {
			fmt.Fprintf(&b, "  JOURNAL: %s\n", candidate.JournalState)
		}
		fmt.Fprintln(&b)
	}
	if len(report.Candidates) == 0 {
		fmt.Fprintln(&b, "No legacy Decision Memories found.")
	}
	printPaged(cmd, b.String())
	return nil
}

func runDecisionMigrationApply(cmd *cobra.Command, args []string) error {
	memoryID, _ := cmd.Flags().GetString("memory")
	resolution, _ := cmd.Flags().GetString("resolution")
	decisionID, _ := cmd.Flags().GetString("decision-id")
	targetMemoryID, _ := cmd.Flags().GetString("target-memory")
	category, _ := cmd.Flags().GetString("category")
	reason, _ := cmd.Flags().GetString("reason")
	relatedDocs, _ := cmd.Flags().GetStringArray("doc")
	relatedTasks, _ := cmd.Flags().GetStringArray("task")
	acceptVerified, _ := cmd.Flags().GetBool("accept-verified")
	selection := decisionmigration.Selection{
		MemoryID:       memoryID,
		Resolution:     resolution,
		DecisionID:     decisionID,
		TargetMemoryID: targetMemoryID,
		Category:       category,
		Reason:         reason,
		RelatedDocs:    relatedDocs,
		RelatedTasks:   relatedTasks,
		AcceptVerified: acceptVerified,
	}
	result, err := decisionmigration.New(getStore()).Apply(cmd.Context(), []decisionmigration.Selection{selection})
	if isJSON(cmd) && result != nil {
		printJSON(result)
	}
	if err != nil {
		return fmt.Errorf("apply Decision Memory migration: %w", err)
	}
	for _, item := range result.Results {
		if item.DecisionID != "" {
			search.BestEffortIndexDecision(getStore(), item.DecisionID)
		}
		if !isJSON(cmd) {
			fmt.Printf("%s\n", RenderSuccess(fmt.Sprintf("Migrated memory %s with %s (state: %s, legacy excluded: %t)", item.MemoryID, item.Resolution, item.State, item.LegacyExcluded)))
		}
	}
	return nil
}

func runDecisionMigrationRollback(cmd *cobra.Command, args []string) error {
	result, err := decisionmigration.New(getStore()).Rollback(cmd.Context(), args[0])
	if err != nil {
		return fmt.Errorf("rollback Decision Memory migration: %w", err)
	}
	if result.DecisionID != "" {
		search.BestEffortIndexDecision(getStore(), result.DecisionID)
	}
	if isJSON(cmd) {
		printJSON(result)
		return nil
	}
	fmt.Println(RenderSuccess(fmt.Sprintf("Rolled back Decision Memory migration for %s", result.MemoryID)))
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
		Content:                body,
		Context:                context,
		Decision:               decisionText,
		AlternativesConsidered: alternatives,
		Consequences:           consequences,
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
	if decision.ReviewState != "" {
		fmt.Fprintf(&b, "REVIEW_STATE: %s\n", decision.ReviewState)
	}
	for _, blocker := range decision.ReviewBlockers {
		fmt.Fprintf(&b, "REVIEW_BLOCKER: %s\n", blocker)
	}
	fmt.Fprintf(&b, "REF: %s\n\n", models.DecisionRef(decision.ID))
	if decision.Content != "" {
		fmt.Fprintln(&b, decision.Content)
	}
	printPaged(cmd, b.String())
}

func init() {
	addDecisionInputFlags(decisionCreateCmd, true)
	decisionResolveCmd.Flags().String("target", "", "Existing Decision ID required by link_as_related or supersede_existing")
	decisionResolveCmd.Flags().String("replacement-id", "", "Existing verified replacement Decision ID for supersede_existing")

	decisionListCmd.Flags().String("status", "", "Filter by decision status")
	decisionListCmd.Flags().Bool("all-statuses", false, "Include draft, superseded, rejected, and archived decisions")
	decisionListCmd.Flags().String("tag", "", "Filter by tag")

	decisionLinkCmd.Flags().StringArray("doc", nil, "Related doc path (repeatable)")
	decisionLinkCmd.Flags().StringArray("task", nil, "Related task ID (repeatable)")
	decisionLinkCmd.Flags().StringArray("source", nil, "Source reference (repeatable)")
	decisionAcceptCmd.Flags().StringArray("supersede", nil, "Current decision ID replaced on acceptance (repeatable)")

	decisionMigrateApplyCmd.Flags().String("memory", "", "Legacy Decision Memory ID (required)")
	decisionMigrateApplyCmd.Flags().String("resolution", "", "Reviewed resolution: "+strings.Join(decisionmigration.AllowedResolutions, ", "))
	decisionMigrateApplyCmd.Flags().String("decision-id", "", "Existing or explicit System Decision ID")
	decisionMigrateApplyCmd.Flags().String("target-memory", "", "Migrated target Memory ID for duplicate consolidation")
	decisionMigrateApplyCmd.Flags().String("category", "", "Non-decision Memory category for reclassification")
	decisionMigrateApplyCmd.Flags().String("reason", "", "Reviewed archive/reject rationale")
	decisionMigrateApplyCmd.Flags().StringArray("doc", nil, "Related doc path for created/linked Decision (repeatable)")
	decisionMigrateApplyCmd.Flags().StringArray("task", nil, "Related completed task for verified acceptance (repeatable)")
	decisionMigrateApplyCmd.Flags().Bool("accept-verified", false, "Accept only if linked evidence passes System Decision verification")
	_ = decisionMigrateApplyCmd.MarkFlagRequired("memory")
	_ = decisionMigrateApplyCmd.MarkFlagRequired("resolution")
	decisionMigrateCmd.AddCommand(decisionMigratePreviewCmd, decisionMigrateApplyCmd, decisionMigrateRollbackCmd)

	decisionCmd.AddCommand(decisionCreateCmd)
	decisionCmd.AddCommand(decisionListCmd)
	decisionCmd.AddCommand(decisionInboxCmd)
	decisionCmd.AddCommand(decisionGetCmd)
	decisionCmd.AddCommand(decisionLinkCmd)
	decisionCmd.AddCommand(decisionSupersedeCmd)
	decisionCmd.AddCommand(decisionAcceptCmd)
	decisionCmd.AddCommand(decisionResolveCmd)
	decisionCmd.AddCommand(decisionMigrateCmd)

	rootCmd.AddCommand(decisionCmd)
}

func addDecisionInputFlags(cmd *cobra.Command, includeStatus bool) {
	if includeStatus {
		cmd.Flags().String("status", "", "Decision status; new System Decisions must be draft")
	}
	cmd.Flags().StringArrayP("tag", "t", nil, "Decision tag (repeatable)")
	cmd.Flags().StringArray("source", nil, "Source reference (repeatable)")
	cmd.Flags().StringArray("doc", nil, "Related doc path (repeatable)")
	cmd.Flags().StringArray("task", nil, "Related task ID (repeatable)")
	cmd.Flags().String("body", "", "Full markdown decision body")
	cmd.Flags().String("context", "", "Context section body")
	cmd.Flags().String("decision", "", "Decision section body")
	cmd.Flags().String("alternatives", "", "Alternatives Considered section body")
	cmd.Flags().String("consequences", "", "Consequences section body")
}
