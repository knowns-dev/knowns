package guidelines

import (
	"strings"
	"testing"
)

func TestWorkflowCompletionRendersDecisionImpactGateForCLIAndMCP(t *testing.T) {
	for _, test := range []struct {
		name string
		opts RenderOptions
		want string
	}{
		{name: "cli", opts: RenderOptions{CLI: true}, want: `knowns decision create "<title>"`},
		{name: "mcp", opts: RenderOptions{MCP: true}, want: `mcp__knowns__decision({`},
	} {
		t.Run(test.name, func(t *testing.T) {
			rendered, err := RenderFile("unified/workflow-completion.md", test.opts)
			if err != nil {
				t.Fatalf("RenderFile: %v", err)
			}
			for _, marker := range []string{
				"System Decision Impact: none",
				"candidate @decision/<id>",
				"Never create Memory category `decision`",
				test.want,
			} {
				if !strings.Contains(rendered, marker) {
					t.Fatalf("rendered workflow is missing %q", marker)
				}
			}
		})
	}
}

func TestCoreRulesRejectLegacyDecisionMemoryCapture(t *testing.T) {
	rendered, err := RenderFile("unified/core-rules.md", RenderOptions{CLI: true, MCP: true})
	if err != nil {
		t.Fatalf("RenderFile: %v", err)
	}
	if !strings.Contains(rendered, "never create Decision Memory") {
		t.Fatal("core rules do not reject legacy Decision Memory capture")
	}
}
