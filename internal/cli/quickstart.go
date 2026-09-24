package cli

import (
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"
)

// quickstartEntry is one runnable line of the guide.
//
// Desc is optional on purpose. A group of three `task create` variants explains
// itself by the shape of its own flags, and pinning a description to each one
// only adds noise; a lone command like `init` needs the sentence.
type quickstartEntry struct {
	Cmd  string
	Desc string
	Note string
}

// quickstartGroup titles the job the reader is trying to do, not the noun the
// commands operate on. Someone opening this does not yet know Knowns has an
// entity called a Doc; they know they want to find out what the project already
// decided.
type quickstartGroup struct {
	Title   string
	Entries []quickstartEntry
}

// quickstartGroups is the day-one spine of the CLI.
//
// What is missing matters as much as what is here. `qdrant`, `lsp`, `provider`,
// `tunnel`, `migrate`, `reconcile`, `audit`, `eval`, `import` and `runtime` are
// infrastructure: real commands, but nobody reaches for them on the first day,
// and listing all 32 top-level commands flat is exactly the problem this command
// exists to answer. Time tracking is left out for a different reason: it is
// process discipline the project asks of you, not a step in understanding the
// tool, and including it costs the reader the thread.
var quickstartGroups = []quickstartGroup{
	{
		Title: "GETTING STARTED",
		Entries: []quickstartEntry{
			{
				Cmd:  "knowns init",
				Desc: "Initialize Knowns in your project",
				Note: "Creates .knowns/ to hold tasks, docs, and memory",
			},
		},
	},
	{
		Title: "FINDING WHAT IS ALREADY KNOWN",
		Entries: []quickstartEntry{
			{Cmd: `knowns search "auth"`, Desc: "Search tasks and docs together"},
			{Cmd: "knowns doc list", Desc: "List all documentation"},
			{Cmd: `knowns doc "ARCHITECTURE"`, Desc: "Read one doc"},
		},
	},
	{
		Title: "CREATING TASKS",
		Entries: []quickstartEntry{
			{Cmd: `knowns task create "Add JWT auth"`},
			{Cmd: `knowns task create "Add JWT auth" --priority high -l auth`},
			{Cmd: `knowns task create "Add JWT auth" --ac "User receives a token"`},
		},
	},
	{
		Title: "VIEWING TASKS",
		Entries: []quickstartEntry{
			{Cmd: "knowns task list", Desc: "List every task"},
			{Cmd: "knowns task list --status in-progress", Desc: "List only what is being worked on"},
			{Cmd: "knowns task <id>", Desc: "Show one task in full"},
		},
	},
	{
		Title: "DOING THE WORK",
		Entries: []quickstartEntry{
			{Cmd: "knowns task edit <id> -s in-progress", Desc: "Take the task"},
			{Cmd: `knowns task edit <id> --plan "1. ..."`, Desc: "Record the plan before coding"},
			{Cmd: "knowns task edit <id> --check-ac 1", Desc: "Tick a criterion once it is done"},
			{Cmd: "knowns task edit <id> -s done", Desc: "Finish"},
		},
	},
	{
		Title: "CAPTURING WHAT YOU LEARNED",
		Entries: []quickstartEntry{
			{Cmd: `knowns memory create "Title" -c "..."`, Desc: "A durable insight, carried into later sessions"},
			{Cmd: `knowns doc create "Pattern: X" -f patterns`, Desc: "A doc, when the knowledge needs room"},
			{Cmd: `knowns decision create "..."`, Desc: "Guidance the whole project should follow"},
		},
	},
	{
		Title: "FOR AI AGENTS",
		Entries: []quickstartEntry{
			{Cmd: "--plain", Desc: "Parseable output; valid on every command"},
			{Cmd: "--json", Desc: "Structured output; valid on every command"},
		},
	},
}

// quickstartAlignCap keeps the description column from being shoved to the right
// margin by one long example. Anything wider than this prints on its own line and
// the group aligns to the entries that fit.
const quickstartAlignCap = 42

var quickstartCmd = &cobra.Command{
	Use:   "quickstart",
	Short: "Show the short path from an empty project to a finished task",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		writeQuickstart(cmd.OutOrStdout(), quickstartGroups)
		return nil
	},
}

func writeQuickstart(out io.Writer, groups []quickstartGroup) {
	fmt.Fprintf(out, "%s %s\n", StyleBold.Render("knowns"), "- the memory layer for AI-native software development")

	for _, g := range groups {
		fmt.Fprintln(out)
		fmt.Fprintln(out, StyleBold.Render(g.Title))

		width := quickstartColumn(g.Entries)
		for _, e := range g.Entries {
			if e.Desc == "" || len(e.Cmd) > width {
				fmt.Fprintf(out, "  %s\n", StyleInfo.Render(e.Cmd))
				if e.Desc != "" {
					fmt.Fprintf(out, "  %s%s\n", strings.Repeat(" ", width+2), e.Desc)
				}
			} else {
				pad := strings.Repeat(" ", width-len(e.Cmd)+2)
				fmt.Fprintf(out, "  %s%s%s\n", StyleInfo.Render(e.Cmd), pad, e.Desc)
			}
			if e.Note != "" {
				fmt.Fprintf(out, "  %s%s\n", strings.Repeat(" ", width+2), e.Note)
			}
		}
	}

	fmt.Fprintln(out)
	fmt.Fprintln(out, StyleBold.Render("Ready to start!"))
	fmt.Fprintf(out, "Run %s to create your first task.\n", StyleInfo.Render(`knowns task create "My first task"`))
}

// quickstartColumn is the width the described commands in a group align to:
// the widest one that fits under the cap. A group whose entries are all wide,
// or all undescribed, gets zero and every line stands alone.
func quickstartColumn(entries []quickstartEntry) int {
	width := 0
	for _, e := range entries {
		if e.Desc == "" && e.Note == "" {
			continue
		}
		if n := len(e.Cmd); n > width && n <= quickstartAlignCap {
			width = n
		}
	}
	return width
}

func init() {
	rootCmd.AddCommand(quickstartCmd)
}
