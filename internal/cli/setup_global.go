package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/howznguyen/knowns/internal/codegen"
	"github.com/howznguyen/knowns/internal/runtimeinstall"
	"github.com/spf13/cobra"
)

func runGlobalSetup(cmd *cobra.Command, args []string, force bool) error {
	var platforms []string

	if len(args) == 0 {
		// Interactive mode — reuse selector
		selected, err := runSetupSelector()
		if err != nil {
			if err.Error() == "user aborted" {
				fmt.Println(warnStyle.Render("Setup cancelled."))
				return nil
			}
			return err
		}
		platforms = selected
	} else {
		target := args[0]
		switch target {
		case "claude":
			platforms = []string{"claude-code"}
		case "opencode":
			platforms = []string{"opencode"}
		case "copilot":
			platforms = []string{"copilot"}
		case "kiro":
			platforms = []string{"kiro"}
		case "codex":
			platforms = []string{"codex"}
		case "cursor":
			platforms = []string{"cursor"}
		case "gemini":
			platforms = []string{"gemini"}
		case "antigravity":
			platforms = []string{"antigravity"}
		case "all":
			platforms = allPlatformIDs
		default:
			return fmt.Errorf("unknown setup target %q (expected: claude, opencode, copilot, kiro, codex, cursor, gemini, antigravity, all)", target)
		}
	}

	steps := buildGlobalSetupSteps(force, platforms)
	fmt.Println()
	if err := runInitSteps(steps); err != nil {
		return fmt.Errorf("global setup failed: %w", err)
	}
	fmt.Println()
	fmt.Println(successStyle.Render("Global AI integration setup complete"))
	return nil
}

func buildGlobalSetupSteps(force bool, platforms []string) []initStep {
	home, _ := os.UserHomeDir()
	var steps []initStep

	// 1. Global skills
	if hasPlatform(platforms, "claude-code") || hasPlatform(platforms, "kiro") || hasPlatform(platforms, "codex") || hasPlatform(platforms, "opencode") || hasPlatform(platforms, "antigravity") || hasPlatform(platforms, "cursor") || hasPlatform(platforms, "gemini") {
		steps = append(steps, initStep{
			label: "Syncing global skills",
			run: func() error {
				return syncGlobalSkills(home, platforms)
			},
		})
	}

	// 2. Global MCP configs
	if hasPlatform(platforms, "claude-code") {
		steps = append(steps, initStep{
			label: "Configuring Claude Code global MCP",
			run: func() error {
				return setupGlobalClaudeCodeMCP(home)
			},
		})
	}
	if hasPlatform(platforms, "claude-code") {
		steps = append(steps, initStep{
			label: "Configuring Claude Desktop MCP",
			run: func() error {
				return setupGlobalClaudeDesktopMCP(home)
			},
		})
	}
	if hasPlatform(platforms, "opencode") {
		steps = append(steps, initStep{
			label: "Configuring OpenCode global MCP",
			run: func() error {
				return setupGlobalOpenCodeMCP(home)
			},
		})
	}
	if hasPlatform(platforms, "gemini") || hasPlatform(platforms, "antigravity") {
		steps = append(steps, initStep{
			label: "Configuring Gemini/Antigravity global MCP",
			run: func() error {
				return setupGlobalGeminiMCP(home)
			},
		})
	}
	if hasPlatform(platforms, "kiro") {
		steps = append(steps, initStep{
			label: "Configuring Kiro global MCP",
			run: func() error {
				return setupGlobalKiroMCP(home)
			},
		})
	}
	if hasPlatform(platforms, "cursor") {
		steps = append(steps, initStep{
			label: "Configuring Cursor global MCP",
			run: func() error {
				return setupGlobalCursorMCP(home)
			},
		})
	}
	if hasPlatform(platforms, "codex") {
		steps = append(steps, initStep{
			label: "Configuring Codex global MCP",
			run: func() error {
				return setupGlobalCodexMCP(home)
			},
		})
	}

	// 3. Runtime hooks
	for _, rt := range []string{"claude-code", "codex", "kiro", "opencode"} {
		if !hasPlatform(platforms, rt) {
			continue
		}
		selectedRuntime := rt
		opts := runtimeinstall.DefaultOptions()
		if !runtimeinstall.CanAutoInstall(selectedRuntime) {
			st, err := runtimeinstall.StatusFor(selectedRuntime, opts)
			if err != nil || !st.Available {
				continue
			}
		}
		steps = append(steps, initStep{
			label: fmt.Sprintf("Installing %s runtime hooks", runtimeinstall.RuntimePickerLabel(selectedRuntime, opts)),
			run: func() error {
				return runtimeinstall.Install(selectedRuntime, opts)
			},
		})
	}

	// 4. Global instruction files
	if hasPlatform(platforms, "claude-code") {
		steps = append(steps, initStep{
			label: "Creating global Claude instruction file",
			run: func() error {
				return writeGlobalInstructionFile(home, "claude-code")
			},
		})
	}
	if hasPlatform(platforms, "kiro") {
		steps = append(steps, initStep{
			label: "Creating global Kiro steering file",
			run: func() error {
				return writeGlobalInstructionFile(home, "kiro")
			},
		})
	}

	return steps
}

// --- Global MCP setup helpers ---

