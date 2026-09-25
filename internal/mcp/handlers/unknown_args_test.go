package handlers

import (
	"context"
	"strings"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
)

func callGuarded(t *testing.T, args map[string]any) (*mcp.CallToolResult, bool) {
	t.Helper()
	tool := mcp.NewTool("docs", mcp.WithString("action"), mcp.WithString("path"))
	reached := false
	guarded := RejectUnknownArguments(tool, func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		reached = true
		return mcp.NewToolResultText("ok"), nil
	})
	req := mcp.CallToolRequest{}
	req.Params.Arguments = args
	result, err := guarded(context.Background(), req)
	if err != nil {
		t.Fatalf("guarded handler returned a protocol error: %v", err)
	}
	return result, reached
}

func TestRejectUnknownArgumentsFailsTheCallAndNamesTheParameter(t *testing.T) {
	result, reached := callGuarded(t, map[string]any{"action": "get", "path": "a", "adAc": []any{"x"}})
	if reached {
		t.Fatal("a call with an undeclared parameter reached the handler")
	}
	if !result.IsError {
		t.Fatalf("an undeclared parameter was not reported as an error: %+v", result)
	}
	text := result.Content[0].(mcp.TextContent).Text
	if !strings.Contains(text, "adAc") || !strings.Contains(text, "docs") {
		t.Fatalf("error does not name the tool and the parameter: %q", text)
	}
}

func TestRejectUnknownArgumentsPassesDeclaredParameters(t *testing.T) {
	if _, reached := callGuarded(t, map[string]any{"action": "get", "path": "a"}); !reached {
		t.Fatal("a call using only declared parameters was blocked")
	}
	if _, reached := callGuarded(t, nil); !reached {
		t.Fatal("a call with no arguments was blocked")
	}
}
