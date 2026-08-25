package handlers

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/howznguyen/knowns/internal/decisionmigration"
	"github.com/howznguyen/knowns/internal/decisionreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

// RegisterDecisionTool registers first-class Decision lifecycle operations.
func RegisterDecisionTool(s toolRegistrar, getStore func() *storage.Store) {
	s.AddTool(
		mcp.NewTool("decision",
			mcp.WithDescription("System Decision lifecycle and reviewed Legacy Decision Memory migration operations."),
			mcp.WithString("action",
				mcp.Required(),
				mcp.Description("Action to perform"),
				mcp.Enum("create", "list", "get", "link", "accept", "supersede", "review_inbox", "resolve", "migration_preview", "migration_apply", "migration_rollback"),
			),
			mcp.WithString("id",
				mcp.Description("Decision ID (required for get/link/accept, old decision for supersede when oldId is omitted)"),
			),
			mcp.WithString("candidateId",
				mcp.Description("Persisted draft Decision candidate ID (resolve)"),
			),
			mcp.WithString("oldId",
				mcp.Description("Older decision ID to mark superseded (supersede)"),
			),
			mcp.WithString("newId",
				mcp.Description("Replacement decision ID (supersede)"),
			),
			mcp.WithString("targetId",
				mcp.Description("Existing decision ID selected for review resolution"),
			),
			mcp.WithString("replacementId",
				mcp.Description("Existing replacement decision ID for supersede_existing resolution"),
			),
			mcp.WithString("title",
				mcp.Description("Decision title (create)"),
			),
			mcp.WithString("status",
				mcp.Description("Decision status filter (list) or explicit create status"),
				mcp.Enum("draft", "accepted", "superseded", "rejected", "archived"),
			),
			mcp.WithString("body",
				mcp.Description("Full markdown body (create)"),
			),
			mcp.WithString("context",
				mcp.Description("Context section body (create)"),
			),
			mcp.WithString("decision",
				mcp.Description("Decision section body (create)"),
			),
			mcp.WithString("alternatives",
				mcp.Description("Alternatives Considered section body (create)"),
			),
			mcp.WithString("consequences",
				mcp.Description("Consequences section body (create)"),
			),
			mcp.WithArray("tags",
				mcp.Description("Decision tags (create)"),
				mcp.WithStringItems(),
			),
			mcp.WithArray("sources",
				mcp.Description("Source refs (create/link)"),
				mcp.WithStringItems(),
			),
			mcp.WithArray("relatedDocs",
				mcp.Description("Related doc paths (create/link)"),
				mcp.WithStringItems(),
			),
			mcp.WithArray("relatedTasks",
				mcp.Description("Related task IDs (create/link)"),
				mcp.WithStringItems(),
			),
			mcp.WithArray("supersedes",
				mcp.Description("Current Decision IDs to supersede atomically when accepting a verified draft"),
				mcp.WithStringItems(),
			),
			mcp.WithString("resolution",
				mcp.Description("Review resolution (resolve)"),
				mcp.Enum("accept_new", "supersede_existing", "create_draft", "link_as_related", "reject_new"),
			),
			mcp.WithString("tag",
				mcp.Description("Filter by tag (list)"),
			),
			mcp.WithBoolean("includeAll",
				mcp.Description("Include non-current decisions in list results (default: false)"),
			),
			mcp.WithString("memoryId",
				mcp.Description("Legacy Decision Memory ID (migration_apply/migration_rollback)"),
			),
			mcp.WithString("migrationResolution",
				mcp.Description("Explicit reviewed Legacy Decision Memory resolution (migration_apply)"),
				mcp.Enum("create_decision", "link_existing", "consolidate_duplicate", "reclassify", "archive_noise", "reject_noise", "leave_unchanged"),
			),
			mcp.WithString("decisionId",
				mcp.Description("Existing or explicit System Decision ID (migration_apply)"),
			),
			mcp.WithString("targetMemoryId",
				mcp.Description("Previously migrated target Memory ID for duplicate consolidation"),
			),
			mcp.WithString("category",
				mcp.Description("Non-decision Memory category for reclassification"),
			),
			mcp.WithString("reason",
				mcp.Description("Reviewed archive/reject rationale"),
			),
			mcp.WithBoolean("acceptVerified",
				mcp.Description("Accept a migrated draft only when linked evidence passes verification"),
			),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			action, err := req.RequireString("action")
			if err != nil {
				return errResult("action is required")
			}
			switch action {
			case "create":
				return handleDecisionCreate(getStore, req)
			case "list":
				return handleDecisionList(getStore, req)
			case "get":
				return handleDecisionGet(getStore, req)
			case "link":
				return handleDecisionLink(getStore, req)
			case "accept":
				return handleDecisionAccept(getStore, req)
			case "supersede":
				return handleDecisionSupersede(getStore, req)
			case "review_inbox":
				return handleDecisionReviewInbox(getStore)
			case "resolve":
				return handleDecisionResolve(getStore, req)
			case "migration_preview":
				return handleDecisionMigrationPreview(getStore)
			case "migration_apply":
				return handleDecisionMigrationApply(ctx, getStore, req)
			case "migration_rollback":
				return handleDecisionMigrationRollback(ctx, getStore, req)
			default:
				return errResultf("unknown decision action: %s", action)
			}
		},
	)
	registerHelp(s, "decision", HelpEntry{
		When: "Use for first-class System Decision lifecycle operations and explicit reviewed Legacy Decision Memory migration.",
		Params: map[string]string{
			"action":       "Required: create, list, get, link, accept, supersede, review_inbox, resolve, migration_preview, migration_apply, migration_rollback.",
			"title":        "Required for create.",
			"id":           "Required for get/link; accepted as old decision ID for supersede if oldId is omitted.",
			"candidateId":  "Required for persisted candidate resolution; never use targetId as the candidate.",
			"oldId/newId":  "Required pair for supersede.",
			"resolution":   "Decision review resolution: accept_new, supersede_existing, link_as_related, reject_new; create_draft remains a compatibility no-op for an existing draft.",
			"sources/docs": "Sources and related docs/tasks remain evidence links; every create defaults to draft.",
			"accept":       "Marks a draft verified and accepted only after readable sources and completed linked tasks pass validation; optional supersedes are committed atomically.",
			"migration":    "Preview is read-only. Apply requires memoryId plus migrationResolution. Rollback requires memoryId and refuses unsafe post-migration drift.",
		},
		Flow: "Use migration_preview first, review one candidate, then migration_apply with an explicit resolution. Never create Memory category decision.",
	})
}