func upsertGlobalMCPJSON(configPath string, serverKey string) error {
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	config := map[string]any{}
	if data, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(data, &config)
	}

	servers, ok := config["mcpServers"].(map[string]any)
	if !ok || servers == nil {
		servers = make(map[string]any)
	}

	cmd, args := mcpCommand()
	servers[serverKey] = map[string]any{
		"command": cmd,
		"args":    args,
	}
	config["mcpServers"] = servers

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, append(data, '\n'), 0644)
}

func setupGlobalClaudeCodeMCP(home string) error {
	configPath := filepath.Join(home, ".claude", "settings.json")
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	config := map[string]any{}
	if data, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(data, &config)
	}

	servers, ok := config["mcpServers"].(map[string]any)
	if !ok || servers == nil {
		servers = make(map[string]any)
	}

	cmd, args := mcpCommand()
	servers["knowns"] = map[string]any{
		"command": cmd,
		"args":    args,
	}
	config["mcpServers"] = servers

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, append(data, '\n'), 0644)
}

func setupGlobalClaudeDesktopMCP(home string) error {
	var configPath string
	switch runtime.GOOS {
	case "darwin":
		configPath = filepath.Join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
	case "windows":
		configPath = filepath.Join(os.Getenv("APPDATA"), "Claude", "claude_desktop_config.json")
	default:
		configPath = filepath.Join(home, ".config", "claude", "claude_desktop_config.json")
	}
	return upsertGlobalMCPJSON(configPath, "knowns")
}

func setupGlobalOpenCodeMCP(home string) error {
	configPath := filepath.Join(home, ".config", "opencode", "opencode.json")
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	config := map[string]any{}
	if data, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(data, &config)
	}

	mcp, ok := config["mcp"].(map[string]any)
	if !ok || mcp == nil {
		mcp = make(map[string]any)
	}

	cmd, args := mcpCommand()
	mcp["knowns"] = map[string]any{
		"command": cmd,
		"args":    args,
	}
	config["mcp"] = mcp

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, append(data, '\n'), 0644)
}

func setupGlobalGeminiMCP(home string) error {
	configPath := filepath.Join(home, ".gemini", "settings.json")
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	config := map[string]any{}
	if data, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(data, &config)
	}

	servers, ok := config["mcpServers"].(map[string]any)
	if !ok || servers == nil {
		servers = make(map[string]any)
	}

	cmd, args := mcpCommand()
	servers["knowns"] = map[string]any{
		"command": cmd,
		"args":    args,
	}
	config["mcpServers"] = servers

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath, append(data, '\n'), 0644)
}

func setupGlobalKiroMCP(home string) error {
	configPath := filepath.Join(home, ".kiro", "settings", "mcp.json")
	return upsertGlobalMCPJSON(configPath, "knowns")
}

func setupGlobalCursorMCP(home string) error {
	configPath := filepath.Join(home, ".cursor", "mcp.json")
	return upsertGlobalMCPJSON(configPath, "knowns")
}

func setupGlobalCodexMCP(home string) error {
	configPath := filepath.Join(home, ".codex", "config.toml")
	dir := filepath.Dir(configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	cmd, args := mcpCommand()

	// Read existing TOML or create new
	content := ""
	if data, err := os.ReadFile(configPath); err == nil {
		content = string(data)
	}

	content = runtimeinstall.SetCodexMCPServer(content, cmd, args)

	return os.WriteFile(configPath, []byte(content), 0644)
}
// --- Global skills ---

func syncGlobalSkills(home string, platforms []string) error {
	targets := map[string]string{}
	if hasPlatform(platforms, "claude-code") {
		targets["claude-code"] = filepath.Join(home, ".claude", "skills")
	}
	if hasPlatform(platforms, "kiro") {
		targets["kiro"] = filepath.Join(home, ".kiro", "skills")
	}
	// All other platforms share ~/.agents/skills/ (agentskills.io standard)
	for _, p := range []string{"codex", "opencode", "antigravity", "gemini", "cursor"} {
		if hasPlatform(platforms, p) {
			targets["agents"] = filepath.Join(home, ".agents", "skills")
			break
		}
	}
	return codegen.SyncSkillsToTargets(targets)
}

// --- Global instruction files ---

func writeGlobalInstructionFile(home, platform string) error {
	var filePath string
	switch platform {
	case "claude-code":
		filePath = filepath.Join(home, ".claude", "CLAUDE.md")
	case "kiro":
		filePath = filepath.Join(home, ".kiro", "steering", "knowns.md")
	default:
		return nil
	}

	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	content := generateGlobalInstructionContent(platform)
	return os.WriteFile(filePath, []byte(content), 0644)
}

func generateGlobalInstructionContent(platform string) string {
	switch platform {
	case "claude-code":
		return `# CLAUDE

Global Knowns integration. Project-level KNOWNS.md takes precedence when available.

## Knowns

Knowns is the repository memory and workflow layer for AI-native development.

- When working in a project with a .knowns/ directory, read KNOWNS.md for project-specific guidance.
- Use Knowns MCP tools for tasks, docs, templates, and workflow state.
- Search first, then read only relevant docs and code.
- Plan before implementation unless the user explicitly overrides.
`
	case "kiro":
		return `# Knowns Global Steering

Global Knowns integration for Kiro. Project-level configuration takes precedence when available.

## Knowns

Knowns is the repository memory and workflow layer for AI-native development.

- When working in a project with a .knowns/ directory, follow project KNOWNS.md guidance.
- Use Knowns MCP tools for tasks, docs, templates, and workflow state.
- Search first, then read only relevant docs and code.
`
	default:
		return ""
	}
}
