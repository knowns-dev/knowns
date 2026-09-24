package cli

import (
	"sort"

	"github.com/spf13/cobra"
)

// helpGroup is one section of the root `--help` command list.
//
// The root command tree has grown past thirty entries, and printed flat and
// alphabetical it gave `qdrant`, `tunnel` and `reconcile` exactly the same
// weight as `task` and `doc`. Grouping is what lets the list stay complete,
// which is what a reference is for, while still saying which handful of
// commands a reader actually needs.
type helpGroup struct {
	Title    string
	Commands []string
}

// helpGroups orders the root command list. Order here is the order printed,
// so the groups run from what you reach for daily down to what you touch once.
//
// Group membership is kept in this one table rather than as a GroupID on each
// command, so the whole taxonomy is reviewable in a single diff instead of
// spread across thirty files that each declare their own importance.
var helpGroups = []helpGroup{
	{
		Title:    "Tasks, docs, and memory",
		Commands: []string{"task", "doc", "decision", "memory", "search", "retrieve", "resolve", "template", "time"},
	},
	{
		Title:    "Project setup and health",
		Commands: []string{"init", "quickstart", "status", "doctor", "config", "settings", "sync", "setup", "agents", "validate"},
	},
	{
		Title:    "Code intelligence",
		Commands: []string{"code", "lsp"},
	},
	{
		Title:    "Advanced",
		Commands: []string{"mcp", "runtime", "browser", "tunnel", "qdrant", "provider", "audit", "eval", "import", "migrate", "reconcile", "update"},
	},
}

// ungroupedTitle collects any visible command the table forgot. A command that
// is not in helpGroups still has to appear somewhere: silently dropping it from
// `--help` would be a worse failure than listing it under a vague heading.
// TestHelpGroupsCoverAllCommands keeps this section empty in practice.
const ungroupedTitle = "Other"

// groupRootCommands buckets cmd's visible subcommands by helpGroups, preserving
// group order and dropping empty groups.
func groupRootCommands(cmd *cobra.Command) []helpGroup {
	remaining := map[string]*cobra.Command{}
	for _, c := range cmd.Commands() {
		if !isListableCommand(c) {
			continue
		}
		remaining[c.Name()] = c
	}

	var out []helpGroup
	for _, g := range helpGroups {
		var found []string
		for _, name := range g.Commands {
			if _, ok := remaining[name]; !ok {
				continue
			}
			found = append(found, name)
			delete(remaining, name)
		}
		if len(found) > 0 {
			out = append(out, helpGroup{Title: g.Title, Commands: found})
		}
	}

	if len(remaining) > 0 {
		var leftover []string
		for _, c := range cmd.Commands() {
			if _, ok := remaining[c.Name()]; ok {
				leftover = append(leftover, c.Name())
			}
		}
		out = append(out, helpGroup{Title: ungroupedTitle, Commands: leftover})
	}

	return out
}

// isListableCommand reports whether a subcommand belongs in a rendered command
// list. `help` and `completion` are cobra's own and carry no project meaning.
func isListableCommand(c *cobra.Command) bool {
	return c.IsAvailableCommand() && c.Name() != "help" && c.Name() != "completion"
}

// subcommandRank orders a command's own subcommand list by what a reader reaches
// for, rather than by spelling. Sorted alphabetically, `knowns task --help` led
// with archive, batch-archive, batch-unarchive and hard-delete, so the four
// rarest and most destructive entries occupied the top of the list and `create`
// came fifth.
//
// The lexicon is deliberately generic rather than a per-command table: task, doc,
// memory and decision all share these verbs, and a new noun command gets sensible
// ordering without registering anything.
func subcommandRank(name string) int {
	switch name {
	case "create", "new", "init":
		return 0
	case "list", "inbox":
		return 1
	case "view", "get", "show":
		return 2
	case "edit", "update":
		return 3
	case "archive", "unarchive", "batch-archive", "batch-unarchive", "delete", "hard-delete", "cleanup":
		return 5
	default:
		return 4
	}
}

// sortSubcommands returns names ordered by rank, then alphabetically within a rank.
func sortSubcommands(names []string) []string {
	out := append([]string(nil), names...)
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := subcommandRank(out[i]), subcommandRank(out[j])
		if ri != rj {
			return ri < rj
		}
		return out[i] < out[j]
	})
	return out
}
