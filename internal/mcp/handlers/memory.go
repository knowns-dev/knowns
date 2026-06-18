package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/howznguyen/knowns/internal/memoryreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// RegisterMemoryTool registers the consolidated persistent memory MCP tool.
func RegisterMemoryTool(s *server.MCPServer, getStore func() *storage.Store) {
	s.AddTool(
		mcp.NewTool("memory",
			mcp.WithDescription("Persistent memory operations. Use 'action' to specify: add, get, update, delete, list, promote, demote, cleanup, resolve."),
			mcp.WithString("action",
				mcp.Required(),
				mcp.Description("Action to perform"),
				mcp.Enum("add", "get", "update", "delete", "list", "promote", "demote", "cleanup", "resolve"),
			),
			mcp.WithString("id",
				mcp.Description("Memory entry ID (required for get, update, delete, promote, demote)"),
			),
			mcp.WithString("content",
				mcp.Description("Memory content in markdown (required for add)"),
			),
			mcp.WithString("title",
				mcp.Description("Memory title (add, update)"),
			),
			mcp.WithString("layer",
				mcp.Description("Memory layer: 'project' (default) or 'global' (add, list)"),
			),
			mcp.WithString("category",
				mcp.Description("Category: pattern, decision, convention, preference, etc. (add, update, list)"),
			),
			mcp.WithArray("tags",
				mcp.Description("Tags for the memory entry (add, update)"),
				mcp.WithStringItems(),
			),
			mcp.WithArray("sources",
				mcp.Description("Source refs for the memory entry (resolve)"),
				mcp.WithStringItems(),
			),
			mcp.WithString("status",
				mcp.Description("Memory status filter (list) or selected replacement status (resolve)"),
				mcp.Enum("proposed", "active", "stale", "deprecated", "archived", "rejected", "merged"),
			),
			mcp.WithString("confidence",
				mcp.Description("Memory confidence metadata (resolve)"),
				mcp.Enum("low", "medium", "high"),
			),
			mcp.WithNumber("ttlDays",
				mcp.Description("Memory TTL in days (resolve)"),
			),
			mcp.WithString("resolution",
				mcp.Description("Review resolution (resolve)"),
				mcp.Enum("update_existing", "archive_existing_create_new", "create_proposed", "reject_new", "merge_existing"),
			),
			mcp.WithString("targetId",
				mcp.Description("Existing memory ID selected for duplicate resolution"),
			),
			mcp.WithString("rejectedReason",
				mcp.Description("Reason recorded for reject_new resolution"),
			),
			mcp.WithBoolean("includeAll",
				mcp.Description("Include non-active memories in list results (default: false)"),
			),
			mcp.WithString("tag",
				mcp.Description("Filter by tag (list)"),
			),
			mcp.WithBoolean("dryRun",
				mcp.Description("Preview only without deleting (default: true) (delete)"),
			),
			mcp.WithArray("clear",
				mcp.Description("Explicitly clear string fields like title, content, or category (update)"),
				mcp.WithStringItems(),
			),
			mcp.WithNumber("olderThanDays",
				mcp.Description("Minimum stale age in days for cleanup candidates (default: 7)"),
			),
			mcp.WithNumber("limit",
				mcp.Description("Maximum cleanup candidates to return (default: 20)"),
			),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			action, err := req.RequireString("action")
			if err != nil {
				return errResult("action is required")
			}
			switch action {
			case "add":
				return handleMemoryAdd(getStore, req)
			case "get":
				return handleMemoryGet(getStore, req)
			case "update":
				return handleMemoryUpdate(getStore, req)
			case "delete":
				return handleMemoryDelete(getStore, req)
			case "list":
				return handleMemoryList(getStore, req)
			case "promote":
				return handleMemoryPromote(getStore, req)
			case "demote":
				return handleMemoryDemote(getStore, req)
			case "cleanup":
				return handleMemoryCleanup(getStore, req)
			case "resolve":
				return handleMemoryResolve(getStore, req)
			default:
				return errResultf("unknown memory action: %s", action)
			}
		},
	)
}

