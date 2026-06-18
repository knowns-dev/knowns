package handlers

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/howznguyen/knowns/internal/decisionreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

// RegisterDecisionTool registers first-class Decision lifecycle operations.
func RegisterDecisionTool(s toolRegistrar, getStore func() *storage.Store) {
	s.AddTool(
		mcp.NewTool("decision",
			mcp.WithDescription("Decision lifecycle operations. Use 'action' to specify: create, list, get, link, supersede, resolve."),
			mcp.WithString("action",
				mcp.Required(),
				mcp.Description("Action to perform"),
				mcp.Enum("create", "list", "get", "link", "supersede", "resolve"),
			),
			mcp.WithString("id",
				mcp.Description("Decision ID (required for get/link, old decision for supersede when oldId is omitted)"),
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
			mcp.WithString("resolution",
				mcp.Description("Review resolution (resolve)"),
				mcp.Enum("supersede_existing", "create_draft", "link_as_related", "reject_new"),
			),
			mcp.WithString("tag",
				mcp.Description("Filter by tag (list)"),
			),
			mcp.WithBoolean("includeAll",
				mcp.Description("Include non-current decisions in list results (default: false)"),
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
			case "supersede":
				return handleDecisionSupersede(getStore, req)
			case "resolve":
				return handleDecisionResolve(getStore, req)
			default:
				return errResultf("unknown decision action: %s", action)
			}
		},
	)
	registerHelp(s, "decision", HelpEntry{
		When: "Use for Decision create/list/get/link/supersede lifecycle operations.",
		Params: map[string]string{
			"action":       "Required: create, list, get, link, supersede, resolve.",
			"title":        "Required for create.",
			"id":           "Required for get/link; accepted as old decision ID for supersede if oldId is omitted.",
			"oldId/newId":  "Required pair for supersede.",
			"resolution":   "Decision review resolution: supersede_existing, create_draft, link_as_related, reject_new.",
			"sources/docs": "Sources or related docs/tasks make create default to accepted; otherwise draft.",
		},
	})
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
	body, _ := textArg(args, "body")
	context, _ := textArg(args, "context")
	decisionText, _ := textArg(args, "decision")
	alternatives, _ := textArg(args, "alternatives")
	consequences, _ := textArg(args, "consequences")
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
		return decisionResult(result)
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
	return decisionResult(map[string]any{
		"superseded": oldDecision,
		"current":    newDecision,
	})
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
	if targetID == "" {
		targetID, _ = stringArg(args, "id")
	}
	replacementID, _ := stringArg(args, "replacementId")
	status, _ := stringArg(args, "status")
	candidate := decisionCandidateFromArgs(args)
	if targetID != "" && candidate.ID == targetID {
		candidate.ID = ""
	}

	result, err := decisionreview.New(store).Resolve(candidate, decisionreview.ResolveOptions{
		Resolution:    resolution,
		TargetID:      targetID,
		ReplacementID: replacementID,
		Status:        status,
	})
	if err != nil {
		return errFailed("resolve decision review", err)
	}
	return decisionResult(result)
}

func decisionCandidateFromArgs(args map[string]any) *models.DecisionEntry {
	id, _ := stringArg(args, "id")
	title, _ := stringArg(args, "title")
	status, _ := stringArg(args, "status")
	body, _ := textArg(args, "body")
	context, _ := textArg(args, "context")
	decisionText, _ := textArg(args, "decision")
	alternatives, _ := textArg(args, "alternatives")
	consequences, _ := textArg(args, "consequences")
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
