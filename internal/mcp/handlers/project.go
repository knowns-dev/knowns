package handlers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/readiness"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

// RegisterProjectTool registers the consolidated project management MCP tool.
func RegisterProjectTool(
	s toolRegistrar,
	getStore func() *storage.Store,
	setStore func(*storage.Store, string),
	getRoot func() string,
	getLSPManager ...func() *lsp.Manager,
) {
	RegisterProjectToolWithStatusProvider(s, getStore, setStore, getRoot, nil, getLSPManager...)
}

func RegisterProjectToolWithStatusProvider(
	s toolRegistrar,
	getStore func() *storage.Store,
	setStore func(*storage.Store, string),
	getRoot func() string,
	getLSPStatuses func(context.Context) []lsp.LanguageRuntimeStatus,
	getLSPManager ...func() *lsp.Manager,
) {
	s.AddTool(
		mcp.NewTool("project",
			mcp.WithDescription(`Project management operations. Use 'action' to specify: detect, current, set, status.

- detect: Find Knowns projects in common or supplied directories. Required: none. Optional: additionalPaths. Returns: discovered project roots with names and status metadata.
- current: Show the currently active project. Required: none. Optional: none. Returns: active project name, root path, and store status.
- set: Switch the active project. Required: projectRoot. Optional: none. Returns: selected project metadata and readiness status.
- status: Inspect active project readiness. Required: none. Optional: none. Returns: project metadata, knowledge counts, search/model/index readiness, permissions, and capabilities.
`),
			mcp.WithString("action",
				mcp.Required(),
				mcp.Description("Action to perform"),
				mcp.Enum("detect", "current", "set", "status"),
			),
			mcp.WithString("projectRoot",
				mcp.Description("Absolute path to the project root directory (required for set)"),
			),
			mcp.WithArray("additionalPaths",
				mcp.Description("Additional directory paths to scan for projects (detect)"),
				mcp.WithStringItems(),
			),
		),
		func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			action, err := req.RequireString("action")
			if err != nil {
				return errResult("action is required")
			}
			switch action {
			case "detect":
				return handleProjectDetect(req)
			case "current":
				return handleProjectCurrent(getStore, getRoot)
			case "set":
				return handleProjectSet(setStore, req)
			case "status":
				var manager func() *lsp.Manager
				if len(getLSPManager) > 0 {
					manager = getLSPManager[0]
				}
				return handleProjectStatus(ctx, getStore, manager, getLSPStatuses)
			default:
				return errResultf("unknown project action: %s", action)
			}
		},
	)

	registerHelp(s, "project.detect", HelpEntry{When: "Find Knowns projects in common locations or additional directories before switching context.", Params: map[string]string{"additionalPaths": "extra directory paths to scan"}})
	registerHelp(s, "project.current", HelpEntry{When: "Show active project root, name, and store state.", Params: map[string]string{}})
	registerHelp(s, "project.set", HelpEntry{When: "Switch active Knowns project for subsequent MCP operations.", Params: map[string]string{"projectRoot": "required — absolute project root path"}, Flow: "Detect projects first when unsure of path, then set target project."})
	registerHelp(s, "project.status", HelpEntry{When: "Inspect active project readiness, knowledge counts, permissions, capabilities, and search/index health.", Params: map[string]string{}, Flow: "Use at session start or when diagnosing project/index readiness."})
}

func handleProjectDetect(req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()

	home, _ := os.UserHomeDir()
	dirs := []string{
		filepath.Join(home, "Desktop"),
		filepath.Join(home, "Documents"),
		filepath.Join(home, "Workspaces"),
		filepath.Join(home, "workspace"),
		filepath.Join(home, "projects"),
		filepath.Join(home, "Projects"),
		filepath.Join(home, "dev"),
		filepath.Join(home, "Dev"),
		"/tmp",
	}

	if extra, ok := args["additionalPaths"]; ok {
		switch v := extra.(type) {
		case []any:
			for _, item := range v {
				if s, ok := item.(string); ok {
					dirs = append(dirs, s)
				}
			}
		case []string:
			dirs = append(dirs, v...)
		}
	}

	type projectInfo struct {
		ProjectRoot string `json:"projectRoot"`
		Name        string `json:"name,omitempty"`
	}

	seen := make(map[string]bool)
	var projects []projectInfo

	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			candidate := filepath.Join(dir, e.Name())
			knownsDir := filepath.Join(candidate, ".knowns")
			configFile := filepath.Join(knownsDir, "config.json")
			if _, err := os.Stat(configFile); err != nil {
				continue
			}
			if seen[candidate] {
				continue
			}
			seen[candidate] = true

			info := projectInfo{ProjectRoot: candidate}
			store := storage.NewStore(knownsDir)
			if proj, err := store.Config.Load(); err == nil {
				info.Name = proj.Name
			}
			projects = append(projects, info)
		}
	}

	out, _ := json.MarshalIndent(projects, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleProjectCurrent(getStore func() *storage.Store, getRoot func() string) (*mcp.CallToolResult, error) {
	root := getRoot()
	store := getStore()

	if store == nil || root == "" {
		result := map[string]any{
			"projectRoot": nil,
			"valid":       false,
			"message":     ErrNoProject,
		}
		out, _ := json.MarshalIndent(result, "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	result := map[string]any{
		"projectRoot": root,
		"valid":       true,
	}

	if proj, err := store.Config.Load(); err == nil {
		result["projectName"] = proj.Name
	}

	out, _ := json.MarshalIndent(result, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleProjectSet(setStore func(*storage.Store, string), req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projectRoot, err := req.RequireString("projectRoot")
	if err != nil {
		return errResult(err.Error())
	}

	knownsDir := filepath.Join(projectRoot, ".knowns")
	if _, err := os.Stat(knownsDir); err != nil {
		return errResultf(ErrNoKnownsDir, projectRoot)
	}

	store := storage.NewStore(knownsDir)

	proj, err := store.Config.Load()
	if err != nil {
		return errResultf(ErrLoadConfig, err.Error())
	}

	setStore(store, projectRoot)

	result := map[string]any{
		"success":     true,
		"projectRoot": projectRoot,
		"projectName": proj.Name,
	}
	out, _ := json.MarshalIndent(result, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}

func handleProjectStatus(ctx context.Context, getStore func() *storage.Store, getLSPManager func() *lsp.Manager, getLSPStatuses ...func(context.Context) []lsp.LanguageRuntimeStatus) (*mcp.CallToolResult, error) {
	store := getStore()
	if store == nil {
		out, _ := json.MarshalIndent(readiness.InactivePayload(), "", "  ")
		return mcp.NewToolResultText(string(out)), nil
	}

	opts := readiness.Options{}
	if len(getLSPStatuses) > 0 && getLSPStatuses[0] != nil {
		opts.LSP = getLSPStatuses[0](ctx)
	}
	if getLSPManager != nil {
		if manager := getLSPManager(); manager != nil && len(opts.LSP) == 0 {
			opts.LSP = manager.RuntimeStatuses(ctx)
		}
	}
	payload := readiness.BuildReadiness(store, opts)
	out, _ := json.MarshalIndent(payload, "", "  ")
	return mcp.NewToolResultText(string(out)), nil
}