func handleDecisionReviewInbox(getStore func() *storage.Store) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}
	candidates, err := decisionreview.New(store).ReviewCandidates()
	if err != nil {
		return errFailed("list Decision review inbox", err)
	}
	return decisionResult(candidates)
}

func handleDecisionMigrationPreview(getStore func() *storage.Store) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}
	report, err := decisionmigration.New(store).Preview()
	if err != nil {
		return errFailed("preview Decision Memory migration", err)
	}
	return decisionResult(report)
}

func handleDecisionMigrationApply(ctx context.Context, getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}
	args := req.GetArguments()
	memoryID, _ := stringArg(args, "memoryId")
	resolution, _ := stringArg(args, "migrationResolution")
	decisionID, _ := stringArg(args, "decisionId")
	targetMemoryID, _ := stringArg(args, "targetMemoryId")
	category, _ := stringArg(args, "category")
	reason, _ := stringArg(args, "reason")
	relatedDocs, _ := stringSliceArg(args, "relatedDocs")
	relatedTasks, _ := stringSliceArg(args, "relatedTasks")
	result, err := decisionmigration.New(store).Apply(ctx, []decisionmigration.Selection{{
		MemoryID:       memoryID,
		Resolution:     resolution,
		DecisionID:     decisionID,
		TargetMemoryID: targetMemoryID,
		Category:       category,
		Reason:         reason,
		RelatedDocs:    relatedDocs,
		RelatedTasks:   relatedTasks,
		AcceptVerified: boolArg(args, "acceptVerified"),
	}})
	if err != nil {
		return errFailed("apply Decision Memory migration", err)
	}
	for _, item := range result.Results {
		if item.DecisionID != "" {
			search.BestEffortIndexDecision(store, item.DecisionID)
		}
	}
	return decisionResult(result)
}

func handleDecisionMigrationRollback(ctx context.Context, getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}
	memoryID, _ := stringArg(req.GetArguments(), "memoryId")
	result, err := decisionmigration.New(store).Rollback(ctx, memoryID)
	if err != nil {
		return errFailed("rollback Decision Memory migration", err)
	}
	if result.DecisionID != "" {
		search.BestEffortIndexDecision(store, result.DecisionID)
	}
	return decisionResult(result)
}

func handleDecisionCreate(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}
	args := req.GetArguments()
	title, _ := stringArg(args, "title")
	if title == "" {
		return errResult("title is required")
	}
	status, _ := stringArg(args, "status")
	if status != "" && !models.ValidDecisionStatus(status) {
		return errResult("status must be a valid decision status")
	}
	body, _ := stringArg(args, "body")
	context, _ := stringArg(args, "context")
	decisionText, _ := stringArg(args, "decision")
	alternatives, _ := stringArg(args, "alternatives")
	consequences, _ := stringArg(args, "consequences")
	tags, _ := stringSliceArg(args, "tags")
	sources, _ := stringSliceArg(args, "sources")
	relatedDocs, _ := stringSliceArg(args, "relatedDocs")
	relatedTasks, _ := stringSliceArg(args, "relatedTasks")

	decision := &models.DecisionEntry{
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
	}
	result, err := decisionreview.New(store).Add(decision, decisionreview.AddOptions{})
	if err != nil {
		return errFailed("create decision", err)
	}
	if result.Status == decisionreview.ResultReviewRequired {
		if result.Candidate != nil {
			search.BestEffortIndexDecision(store, result.Candidate.ID)
		}
		return decisionResult(result)
	}
	if result.Decision != nil {
		search.BestEffortIndexDecision(store, result.Decision.ID)
	}
	return decisionResult(result.Decision)
}

