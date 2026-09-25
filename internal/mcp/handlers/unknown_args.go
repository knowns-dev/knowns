package handlers

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// RejectUnknownArguments wraps a tool handler so a call carrying a parameter
// the tool's schema does not declare fails instead of being dropped. A caller
// working from a stale or wrong picture of the schema otherwise gets
// {"success": true} and a different outcome than it asked for: tasks create
// once discarded five acceptance criteria that way. The tasks tool also checks
// parameters per action; this is the tool-wide floor for every tool.
func RejectUnknownArguments(tool mcp.Tool, handler server.ToolHandlerFunc) server.ToolHandlerFunc {
	declared := make(map[string]struct{}, len(tool.InputSchema.Properties))
	for name := range tool.InputSchema.Properties {
		declared[name] = struct{}{}
	}
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var unknown []string
		for key := range req.GetArguments() {
			if _, ok := declared[key]; !ok {
				unknown = append(unknown, key)
			}
		}
		if len(unknown) > 0 {
			sort.Strings(unknown)
			return errResult(fmt.Sprintf("%s does not accept %s; call help(%q) for the parameters it takes",
				tool.Name, strings.Join(unknown, ", "), tool.Name+".*"))
		}
		return handler(ctx, req)
	}
}
