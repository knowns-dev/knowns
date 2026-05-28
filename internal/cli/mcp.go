package cli

import (
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/howznguyen/knowns/internal/mcp"
)

var mcpCmd = &cobra.Command{
	Use:   "mcp",
	Short: "Start the MCP (Model Context Protocol) server",
	Long: `Start the Knowns MCP server, which exposes project management tools
to AI agents via the Model Context Protocol.

Use --stdio to communicate over stdin/stdout (default for MCP clients).`,
	RunE:         runMCP,
	SilenceUsage: true,
}

func runMCP(cmd *cobra.Command, args []string) error {
	// Determine project root: --project flag > KNOWNS_PROJECT env > cwd walk-up
	projectRoot, _ := cmd.Flags().GetString("project")
	if projectRoot == "" {
		projectRoot = os.Getenv("KNOWNS_PROJECT")
	}

	s := mcp.NewMCPServer(projectRoot)
	return s.Start()
}

// --- mcp setup ---

// mcpPlatform describes a supported MCP platform and how to configure it.
type mcpPlatform struct {
	id    string // canonical lowercase name used as CLI argument
	label string // display name
	scope string // "project" or "global"
	// setup returns the config file path and any error.
	// projectRoot is the current working directory (needed for project-level and some global configs).
	setup func(projectRoot string) (path string, err error)
}

// mcpPlatforms is the registry of all supported platforms.
// Order determines display order.
var mcpPlatforms = []mcpPlatform{
	// Project-level
	{id: "claude", label: "Claude Code", scope: "project", setup: func(root string) (string, error) {
		return filepath.Join(root, ".mcp.json"), createMCPJsonFileQuiet(root, true)
	}},
	{id: "kiro", label: "Kiro", scope: "project", setup: func(root string) (string, error) {
		return filepath.Join(root, ".kiro", "settings", "mcp.json"), createKiroMCPConfigQuiet(root)
	}},
	{id: "opencode", label: "OpenCode", scope: "project", setup: func(root string) (string, error) {
		return filepath.Join(root, "opencode.json"), createOpenCodeConfigQuiet(root)
	}},
	{id: "cursor", label: "Cursor", scope: "project", setup: func(root string) (string, error) {
		return filepath.Join(root, ".cursor", "mcp.json"), createCursorMCPConfigQuiet(root)
	}},
	{id: "codex", label: "Codex", scope: "project", setup: func(root string) (string, error) {
		return filepath.Join(root, ".codex", "config.toml"), createCodexMCPConfigQuiet(root)
	}},
}

func init() {
	mcpCmd.Flags().Bool("stdio", false, "Use stdio transport (for MCP clients)")
	mcpCmd.Flags().String("project", "", "Project root directory (auto-detected from cwd if not set)")

	rootCmd.AddCommand(mcpCmd)
}