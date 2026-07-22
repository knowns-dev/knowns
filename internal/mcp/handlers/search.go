package handlers

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

// RegisterSearchTool registers the consolidated search and retrieval MCP tool.
// Note: reindex_search has been removed — reindexing is handled automatically
// or via the CLI command.
func RegisterSearchTool(s toolRegistrar, getStore func() *storage.Store) {
	s.AddTool(
		mcp.NewTool("search",
			mcp.WithDescription(`Search and retrieval operations. Use 'action' to specify: search, retrieve, resolve.

- search: Search docs, tasks, memories, and decisions. Required: query. Optional: type (all, task, doc, memory, decision), mode (hybrid, semantic, keyword), limit, status, priority, assignee, label, tag, includeHistorical. Returns: ranked search results with entity type, path or ID, title, snippet, and score.
- retrieve: Build a context pack from relevant docs, tasks, memories, and decisions. Required: query. Optional: sourceTypes, mode, limit, expandReferences, status, priority, assignee, label, tag, includeHistorical. Returns: assembled context items with citations, metadata, and optional expanded references.
- resolve: Traverse semantic references and graph relationships. Required: ref. Optional: direction (outbound, inbound, both), depth (1-3), relationTypes, entityTypes, limit. Returns: resolved root entity and related entities/relations matching traversal filters.
`),
			mcp.WithString("action",
				mcp.Required(),
				mcp.Description("Action to perform"),
				mcp.Enum("search", "retrieve", "resolve"),
			),
			// search + retrieve params
			mcp.WithString("query",
				mcp.Description("Search/retrieval query (required for search, retrieve)"),
			),
			mcp.WithString("type",
				mcp.Description("Search type: all, task, doc, memory, or decision (search)"),
				mcp.Enum("all", "task", "doc", "memory", "decision"),
			),
			mcp.WithString("mode",
				mcp.Description("Search mode: hybrid (semantic + keyword), semantic only, or keyword only (default: hybrid)"),
				mcp.Enum("hybrid", "semantic", "keyword"),
			),
			mcp.WithNumber("limit",
				mcp.Description("Limit results (default: 20)"),
			),
			mcp.WithString("status",
				mcp.Description("Filter tasks, memories, or decisions by status"),
			),
			mcp.WithString("priority",
				mcp.Description("Filter tasks by priority"),
			),
			mcp.WithString("assignee",
				mcp.Description("Filter tasks by assignee"),
			),
			mcp.WithString("label",
				mcp.Description("Filter tasks by label"),
			),
			mcp.WithString("tag",
				mcp.Description("Filter docs, memories, or decisions by tag"),
			),
			mcp.WithBoolean("includeHistorical",
				mcp.Description("Include historical entities with status metadata; Task retrieval adds done and archived Tasks"),
			),
			// retrieve-specific params
			mcp.WithArray("sourceTypes",
				mcp.Description("Optional source types: doc, task, memory, decision (retrieve)"),
				mcp.WithStringEnumItems([]string{"doc", "task", "memory", "decision"}),
			),
			mcp.WithBoolean("expandReferences",
				mcp.Description("Whether to include linked docs/tasks/memories as expanded context (retrieve)"),
			),
			// resolve params
			mcp.WithString("ref",
				mcp.Description("Semantic reference expression, e.g. @doc/guides/setup{implements} (required for resolve)"),
			),
			// structural traversal params (resolve)
			mcp.WithString("direction",
				mcp.Description("Traversal direction from root entity: \"outbound\" (default), \"inbound\", or \"both\" (resolve)"),
				mcp.Enum("outbound", "inbound", "both"),
			),
			mcp.WithNumber("depth",
				mcp.Description("Max traversal hops, 1–3 (default: 1) (resolve)"),
			),
			mcp.WithString("relationTypes",
				mcp.Description("Filter by relation kinds, comma-separated (resolve)"),
			),
			mcp.WithString("entityTypes",
				mcp.Description("Filter result entities by kind, comma-separated (resolve)"),
			),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			action, err := req.RequireString("action")
			if err != nil {
				return errResult("action is required")
			}
			switch action {
			case "search":
				return handleSearch(getStore, req)
			case "retrieve":
				return handleRetrieve(getStore, req)
			case "resolve":
				return handleResolve(getStore, req)
			default:
				return errResultf("unknown search action: %s", action)
			}
		},
	)

	registerHelp(s, "search.search", HelpEntry{When: "Discover relevant docs, tasks, memories, or decisions by query before reading detailed context.", Params: map[string]string{"query": "required — search terms", "type": "all | task | doc | memory | decision", "mode": "hybrid | semantic | keyword", "limit": "maximum result count", "status": "filter tasks, memories, or decisions by status", "priority": "filter tasks by priority", "assignee": "filter tasks by assignee", "label": "filter tasks by label", "tag": "filter docs, memories, or decisions by tag", "includeHistorical": "include historical entities, including archived Tasks"}, Why: "Use search for discovery. Use retrieve when you need assembled context with citations.", Examples: []string{`search({ action: "search", query: "auth patterns", type: "doc", limit: 5 })`}})
	registerHelp(s, "search.retrieve", HelpEntry{When: "Build an assembled context pack from relevant docs, tasks, memories, and decisions for planning or synthesis.", Params: map[string]string{"query": "required — retrieval query", "sourceTypes": "optional list: doc, task, memory, decision", "mode": "hybrid | semantic | keyword", "limit": "maximum item count", "expandReferences": "include linked docs/tasks/memories/decisions", "status": "filter tasks, memories, or decisions by status", "priority": "filter tasks by priority", "assignee": "filter tasks by assignee", "label": "filter tasks by label", "tag": "filter docs, memories, or decisions by tag", "includeHistorical": "include historical entities; Task retrieval adds done and archived Tasks"}, Why: "Use retrieve after search when you need cited, expanded context rather than a ranked result list."})
	registerHelp(s, "search.resolve", HelpEntry{When: "Traverse semantic refs and graph relationships from a @doc, @task, or @template reference.", Params: map[string]string{"ref": "required — semantic reference expression", "direction": "outbound | inbound | both", "depth": "max hops 1-3", "relationTypes": "comma-separated relation kinds", "entityTypes": "comma-separated entity kinds", "limit": "maximum result count"}, Examples: []string{`search({ action: "resolve", ref: "@doc/specs/auth{implements}", depth: 2 })`}})
}

