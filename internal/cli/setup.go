package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/charmbracelet/huh"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/howznguyen/knowns/internal/codegen"
	"github.com/howznguyen/knowns/internal/runtimeinstall"
	"github.com/spf13/cobra"
)

var setupCmd = &cobra.Command{
	Use:   "setup [target]",
	Short: "Configure AI tool integrations",
	Long: `Configure AI tool integrations for an initialized Knowns project.

Without a target, an interactive selector is shown.

Targets:
  claude    Generate CLAUDE.md, KNOWNS.md, .mcp.json, skills, and runtime hooks
  opencode  Generate OPENCODE.md, KNOWNS.md, opencode.json, skills, and runtime hooks
  copilot   Generate .github/copilot-instructions.md and KNOWNS.md
  kiro      Generate .kiro steering/settings, KNOWNS.md, skills, and runtime hooks
  all       Generate all supported AI integration files`,
	Args: cobra.MaximumNArgs(1),
	RunE: runSetupCmd,
}

func runSetupCmd(cmd *cobra.Command, args []string) error {
	force, _ := cmd.Flags().GetBool("force")

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("cannot determine working directory: %w", err)
	}

	root := filepath.Join(cwd, ".knowns")
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("project is not initialized; run 'knowns init' first")
		}
		return err
	}

	var platforms []string

	if len(args) == 0 {
		// Interactive mode: show multi-select
		selected, err := runSetupSelector()
		if err != nil {
			if err == huh.ErrUserAborted {
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
		case "all":
			platforms = allPlatformIDs
		default:
			return fmt.Errorf("unknown setup target %q (expected: claude, opencode, copilot, kiro, all)", target)
		}
	}

	target := "selected platforms"
	if len(args) > 0 {
		target = args[0]
	}

	steps := buildSetupSteps(cwd, force, target, platforms)
	fmt.Println()
	if err := runInitSteps(steps); err != nil {
		return fmt.Errorf("setup failed: %w", err)
	}
	fmt.Println()
	fmt.Println(successStyle.Render(fmt.Sprintf("✓ AI integration setup complete for %s", target)))
	return nil
}

func runSetupSelector() ([]string, error) {
	defaultPlatforms := []string{"claude-code", "opencode", "agents"}
	selectedSet := make(map[string]bool, len(defaultPlatforms))
	for _, p := range defaultPlatforms {
		selectedSet[p] = true
	}

	platformOptions := make([]huh.Option[string], len(wizardPlatformIDs))
	for i, id := range wizardPlatformIDs {
		platformOptions[i] = huh.NewOption(platformLabel(id), id).Selected(selectedSet[id])
	}

	var selected []string
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewMultiSelect[string]().
				Title("AI platforms to integrate").
				Description("Choose which platforms to generate config and instruction files for.\n"+
					"At least one platform must be selected.").
				Options(platformOptions...).
				Validate(func(s []string) error {
					if len(s) == 0 {
						return fmt.Errorf("select at least one platform")
					}
					return nil
				}).
				Value(&selected),
		),
	).WithTheme(huh.ThemeCatppuccin()).
		WithProgramOptions(tea.WithAltScreen())

	if err := form.Run(); err != nil {
		return nil, err
	}
	return selected, nil
}

func buildSetupSteps(cwd string, force bool, target string, platforms []string) []initStep {
	steps := []initStep{
		{
			label: "Syncing skills",
			run: func() error {
				return codegen.SyncSkillsForPlatforms(cwd, platforms)
			},
		},
	}

	if hasPlatform(platforms, "claude-code") {
		steps = append(steps, initStep{
			label: "Creating Claude MCP config",
			run: func() error {
				return createMCPJsonFileQuiet(cwd, force)
			},
		})
	}
	if hasPlatform(platforms, "opencode") {
		steps = append(steps, initStep{
			label: "Creating OpenCode config",
			run: func() error {
				return createOpenCodeConfigQuiet(cwd)
			},
		})
	}
	if hasPlatform(platforms, "kiro") {
		steps = append(steps, initStep{
			label: "Creating Kiro steering",
			run: func() error {
				return createKiroSteeringQuiet(cwd, force)
			},
		})
		steps = append(steps, initStep{
			label: "Creating Kiro MCP config",
			run: func() error {
				return createKiroMCPConfigQuiet(cwd)
			},
		})
	}
	if hasPlatform(platforms, "codex") {
		steps = append(steps, initStep{
			label: "Creating Codex MCP config",
			run: func() error {
				return createCodexMCPConfigQuiet(cwd)
			},
		})
	}
	if hasPlatform(platforms, "cursor") {
		steps = append(steps, initStep{
			label: "Creating Cursor MCP config",
			run: func() error {
				return createCursorMCPConfigQuiet(cwd)
			},
		})
	}
	if hasPlatform(platforms, "antigravity") {
		steps = append(steps, initStep{
			label: "Creating Antigravity rules",
			run: func() error {
				return createAntigravityRulesQuiet(cwd, force)
			},
		})
		steps = append(steps, initStep{
			label: "Creating Antigravity MCP config",
			run: func() error {
				return createAntigravityMCPConfigQuiet(cwd)
			},
		})
	}
	for _, runtimeName := range []string{"claude-code", "codex", "kiro", "opencode"} {
		if !hasPlatform(platforms, runtimeName) {
			continue
		}
		selectedRuntime := runtimeName
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

	steps = append(steps, initStep{
		label: "Creating instruction files",
		run: func() error {
			if target == "all" {
				return createInstructionFilesQuiet(cwd, force)
			}
			return createInstructionFilesForPlatforms(cwd, force, platforms)
		},
	})

	return steps
}

func hasExistingAIIntegrationFiles(projectRoot string) bool {
	paths := []string{
		canonicalInstructionFile,
		"CLAUDE.md",
		"OPENCODE.md",
		"GEMINI.md",
		"AGENTS.md",
		filepath.Join(".github", "copilot-instructions.md"),
		filepath.Join(".kiro", "steering", "knowns.md"),
		filepath.Join(".kiro", "settings", "mcp.json"),
	}
	for _, rel := range paths {
		if _, err := os.Stat(filepath.Join(projectRoot, rel)); err == nil {
			return true
		}
	}
	return false
}

func printSetupSuggestion(projectRoot string) {
	if hasExistingAIIntegrationFiles(projectRoot) {
		fmt.Println(dimStyle.Render("  Run 'knowns setup all' to update existing AI tool integrations"))
		return
	}
	fmt.Println(dimStyle.Render("  Run 'knowns setup all' to configure AI tool integrations"))
}

func init() {
	setupCmd.Flags().BoolP("force", "f", false, "Overwrite generated files where supported")
	rootCmd.AddCommand(setupCmd)
}
