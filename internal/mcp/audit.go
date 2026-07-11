package mcp

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/permissions"
	"github.com/howznguyen/knowns/internal/storage"
	gomcp "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// pendingCall tracks in-flight tool calls for duration measurement.
type pendingCall struct {
	startedAt time.Time
	toolName  string
	action    string
}

type auditAppender interface {
	Append(event *models.AuditEvent) error
}

// auditRecorder records MCP tool calls as structured audit events.
type auditRecorder struct {
	auditStore auditAppender
	getRoot    func() string

	mu      sync.Mutex
	pending map[any]*pendingCall // keyed by request ID
}

// newAuditHooks creates audit hooks and registers them on a server.Hooks instance.
func newAuditHooks(auditStore *storage.AuditStore, getRoot func() string) *server.Hooks {
	ar := &auditRecorder{
		auditStore: auditStore,
		getRoot:    getRoot,
		pending:    make(map[any]*pendingCall),
	}

	hooks := &server.Hooks{}
	hooks.AddBeforeCallTool(ar.beforeCallTool)
	hooks.AddAfterCallTool(ar.afterCallTool)
	return hooks
}

// beforeCallTool records the start time and extracts tool metadata.
func (ar *auditRecorder) beforeCallTool(_ context.Context, id any, req *gomcp.CallToolRequest) {
	toolName := req.Params.Name
	args := req.GetArguments()
	action, _ := args["action"].(string)

	ar.mu.Lock()
	ar.pending[id] = &pendingCall{
		startedAt: time.Now(),
		toolName:  toolName,
		action:    action,
	}
	ar.mu.Unlock()
}

// afterCallTool records the completed audit event.
func (ar *auditRecorder) afterCallTool(_ context.Context, id any, req *gomcp.CallToolRequest, result any) {
	ar.mu.Lock()
	pc, ok := ar.pending[id]
	if ok {
		delete(ar.pending, id)
	}
	ar.mu.Unlock()

	if !ok {
		return
	}

	// Don't audit the audit tool itself to avoid recursion.
	if pc.toolName == "audit" {
		return
	}

	duration := time.Since(pc.startedAt)
	args := req.GetArguments()

	// Determine result status.
	resultStatus := "success"
	var errorMsg string
	if r, ok := result.(*gomcp.CallToolResult); ok && r != nil && r.IsError {
		resultStatus = "error"
		for _, c := range r.Content {
			if tc, ok := c.(gomcp.TextContent); ok {
				errorMsg = tc.Text
				// Detect permission denial from the guard middleware.
				if strings.Contains(errorMsg, `"denied":`) && strings.Contains(errorMsg, `"policyRef":`) {
					resultStatus = "denied"
				}
				if len(errorMsg) > 200 {
					errorMsg = errorMsg[:197] + "..."
				}
				break
			}
		}
	}

	event := &models.AuditEvent{
		Timestamp:       pc.startedAt,
		ToolName:        pc.toolName,
		Action:          pc.action,
		ActionClass:     classifyAction(pc.toolName, pc.action),
		ProjectRoot:     ar.getRoot(),
		DryRun:          isDryRun(args),
		Result:          resultStatus,
		DurationMs:      duration.Milliseconds(),
		ErrorMessage:    errorMsg,
		EntityRefs:      extractEntityRefs(pc.toolName, args),
		ArgumentSummary: summarizeArgs(pc.toolName, args),
	}

	// Persist before returning from the hook. Stdio clients commonly make one
	// request and exit, which can abandon an asynchronous write at process exit.
	if err := ar.auditStore.Append(event); err != nil {
		mcpLog.Printf("audit: write failed: %v", err)
	}
}

// classifyAction maps tool+action to an action class using the shared registry.
func classifyAction(tool, action string) string {
	return permissions.ClassifyAction(tool, action).Capability
}

// toolClassMap provides fallback classification at the tool level.
// Kept for backward compatibility — the shared registry handles this now.
var toolClassMap = map[string]string{
	"tasks":     "read",
	"docs":      "read",
	"time":      "read",
	"search":    "read",
	"code":      "read",
	"templates": "read",
	"validate":  "read",
	"memory":    "read",
	"project":   "admin",
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

// extractEntityRefs pulls lightweight entity references from the arguments.
func extractEntityRefs(tool string, args map[string]any) []string {
	var refs []string

	if id, ok := args["taskId"].(string); ok && id != "" {
		refs = append(refs, "task:"+id)
	}
	if p, ok := args["path"].(string); ok && p != "" {
		refs = append(refs, "doc:"+p)
	}
	if id, ok := args["id"].(string); ok && id != "" && tool == "memory" {
		refs = append(refs, "memory:"+id)
	}
	if name, ok := args["name"].(string); ok && name != "" && tool == "templates" {
		refs = append(refs, "template:"+name)
	}
	if spec, ok := args["spec"].(string); ok && spec != "" {
		refs = append(refs, "spec:"+spec)
	}

	return refs
}

// contentFields are argument keys that may contain large user content.
var contentFields = map[string]bool{
	"content":       true,
	"appendContent": true,
	"description":   true,
	"notes":         true,
	"appendNotes":   true,
	"plan":          true,
	"note":          true,
}

// summarizeArgs creates a privacy-safe summary of the call arguments.
func summarizeArgs(tool string, args map[string]any) map[string]string {
	if len(args) == 0 {
		return nil
	}

	summary := make(map[string]string)
	for k, v := range args {
		if k == "action" {
			continue
		}

		// Large content fields → log size only.
		if contentFields[strings.ToLower(k)] {
			if s, ok := v.(string); ok {
				summary[k] = fmt.Sprintf("[%d chars]", len(s))
			}
			continue
		}

		// Short scalar values → log directly, truncate at 100 chars.
		s := fmt.Sprintf("%v", v)
		if len(s) > 100 {
			s = s[:97] + "..."
		}
		summary[k] = s
	}

	if len(summary) == 0 {
		return nil
	}
	return summary
}
