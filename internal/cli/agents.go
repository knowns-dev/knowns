package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

// agentPlatform defines a supported AI agent platform and its instruction file.
type agentPlatform struct {
	Name     string // short name (e.g., "claude")
	FileName string // instruction file name relative to project root
	Label    string // display name
}

// knownPlatforms lists the canonical guidance file plus supported AI agent platforms.
var knownPlatforms = []agentPlatform{
	{Name: "knowns", FileName: canonicalInstructionFile, Label: "Knowns Canonical Guide"},
	{Name: "claude", FileName: "CLAUDE.md", Label: "Claude Code"},
	{Name: "opencode", FileName: "OPENCODE.md", Label: "OpenCode"},
	{Name: "gemini", FileName: "GEMINI.md", Label: "Google Gemini"},
	{Name: "copilot", FileName: filepath.Join(".github", "copilot-instructions.md"), Label: "GitHub Copilot"},
	{Name: "agents", FileName: "AGENTS.md", Label: "Generic Agents"},
}

var agentsCmd = &cobra.Command{
	Use:   "agents",
	Short: "Manage agent instruction files",
	Long: `Manage the canonical guidance file and AI agent instruction files
(KNOWNS.md, CLAUDE.md, OPENCODE.md, GEMINI.md, AGENTS.md,
.github/copilot-instructions.md).

Shows the status of instruction files for each supported AI platform and
can sync/generate them from project configuration.`,
	RunE: runAgents,
}

func runAgents(cmd *cobra.Command, args []string) error {
	store, err := getStoreErr()
	if err != nil {
		return err
	}

	jsonOut := isJSON(cmd)

	projectRoot := filepath.Dir(store.Root)

	return runAgentsStatus(cmd, projectRoot, jsonOut)
}

// runAgentsStatus displays the current status of all agent instruction files.
func runAgentsStatus(cmd *cobra.Command, projectRoot string, jsonOut bool) error {
	type platformStatus struct {
		Name      string `json:"name"`
		Label     string `json:"label"`
		FileName  string `json:"fileName"`
		Exists    bool   `json:"exists"`
		SizeBytes int64  `json:"sizeBytes,omitempty"`
	}

	statuses := make([]platformStatus, 0, len(knownPlatforms))
	for _, p := range knownPlatforms {
		fullPath := filepath.Join(projectRoot, p.FileName)
		ps := platformStatus{
			Name:     p.Name,
			Label:    p.Label,
			FileName: p.FileName,
		}
		if info, err := os.Stat(fullPath); err == nil {
			ps.Exists = true
			ps.SizeBytes = info.Size()
		}
		statuses = append(statuses, ps)
	}

	if jsonOut {
		printJSON(statuses)
		return nil
	}

	plain := isPlain(cmd)

	if plain {
		fmt.Printf("PLATFORMS: %d\n\n", len(statuses))
		for _, ps := range statuses {
			status := "missing"
			if ps.Exists {
				status = "exists"
			}
			fmt.Printf("PLATFORM: %s\n", ps.Name)
			fmt.Printf("  LABEL: %s\n", ps.Label)
			fmt.Printf("  FILE: %s\n", ps.FileName)
			fmt.Printf("  STATUS: %s\n", status)
			if ps.Exists {
				fmt.Printf("  SIZE: %d bytes\n", ps.SizeBytes)
			}
			fmt.Println()
		}
	} else {
		fmt.Println(RenderSectionHeader("Agent Instruction Files"))
		fmt.Println(RenderSeparator(70))
		fmt.Printf("%s  %s  %s\n",
			StyleBold.Render(fmt.Sprintf("%-16s", "PLATFORM")),
			StyleBold.Render(fmt.Sprintf("%-45s", "FILE")),
			StyleBold.Render("STATUS"))
		fmt.Println(RenderSeparator(70))
		for _, ps := range statuses {
			statusStr := StyleWarning.Render("missing")
			if ps.Exists {
				statusStr = StyleSuccess.Render("exists")
			}
			fmt.Printf("%-16s  %-45s  %s\n", ps.Label, ps.FileName, statusStr)
		}
		fmt.Println()

		// Count existing
		existing := 0
		for _, ps := range statuses {
			if ps.Exists {
				existing++
			}
		}
		fmt.Printf("%s of %d instruction files found.\n", StyleBold.Render(fmt.Sprintf("%d", existing)), len(statuses))

		if existing < len(statuses) {
			fmt.Println(StyleDim.Render("Use 'knowns agents --sync' to generate missing files."))
		}
	}

	return nil
}

func init() {
	rootCmd.AddCommand(agentsCmd)
}
