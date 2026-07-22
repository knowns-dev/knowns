package permissions

import (
	"context"
	"encoding/json"
	"strings"

	gomcp "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// ConfigLoader loads the permission config from the project store.
// This avoids importing the storage package directly.
type ConfigLoader func() *PermissionConfig

// NewGuardMiddleware returns a ToolHandlerMiddleware that enforces the
// project permission policy. It runs Pass 1 (capability+target check)
// before the handler executes.
//
// The middleware uses the configLoader to read the current policy on each
// call, so policy changes take effect immediately without server restart.
//
// When a call is denied, the middleware returns a structured denial payload
// as an error result and does not invoke the underlying handler.
func NewGuardMiddleware(configLoader ConfigLoader) server.ToolHandlerMiddleware {
	return func(next server.ToolHandlerFunc) server.ToolHandlerFunc {
		return func(ctx context.Context, req gomcp.CallToolRequest) (*gomcp.CallToolResult, error) {
			toolName := req.Params.Name
			args := req.GetArguments()
			action, _ := args["action"].(string)

			// Bootstrap actions are always allowed — they are required to
			// set up the project context before any policy can be loaded.
			if isBootstrapAction(toolName, action) {
				return next(ctx, req)
			}
			// Lifecycle handlers return the shared public Response contract for
			// every denial. Let that trusted boundary enforce hard-delete policy
			// so middleware cannot replace it with a different JSON shape.
			if isPublicTaskLifecycleAction(toolName, action) {
				return next(ctx, req)
			}

			// Classify the action.
			meta := classifyToolAction(toolName, action, args)

			// Load effective policy.
			cfg := configLoader()
			policy := EffectivePolicy(cfg)

			// Check dryRun from arguments.
			dryRun := isDryRun(args) || lifecyclePreview(action, args)

			// Pass 1: capability gate (no IO).
			confirmedDelete := meta.Capability == CapDelete && explicitDeleteConfirmation(args)
			if denial := CheckCapability(policy, meta, dryRun || confirmedDelete); denial != nil {
				return denialResult(denial), nil
			}

			// Allowed — proceed to handler.
			return next(ctx, req)
		}
	}
}

func isPublicTaskLifecycleAction(tool, action string) bool {
	if tool != "tasks" {
		return false
	}
	switch action {
	case "archive", "unarchive", "batch_archive", "batch_unarchive", "hard_delete":
		return true
	default:
		return false
	}
}

func lifecyclePreview(action string, args map[string]any) bool {
	switch action {
	case "archive", "unarchive", "batch_archive", "batch_unarchive":
		execute, _ := args["execute"].(bool)
		return !execute
	default:
		return false
	}
}

func explicitDeleteConfirmation(args map[string]any) bool {
	confirmed, _ := args["confirmed"].(bool)
	reason, _ := args["reason"].(string)
	return confirmed && strings.TrimSpace(reason) != ""
}

// classifyToolAction determines the ActionMeta for a tool call.
// It handles the special case of validate (which uses fix param instead of action).
func classifyToolAction(tool, action string, args map[string]any) ActionMeta {
	if tool == "validate" {
		fix, _ := args["fix"].(bool)
		return ClassifyValidateAction(fix)
	}
	return ClassifyAction(tool, action)
}

// isBootstrapAction returns true for actions that must always be allowed
// because they are needed to establish the project context. Without these,
// the permission system itself cannot load its config.
func isBootstrapAction(tool, action string) bool {
	switch tool + "." + action {
	case "project.set", "project.detect", "project.current", "project.status":
		return true
	}
	return false
}

// isDryRun checks if the call arguments indicate a dry-run/preview operation.
func isDryRun(args map[string]any) bool {
	if v, ok := args["dryRun"]; ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return false
}

// denialResult creates an MCP error result from a DenialPayload.
func denialResult(denial *DenialPayload) *gomcp.CallToolResult {
	data, _ := json.MarshalIndent(denial, "", "  ")
	result := gomcp.NewToolResultError(string(data))
	return result
}
