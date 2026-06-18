package cli

import (
	"fmt"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/readiness"
	"github.com/spf13/cobra"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show project readiness summary",
	Long: `Display a unified readiness summary for the active Knowns project.

Shows project identity, knowledge counts, search status, runtime health,
and available capabilities in one view.

Use --json for structured output consumed by scripts or AI clients.
Use --plain for clean text output suitable for piping.`,
	RunE: runStatus,
}

func runStatus(cmd *cobra.Command, args []string) error {
	store, err := getStoreErr()
	if err != nil {
		if isJSON(cmd) {
			printJSON(readiness.InactivePayload())
			return nil
		}
		return err
	}

	payload := readiness.BuildReadiness(store, readiness.Options{})

	if isJSON(cmd) {
		printJSON(payload)
		return nil
	}

	if isPlain(cmd) {
		renderStatusPlain(payload)
		return nil
	}

	renderStatusStyled(payload)
	return nil
}

func renderStatusPlain(p readiness.Payload) {
	if !p.Active {
		fmt.Println("No active project.")
		return
	}

	fmt.Printf("Project: %s (%s)\n", p.ProjectName, p.ProjectPath)
	fmt.Printf("Version: %s\n", p.Version)

	if p.Knowledge != nil {
		k := p.Knowledge
		totalMem := k.Memories.Project + k.Memories.Global
		fmt.Printf("Knowledge: %d docs, %d tasks, %d templates, %d memories, %d relations\n",
			k.Docs, k.Tasks, k.Templates, totalMem, k.Relations)
		if k.Imports > 0 {
			fmt.Printf("Imports: %d active sources\n", k.Imports)
		}
	}

	if p.Search != nil {
		s := p.Search
		if s.SemanticEnabled && s.ModelInstalled && s.ProjectIndexReady {
			freshness := "unknown"
			if s.LastReindex != nil {
				freshness = formatTimeSince(*s.LastReindex)
			}
			fmt.Printf("Search: semantic ready, indices fresh (%s)\n", freshness)
		} else if s.SemanticEnabled && !s.ModelInstalled {
			fmt.Println("Search: semantic enabled but model not installed")
		} else if s.SemanticEnabled && !s.ProjectIndexReady {
			fmt.Println("Search: semantic enabled but index empty (run: knowns search --reindex)")
		} else {
			fmt.Println("Search: keyword-only mode")
		}
	}

	if p.Runtime != nil {
		r := p.Runtime
		if r.Running {
			fmt.Printf("Runtime: %s, %d clients, %d queued, %d running\n",
				r.State, r.ConnectedClients, r.QueuedJobs, r.RunningJobs)
		} else if r.Enabled {
			fmt.Println("Runtime: enabled but not running")
		} else {
			fmt.Println("Runtime: disabled")
		}
	} else {
		fmt.Println("Runtime: not running")
	}

	if len(p.LSP) > 0 {
		parts := make([]string, 0, len(p.LSP))
		for _, item := range p.LSP {
			detail := item.Status
			if item.Backend != "" {
				detail += "/" + item.Backend
			}
			if item.ReadinessState != "" && item.ReadinessState != "not_applicable" {
				detail += " readiness=" + item.ReadinessState
			}
			if item.Status == "not_installed" && item.InstallCmd != "" {
				parts = append(parts, fmt.Sprintf("%s=%s (run: %s)", item.ID, item.Status, item.InstallCmd))
			} else {
				parts = append(parts, fmt.Sprintf("%s=%s", item.ID, detail))
			}
		}
		fmt.Printf("LSP: %s\n", strings.Join(parts, ", "))
	}

	if len(p.Capabilities) > 0 {
		fmt.Printf("Capabilities: %s\n", strings.Join(p.Capabilities, ", "))
	}
}