func handleMemoryAdd(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	content, err := req.RequireString("content")
	if err != nil {
		return errResult("content is required")
	}
	content = unescapeText(content)

	args := req.GetArguments()
	title, _ := stringArg(args, "title")
	layer, _ := stringArg(args, "layer")
	category, _ := stringArg(args, "category")
	tags, _ := stringSliceArg(args, "tags")

	if layer == "" {
		layer = models.MemoryLayerProject
	}
	if !models.ValidPersistentMemoryLayer(layer) {
		return errResult("layer must be 'project' or 'global'")
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

	result, err := memoryreview.New(store).Add(entry, memoryreview.AddOptions{})
	if err != nil {
		return errFailed("create memory", err)
	}
	if result.Status == memoryreview.ResultReviewRequired {
		out, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	indexMemoryReviewChanges(store, result.ChangedIDs)
	go notifyServer(store, "notify/refresh")

	out, _ := json.MarshalIndent(result.Memory, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleMemoryGet(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	id, err := req.RequireString("id")
	if err != nil {
		return errResult("id is required")
	}

	entry, err := store.Memory.Get(id)
	if err != nil || !models.ValidPersistentMemoryLayer(entry.Layer) {
		return errNotFound("memory", fmt.Errorf("memory %q not found", id))
	}

	out, _ := json.MarshalIndent(entry, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleMemoryList(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	args := req.GetArguments()
	layer, _ := stringArg(args, "layer")
	category, _ := stringArg(args, "category")
	tag, _ := stringArg(args, "tag")
	status, _ := stringArg(args, "status")
	includeAll := boolArg(args, "includeAll")

	if layer != "" && !models.ValidPersistentMemoryLayer(layer) {
		return errResult("layer must be 'project' or 'global'")
	}
	if status != "" && !models.ValidMemoryStatus(status) {
		return errResult("status must be a valid memory status")
	}

	entries, err := store.Memory.ListPersistent(layer)
	if err != nil {
		return errFailed("list memories", err)
	}

	if category != "" {
		filtered := entries[:0]
		for _, e := range entries {
			if e.Category == category {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
	}
	if tag != "" {
		filtered := entries[:0]
		for _, e := range entries {
			for _, t := range e.Tags {
				if t == tag {
					filtered = append(filtered, e)
					break
				}
			}
		}
		entries = filtered
	}
	if status != "" {
		filtered := entries[:0]
		for _, e := range entries {
			if e.Status == status {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
	} else if !includeAll {
		filtered := entries[:0]
		for _, e := range entries {
			if e.CurrentForDefaultRetrieval() {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
	}

	type memorySummary struct {
		ID        string   `json:"id"`
		Title     string   `json:"title"`
		Layer     string   `json:"layer"`
		Category  string   `json:"category,omitempty"`
		Status    string   `json:"status,omitempty"`
		Tags      []string `json:"tags,omitempty"`
		CreatedAt string   `json:"createdAt"`
		UpdatedAt string   `json:"updatedAt"`
	}
	summaries := make([]memorySummary, len(entries))
	for i, e := range entries {
		summaries[i] = memorySummary{
			ID:        e.ID,
			Title:     e.Title,
			Layer:     e.Layer,
			Category:  e.Category,
			Status:    e.Status,
			Tags:      e.Tags,
			CreatedAt: e.CreatedAt.Format(time.RFC3339),
			UpdatedAt: e.UpdatedAt.Format(time.RFC3339),
		}
	}

	out, _ := json.MarshalIndent(summaries, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleMemoryResolve(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
	status, _ := stringArg(args, "status")
	rejectedReason, _ := stringArg(args, "rejectedReason")

	candidate := memoryCandidateFromArgs(args)
	result, err := memoryreview.New(store).Resolve(candidate, memoryreview.ResolveOptions{
		Resolution:     resolution,
		TargetID:       targetID,
		Status:         status,
		RejectedReason: rejectedReason,
	})
	if err != nil {
		return errFailed("resolve memory review", err)
	}

	indexMemoryReviewChanges(store, result.ChangedIDs)
	go notifyServer(store, "notify/refresh")

	out, _ := json.MarshalIndent(result, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func memoryCandidateFromArgs(args map[string]any) *models.MemoryEntry {
	id, _ := stringArg(args, "id")
	title, _ := stringArg(args, "title")
	layer, _ := stringArg(args, "layer")
	category, _ := stringArg(args, "category")
	content, _ := textArg(args, "content")
	tags, _ := stringSliceArg(args, "tags")
	sources, _ := stringSliceArg(args, "sources")
	confidence, _ := stringArg(args, "confidence")
	ttlDays, _ := intArg(args, "ttlDays")
	return &models.MemoryEntry{
		ID:         id,
		Title:      title,
		Layer:      layer,
		Category:   category,
		Content:    content,
		Tags:       tags,
		Sources:    sources,
		Confidence: confidence,
		TTLDays:    ttlDays,
	}
}

func indexMemoryReviewChanges(store *storage.Store, ids []string) {
	for _, id := range ids {
		if id == "" {
			continue
		}
		search.BestEffortIndexMemory(store, id)
	}
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

func memoryEffectiveUpdatedAt(entry *models.MemoryEntry) time.Time {
	if !entry.UpdatedAt.IsZero() {
		return entry.UpdatedAt
	}
	return entry.CreatedAt
}

func cleanupMemoryCandidates(entries []*models.MemoryEntry, olderThanDays, limit int, now time.Time) []memoryCleanupCandidate {
	if olderThanDays <= 0 {
		olderThanDays = 7
	}
	if limit <= 0 {
		limit = 20
	}
	threshold := now.Add(-time.Duration(olderThanDays) * 24 * time.Hour)
	candidates := make([]memoryCleanupCandidate, 0)
	for _, entry := range entries {
		effective := memoryEffectiveUpdatedAt(entry)
		if effective.IsZero() || !effective.Before(threshold) {
			continue
		}
		ageDays := int(now.Sub(effective).Hours() / 24)
		candidates = append(candidates, memoryCleanupCandidate{
			ID:        entry.ID,
			Title:     entry.Title,
			Layer:     entry.Layer,
			Category:  entry.Category,
			Tags:      entry.Tags,
			Content:   entry.Content,
			CreatedAt: entry.CreatedAt,
			UpdatedAt: entry.UpdatedAt,
			AgeDays:   ageDays,
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

func handleMemoryCleanup(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	args := req.GetArguments()
	layer, _ := stringArg(args, "layer")
	if layer == "" {
		layer = models.MemoryLayerProject
	}
	if !models.ValidPersistentMemoryLayer(layer) {
		return errResult("layer must be 'project' or 'global'")
	}
	olderThanDays := 7
	if v, ok := intArg(args, "olderThanDays"); ok && v > 0 {
		olderThanDays = v
	}
	limit := 20
	if v, ok := intArg(args, "limit"); ok && v > 0 {
		limit = v
	}

	entries, err := store.Memory.ListPersistent(layer)
	if err != nil {
		return errFailed("list memories", err)
	}
	result := cleanupMemoryCandidates(entries, olderThanDays, limit, time.Now().UTC())
	out, _ := json.MarshalIndent(result, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleMemoryUpdate(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	id, err := req.RequireString("id")
	if err != nil {
		return errResult("id is required")
	}

	entry, err := store.Memory.Get(id)
	if err != nil || !models.ValidPersistentMemoryLayer(entry.Layer) {
		return errNotFound("memory", fmt.Errorf("memory %q not found", id))
	}

	args := req.GetArguments()
	clearFields := stringSetArg(args, "clear")
	if clearFields["title"] {
		entry.Title = ""
	} else if v, ok := stringArg(args, "title"); ok && v != "" {
		entry.Title = v
	}
	if clearFields["content"] {
		entry.Content = ""
	} else if v, ok := textArg(args, "content"); ok && v != "" {
		entry.Content = v
	}
	if clearFields["category"] {
		entry.Category = ""
	} else if v, ok := stringArg(args, "category"); ok && v != "" {
		entry.Category = v
	}
	if v, ok := stringSliceArg(args, "tags"); ok {
		entry.Tags = v
	}

	entry.UpdatedAt = time.Now().UTC()

	if err := store.Memory.Update(entry); err != nil {
		return errFailed("update memory", err)
	}

	search.BestEffortIndexMemory(store, entry.ID)
	go notifyServer(store, "notify/refresh")

	out, _ := json.MarshalIndent(entry, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleMemoryDelete(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	id, err := req.RequireString("id")
	if err != nil {
		return errResult("id is required")
	}

	entry, err := store.Memory.Get(id)
	if err != nil || !models.ValidPersistentMemoryLayer(entry.Layer) {
		return errNotFound("memory", fmt.Errorf("memory %q not found", id))
	}

	args := req.GetArguments()
	dryRun := true
	if v, ok := args["dryRun"]; ok {
		if b, ok := v.(bool); ok {
			dryRun = b
		}
	}

	if dryRun {
		result := map[string]any{
			"dryRun":  true,
			"message": fmt.Sprintf("Would delete memory: %s (%s, layer: %s)", entry.ID, entry.Title, entry.Layer),
		}
		out, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	if err := store.Memory.Delete(id); err != nil {
		return errFailed("delete memory", err)
	}

	search.BestEffortRemoveMemory(store, id)
	go notifyServer(store, "notify/refresh")

	result := map[string]any{
		"deleted": true,
		"message": fmt.Sprintf("Deleted memory: %s (%s)", entry.ID, entry.Title),
	}
	out, _ := json.MarshalIndent(result, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleMemoryPromote(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	id, err := req.RequireString("id")
	if err != nil {
		return errResult("id is required")
	}

	entry, err := store.Memory.PromotePersistent(id)
	if err != nil {
		return errResult(err.Error())
	}

	search.BestEffortIndexMemory(store, entry.ID)
	go notifyServer(store, "notify/refresh")

	out, _ := json.MarshalIndent(entry, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleMemoryDemote(getStore func() *storage.Store, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		return noProjectError()
	}

	id, err := req.RequireString("id")
	if err != nil {
		return errResult("id is required")
	}

	entry, err := store.Memory.DemotePersistent(id)
	if err != nil {
		return errResult(err.Error())
	}

	search.BestEffortIndexMemory(store, entry.ID)
	go notifyServer(store, "notify/refresh")

	out, _ := json.MarshalIndent(entry, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}
