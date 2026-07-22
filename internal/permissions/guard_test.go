package permissions

import (
	"context"
	"encoding/json"
	"testing"

	gomcp "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// passHandler is a no-op handler that returns a success result.
func passHandler(_ context.Context, _ gomcp.CallToolRequest) (*gomcp.CallToolResult, error) {
	return gomcp.NewToolResultText("ok"), nil
}

// callTool simulates a tool call through the middleware.
func callTool(mw server.ToolHandlerMiddleware, tool, action string, extra map[string]any) (*gomcp.CallToolResult, error) {
	args := map[string]any{"action": action}
	for k, v := range extra {
		args[k] = v
	}
	req := gomcp.CallToolRequest{}
	req.Params.Name = tool
	req.Params.Arguments = args
	wrapped := mw(passHandler)
	return wrapped(context.Background(), req)
}

// parseDenial extracts a DenialPayload from an error result.
func parseDenial(t *testing.T, result *gomcp.CallToolResult) *DenialPayload {
	t.Helper()
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if !result.IsError {
		return nil // not denied
	}
	for _, c := range result.Content {
		if tc, ok := c.(gomcp.TextContent); ok {
			var d DenialPayload
			if err := json.Unmarshal([]byte(tc.Text), &d); err != nil {
				t.Fatalf("failed to parse denial: %v", err)
			}
			return &d
		}
	}
	t.Fatal("no text content in error result")
	return nil
}

func TestDefaultPolicy_BlocksDelete(t *testing.T) {
	// Scenario 1: Default policy (nil config) blocks delete.
	mw := NewGuardMiddleware(func() *PermissionConfig { return nil })

	result, err := callTool(mw, "docs", "delete", map[string]any{"path": "specs/old-spec", "dryRun": false})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	denial := parseDenial(t, result)
	if denial == nil {
		t.Fatal("expected denial, got success")
	}
	if denial.Capability != "delete" {
		t.Errorf("expected capability=delete, got %s", denial.Capability)
	}
	if denial.PolicyRef.Preset != PresetReadWriteNoDelete {
		t.Errorf("expected preset=%s, got %s", PresetReadWriteNoDelete, denial.PolicyRef.Preset)
	}
}

func TestDefaultPolicy_AllowsReadWrite(t *testing.T) {
	mw := NewGuardMiddleware(func() *PermissionConfig { return nil })

	// Read should pass.
	result, err := callTool(mw, "tasks", "list", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Error("expected read to be allowed")
	}

	// Write should pass.
	result, err = callTool(mw, "tasks", "create", map[string]any{"title": "test"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Error("expected write to be allowed")
	}
}

func TestReadWritePreset_AllowsDelete(t *testing.T) {
	// Scenario 2: read-write preset allows delete (with dryRun).
	cfg := &PermissionConfig{Preset: PresetReadWrite}
	mw := NewGuardMiddleware(func() *PermissionConfig { return cfg })

	// Delete with dryRun=true should pass.
	result, err := callTool(mw, "tasks", "delete", map[string]any{"taskId": "abc123", "dryRun": true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Error("expected delete with dryRun=true to be allowed under read-write")
	}

	// Delete with dryRun=false should be denied (requires dryRun first).
	result, err = callTool(mw, "tasks", "delete", map[string]any{"taskId": "abc123", "dryRun": false})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	denial := parseDenial(t, result)
	if denial == nil {
		t.Fatal("expected denial for delete without dryRun under read-write")
	}
	if denial.Capability != "delete" {
		t.Errorf("expected capability=delete, got %s", denial.Capability)
	}
}

func TestPublicTaskLifecycleDefersPolicyAndIntentToSharedHandler(t *testing.T) {
	readWrite := NewGuardMiddleware(func() *PermissionConfig { return &PermissionConfig{Preset: PresetReadWrite} })
	result, err := callTool(readWrite, "tasks", "hard_delete", map[string]any{"taskId": "abc123", "confirmed": true, "reason": "approved"})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatalf("explicit hard-delete should pass read-write policy: %+v", result)
	}

	result, err = callTool(readWrite, "tasks", "hard_delete", map[string]any{"taskId": "abc123", "confirmed": true})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatalf("shared handler should classify missing reason: %+v", result)
	}

	defaultPolicy := NewGuardMiddleware(func() *PermissionConfig { return nil })
	result, err = callTool(defaultPolicy, "tasks", "hard_delete", map[string]any{"taskId": "abc123", "confirmed": true, "reason": "spoof", "authorized": true})
	if err != nil {
		t.Fatal(err)
	}
	if result.IsError {
		t.Fatalf("shared handler should enforce trusted capability: %+v", result)
	}
}

func TestReadOnlyPreset_BlocksWrite(t *testing.T) {
	// Scenario 3: read-only blocks write.
	cfg := &PermissionConfig{Preset: PresetReadOnly}
	mw := NewGuardMiddleware(func() *PermissionConfig { return cfg })

	result, err := callTool(mw, "tasks", "create", map[string]any{"title": "New task"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	denial := parseDenial(t, result)
	if denial == nil {
		t.Fatal("expected denial for write under read-only")
	}
	if denial.Capability != "write" {
		t.Errorf("expected capability=write, got %s", denial.Capability)
	}
	if denial.PolicyRef.Preset != PresetReadOnly {
		t.Errorf("expected preset=%s, got %s", PresetReadOnly, denial.PolicyRef.Preset)
	}
}

func TestReadOnlyPreset_AllowsRead(t *testing.T) {
	cfg := &PermissionConfig{Preset: PresetReadOnly}
	mw := NewGuardMiddleware(func() *PermissionConfig { return cfg })

	result, err := callTool(mw, "tasks", "list", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Error("expected read to be allowed under read-only")
	}
}

func TestGenerateDryRunPreset_DeniesNonDryRun(t *testing.T) {
	// Scenario 4: generate-dry-run denies generate without dryRun.
	cfg := &PermissionConfig{Preset: PresetGenerateDryRun}
	mw := NewGuardMiddleware(func() *PermissionConfig { return cfg })

	result, err := callTool(mw, "templates", "run", map[string]any{"name": "component", "dryRun": false})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	denial := parseDenial(t, result)
	if denial == nil {
		t.Fatal("expected denial for generate without dryRun")
	}
	if denial.Capability != "generate" {
		t.Errorf("expected capability=generate, got %s", denial.Capability)
	}
}

func TestGenerateDryRunPreset_AllowsDryRun(t *testing.T) {
	cfg := &PermissionConfig{Preset: PresetGenerateDryRun}
	mw := NewGuardMiddleware(func() *PermissionConfig { return cfg })

	result, err := callTool(mw, "templates", "run", map[string]any{"name": "component", "dryRun": true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Error("expected generate with dryRun=true to be allowed")
	}
}

func TestGenerateDryRunPreset_DeniesWrite(t *testing.T) {
	cfg := &PermissionConfig{Preset: PresetGenerateDryRun}
	mw := NewGuardMiddleware(func() *PermissionConfig { return cfg })

	result, err := callTool(mw, "tasks", "create", map[string]any{"title": "test"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	denial := parseDenial(t, result)
	if denial == nil {
		t.Fatal("expected denial for write under generate-dry-run")
	}
	if denial.Capability != "write" {
		t.Errorf("expected capability=write, got %s", denial.Capability)
	}
}

func TestDefaultPolicy_BlocksAdmin(t *testing.T) {
	// Test that the default policy denies admin capability.
	// We test CheckCapability directly because project.* actions are
	// bootstrap-exempt in the guard middleware (they must always work
	// so the project context can be established before policy loads).
	cfg := (*PermissionConfig)(nil)
	policy := EffectivePolicy(cfg)
	meta := ActionMeta{Capability: CapAdmin, Target: TargetRuntime, Risk: RiskMedium}

	denial := CheckCapability(policy, meta, false)
	if denial == nil {
		t.Fatal("expected denial for admin under default policy")
	}
	if denial.Capability != "admin" {
		t.Errorf("expected capability=admin, got %s", denial.Capability)
	}
}

func TestDefaultPolicy_AllowsGenerate(t *testing.T) {
	mw := NewGuardMiddleware(func() *PermissionConfig { return nil })

	result, err := callTool(mw, "templates", "run", map[string]any{"name": "test", "dryRun": false})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Error("expected generate to be allowed under default policy")
	}
}