func handleDecisionList(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}
	args := req.GetArguments()
	status, _ := stringArg(args, "status")
	tag, _ := stringArg(args, "tag")
	includeAll := boolArg(args, "includeAll")
	if status != "" && !models.ValidDecisionStatus(status) {
		return errResult("status must be a valid decision status")
	}
	decisions, err := store.Decisions.List()
	if err != nil {
		return errFailed("list decisions", err)
	}
	filtered := decisions[:0]
	for _, decision := range decisions {
		if status != "" {
			if decision.Status != status {
				continue
			}
		} else if !includeAll && !decision.CurrentForDefaultRetrieval() {
			continue
		}
		if tag != "" && !containsString(decision.Tags, tag) {
			continue
		}
		filtered = append(filtered, decision)
	}
	return decisionResult(filtered)
}

func handleDecisionGet(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}
	id, err := req.RequireString("id")
	if err != nil {
		return errResult("id is required")
	}
	decision, err := store.Decisions.Get(id)
	if err != nil {
		return errNotFound("decision", fmt.Errorf("decision %q not found", id))
	}
	return decisionResult(decision)
}

func handleDecisionLink(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}
	id, err := req.RequireString("id")
	if err != nil {
		return errResult("id is required")
	}
	args := req.GetArguments()
	docs, _ := stringSliceArg(args, "relatedDocs")
	tasks, _ := stringSliceArg(args, "relatedTasks")
	sources, _ := stringSliceArg(args, "sources")
	decision, err := store.Decisions.Link(id, docs, tasks, sources)
	if err != nil {
		return errFailed("link decision", err)
	}
	if decision.Status == models.DecisionStatusDraft {
		decision, err = decisionreview.New(store).RefreshCandidate(decision.ID)
		if err != nil {
			return errFailed("refresh Decision candidate", err)
		}
	}
	search.BestEffortIndexDecision(store, decision.ID)
	return decisionResult(decision)
}

func handleDecisionSupersede(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}
	args := req.GetArguments()
	oldID, _ := stringArg(args, "oldId")
	if oldID == "" {
		oldID, _ = stringArg(args, "id")
	}
	newID, _ := stringArg(args, "newId")
	oldDecision, newDecision, err := store.Decisions.Supersede(oldID, newID)
	if err != nil {
		return errFailed("supersede decision", err)
	}
	search.BestEffortIndexDecision(store, oldDecision.ID)
	search.BestEffortIndexDecision(store, newDecision.ID)
	return decisionResult(map[string]any{
		"superseded": oldDecision,
		"current":    newDecision,
	})
}

func handleDecisionAccept(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}
	id, err := req.RequireString("id")
	if err != nil {
		return errResult("id is required")
	}
	supersedes, _ := stringSliceArg(req.GetArguments(), "supersedes")
	result, err := decisionreview.New(store).Accept(id, decisionreview.AcceptOptions{Supersedes: supersedes})
	if err != nil {
		return errFailed("accept decision", err)
	}
	for _, changedID := range result.ChangedIDs {
		search.BestEffortIndexDecision(store, changedID)
	}
	return decisionResult(result)
}

func handleDecisionResolve(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}
	args := req.GetArguments()
	resolution, ok := stringArg(args, "resolution")
	if !ok || resolution == "" {
		return errResult("resolution is required")
	}
	targetID, _ := stringArg(args, "targetId")
	candidateID, _ := stringArg(args, "candidateId")
	replacementID, _ := stringArg(args, "replacementId")
	status, _ := stringArg(args, "status")
	candidate := decisionCandidateFromArgs(args)

	result, err := decisionreview.New(store).Resolve(candidate, decisionreview.ResolveOptions{
		CandidateID:   candidateID,
		Resolution:    resolution,
		TargetID:      targetID,
		ReplacementID: replacementID,
		Status:        status,
	})
	if err != nil {
		return errFailed("resolve decision review", err)
	}
	for _, id := range result.ChangedIDs {
		search.BestEffortIndexDecision(store, id)
	}
	return decisionResult(result)
}

func decisionCandidateFromArgs(args map[string]any) *models.DecisionEntry {
	id, _ := stringArg(args, "id")
	title, _ := stringArg(args, "title")
	status, _ := stringArg(args, "status")
	body, _ := stringArg(args, "body")
	context, _ := stringArg(args, "context")
	decisionText, _ := stringArg(args, "decision")
	alternatives, _ := stringArg(args, "alternatives")
	consequences, _ := stringArg(args, "consequences")
	tags, _ := stringSliceArg(args, "tags")
	sources, _ := stringSliceArg(args, "sources")
	relatedDocs, _ := stringSliceArg(args, "relatedDocs")
	relatedTasks, _ := stringSliceArg(args, "relatedTasks")
	return &models.DecisionEntry{
		ID:                     id,
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
	}
}

func decisionResult(v any) (*mcp.CallToolResult, error) {
	out, _ := json.MarshalIndent(v, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}