func handleSearch(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	query, err := req.RequireString("query")
	if err != nil {
		return errResult(err.Error())
	}

	args := req.GetArguments()
	searchType := "all"
	if v, ok := stringArg(args, "type"); ok {
		searchType = v
	}
	mode, _ := stringArg(args, "mode")
	statusFilter, _ := stringArg(args, "status")
	priorityFilter, _ := stringArg(args, "priority")
	assigneeFilter, _ := stringArg(args, "assignee")
	labelFilter, _ := stringArg(args, "label")
	tagFilter, _ := stringArg(args, "tag")
	includeHistorical := boolArg(args, "includeHistorical")
	limit := 20
	if v, ok := intArg(args, "limit"); ok && v > 0 {
		limit = v
	}

	opts := search.SearchOptions{
		Query:             query,
		Type:              searchType,
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
		return errResult(err.Error())
	}
	results := response.Results
	if results == nil {
		results = []models.SearchResult{}
	}

	// If results are empty, include project context so the caller can verify
	// the correct project is active.
	if len(results) == 0 {
		wrapper := map[string]any{
			"results":      results,
			"_projectRoot": store.Root,
			"_hint":        "Search returned 0 results. Verify the active project is correct via project({ action: \"current\" }). Use project({ action: \"set\" }) to switch if needed.",
		}
		if response.Runtime != nil {
			wrapper["_runtime"] = response.Runtime
		}
		out, _ := json.MarshalIndent(wrapper, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	normalizeSearchScores(results)
	out, _ := json.MarshalIndent(results, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleRetrieve(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	query, err := req.RequireString("query")
	if err != nil {
		return errResult(err.Error())
	}

	args := req.GetArguments()
	mode, _ := stringArg(args, "mode")
	statusFilter, _ := stringArg(args, "status")
	priorityFilter, _ := stringArg(args, "priority")
	assigneeFilter, _ := stringArg(args, "assignee")
	labelFilter, _ := stringArg(args, "label")
	tagFilter, _ := stringArg(args, "tag")
	includeHistorical := boolArg(args, "includeHistorical")
	limit := 20
	if v, ok := intArg(args, "limit"); ok && v > 0 {
		limit = v
	}
	expandRefs := boolArg(args, "expandReferences")
	sourceTypes := stringArrayArg(args, "sourceTypes")

	response, runtimeMeta, err := search.RetrieveWithRuntime(store, models.RetrievalOptions{
		Query:             query,
		Mode:              mode,
		Limit:             limit,
		SourceTypes:       sourceTypes,
		ExpandReferences:  expandRefs,
		Status:            statusFilter,
		Priority:          priorityFilter,
		Assignee:          assigneeFilter,
		Label:             labelFilter,
		Tag:               tagFilter,
		IncludeHistorical: includeHistorical,
	})
	if err != nil {
		return errResult(err.Error())
	}

	normalizeRetrievalScores(response.Candidates)
	if runtimeMeta != nil {
		wrapper := map[string]any{
			"query":       response.Query,
			"mode":        response.Mode,
			"candidates":  response.Candidates,
			"contextPack": response.ContextPack,
			"_runtime":    runtimeMeta,
		}
		out, _ := json.MarshalIndent(wrapper, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}
	out, _ := json.MarshalIndent(response, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func normalizeSearchScores(results []models.SearchResult) {
	max := maxSearchScore(results)
	for i := range results {
		results[i].Score = scoreToNorm(results[i].Score, max)
	}
}

func normalizeRetrievalScores(candidates []models.RetrievalCandidate) {
	max := maxRetrievalScore(candidates)
	for i := range candidates {
		candidates[i].Score = scoreToNorm(candidates[i].Score, max)
	}
}

func maxSearchScore(results []models.SearchResult) float64 {
	max := 0.0
	for _, r := range results {
		if r.Score > max {
			max = r.Score
		}
	}
	return max
}

func maxRetrievalScore(candidates []models.RetrievalCandidate) float64 {
	max := 0.0
	for _, c := range candidates {
		if c.Score > max {
			max = c.Score
		}
	}
	return max
}

func scoreToNorm(score, maxScore float64) float64 {
	if maxScore <= 0 {
		return 0
	}
	n := score / maxScore
	if n > 1 {
		return 1
	}
	if n < 0.01 && score > 0 {
		return 0.01
	}
	return float64(int(n*10000+0.5)) / 10000
}

func handleResolve(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	raw, err := req.RequireString("ref")
	if err != nil {
		return errResult(err.Error())
	}

	args := req.GetArguments()

	// Check for structural traversal params.
	params := models.StructuralParams{}
	if v, ok := stringArg(args, "direction"); ok {
		params.Direction = v
	}
	if v, ok := intArg(args, "depth"); ok {
		params.Depth = v
	}
	if v, ok := stringArg(args, "relationTypes"); ok && v != "" {
		params.RelationTypes = splitCommaSeparated(v)
	}
	if v, ok := stringArg(args, "entityTypes"); ok && v != "" {
		params.EntityTypes = splitCommaSeparated(v)
	}

	// If structural params are present, use structural traversal.
	if params.IsStructural() {
		result, err := store.StructuralResolve(raw, params)
		if err != nil {
			return errResult(err.Error())
		}
		out, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	// Otherwise, use the existing simple resolution.
	out, err := resolveReferenceJSON(store, raw)
	if err != nil {
		return errResult(err.Error())
	}
	return mcp.NewToolResultText(out), nil
}

// splitCommaSeparated splits a comma-separated string into trimmed non-empty parts.
func splitCommaSeparated(s string) []string {
	parts := strings.Split(s, ",")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	return result
}

func resolveReferenceJSON(store *storage.Store, raw string) (string, error) {
	resolution, err := store.ResolveRawReference(raw)
	if err != nil {
		return "", err
	}
	out, _ := json.MarshalIndent(resolution, "", "  ")
	return string(out), nil
}

func stringArrayArg(args map[string]interface{}, key string) []string {
	v, ok := args[key]
	if !ok {
		return nil
	}
	raw, ok := v.([]interface{})
	if !ok {
		return nil
	}
	values := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok && s != "" {
			values = append(values, s)
		}
	}
	return values
}
