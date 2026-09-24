package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

// tombstoneRestoreResult previews or performs the reactivation of a Task or
// Doc whose history head is a delete tombstone. ref is a Task ID or a Doc path.
func tombstoneRestoreResult(ctx context.Context, store *storage.Store, entityType, ref string, execute bool) (*mcp.CallToolResult, error) {
	plan, err := store.PlanTombstoneRestore(entityType, ref)
	if err != nil {
		return errFailed("plan restore", err)
	}
	if !execute {
		out, _ := json.MarshalIndent(map[string]any{"execute": false, "plan": plan}, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}
	result, err := store.RestoreTombstoned(ctx, plan, "mcp")
	if err != nil {
		if errors.Is(err, storage.ErrNotTombstoned) && entityType == "doc" {
			return errResult(fmt.Sprintf("%v; pass revision to restore an earlier revision of a live document", err))
		}
		return errFailed("restore "+entityType, err)
	}
	if entityType == "task" {
		search.BestEffortIndexTask(store, plan.EntityID)
		go notifyTaskUpdated(store, plan.EntityID)
	} else {
		search.BestEffortIndexDoc(store, plan.DocPath)
		go notifyDocUpdated(store, plan.DocPath)
	}
	out, _ := json.MarshalIndent(map[string]any{
		"execute":  true,
		"restored": result.Changed,
		"plan":     plan,
		"revision": result.Revision,
		"hash":     result.NewHash,
	}, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}