func renderStatusStyled(p readiness.Payload) {
	if !p.Active {
		fmt.Println(StyleWarning.Render("No active project."))
		return
	}

	// Header
	fmt.Printf("%s %s\n", StyleBold.Render("Project:"), StyleSuccess.Render(p.ProjectName))
	fmt.Printf("%s %s\n", StyleDim.Render("  Path:"), p.ProjectPath)
	fmt.Printf("%s %s\n", StyleDim.Render("  Version:"), p.Version)
	fmt.Println()

	// Knowledge
	if p.Knowledge != nil {
		k := p.Knowledge
		totalMem := k.Memories.Project + k.Memories.Global
		fmt.Println(StyleBold.Render("Knowledge"))
		fmt.Printf("  %s %d docs, %d tasks, %d templates\n",
			StyleSuccess.Render("✓"), k.Docs, k.Tasks, k.Templates)
		fmt.Printf("  %s %d memories (%d project, %d global)\n",
			StyleSuccess.Render("✓"), totalMem, k.Memories.Project, k.Memories.Global)
		if k.Relations > 0 {
			fmt.Printf("  %s %d relations\n", StyleSuccess.Render("✓"), k.Relations)
		}
		if k.Imports > 0 {
			fmt.Printf("  %s %d import sources\n", StyleInfo.Render("↓"), k.Imports)
		}
		fmt.Println()
	}

	// Search
	if p.Search != nil {
		s := p.Search
		fmt.Println(StyleBold.Render("Search"))
		if s.SemanticEnabled && s.ModelInstalled && s.ProjectIndexReady {
			freshness := "unknown"
			if s.LastReindex != nil {
				freshness = formatTimeSince(*s.LastReindex)
			}
			fmt.Printf("  %s semantic ready, indices fresh (%s)\n", StyleSuccess.Render("✓"), freshness)
		} else if !s.SemanticEnabled {
			fmt.Printf("  %s keyword-only mode\n", StyleDim.Render("○"))
		} else if !s.ModelInstalled {
			fmt.Printf("  %s model not installed\n", StyleWarning.Render("⚠"))
		} else if !s.ProjectIndexReady {
			fmt.Printf("  %s index empty — run: knowns search --reindex\n", StyleWarning.Render("⚠"))
		}
		fmt.Println()
	}

	// Runtime
	if p.Runtime != nil {
		r := p.Runtime
		fmt.Println(StyleBold.Render("Runtime"))
		if r.Running && r.State == "healthy" {
			fmt.Printf("  %s healthy, %d clients, %d queued, %d running\n",
				StyleSuccess.Render("✓"), r.ConnectedClients, r.QueuedJobs, r.RunningJobs)
		} else if r.Running && r.State == "degraded" {
			fmt.Printf("  %s degraded, %d clients\n", StyleWarning.Render("⚠"), r.ConnectedClients)
		} else if r.Enabled {
			fmt.Printf("  %s enabled but not running\n", StyleWarning.Render("⚠"))
		} else {
			fmt.Printf("  %s disabled\n", StyleDim.Render("○"))
		}
		fmt.Println()
	} else {
		fmt.Println(StyleBold.Render("Runtime"))
		fmt.Printf("  %s not running\n", StyleDim.Render("○"))
		fmt.Println()
	}

	// LSP
	if len(p.LSP) > 0 {
		fmt.Println(StyleBold.Render("LSP"))
		for _, item := range p.LSP {
			marker := StyleDim.Render("○")
			if item.Status == "running" || item.Status == "installed" {
				marker = StyleSuccess.Render("✓")
			} else if item.Status == "not_installed" && item.InstallCmd != "" {
				marker = StyleWarning.Render("⚠")
			}
			line := fmt.Sprintf("  %s %s: %s", marker, item.ID, item.Status)
			if item.Backend != "" {
				line += fmt.Sprintf(" backend=%s", item.Backend)
			}
			if item.Binary != "" {
				line += fmt.Sprintf(" (%s via %s)", item.Binary, item.Source)
			}
			if item.ReadinessState != "" && item.ReadinessState != "not_applicable" {
				line += fmt.Sprintf(" readiness=%s", item.ReadinessState)
			}
			if item.LogPath != "" {
				line += fmt.Sprintf(" log=%s", item.LogPath)
			}
			fmt.Println(line)
			if item.Status == "not_installed" && item.InstallCmd != "" {
				fmt.Printf("    Run: %s\n", item.InstallCmd)
			}
		}
		fmt.Println()
	}

	// Capabilities
	if len(p.Capabilities) > 0 {
		fmt.Println(StyleBold.Render("Capabilities"))
		fmt.Printf("  %s\n", strings.Join(p.Capabilities, ", "))
		fmt.Println()
	}
}

func formatTimeSince(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func init() {
	rootCmd.AddCommand(statusCmd)
}
