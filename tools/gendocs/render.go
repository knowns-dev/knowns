package main

import (
	"fmt"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// pageName is the file a command's page lives in: `knowns task create` becomes
// knowns_task_create.md, matching the command path so a reader can guess it.
func pageName(c *cobra.Command) string {
	return strings.ReplaceAll(c.CommandPath(), " ", "_") + ".md"
}

// renderTree walks every visible command and returns filename -> contents.
func renderTree(root *cobra.Command) map[string][]byte {
	pages := map[string][]byte{}
	var walk func(*cobra.Command)
	walk = func(c *cobra.Command) {
		if !c.IsAvailableCommand() && c != root {
			return
		}
		if c.Name() == "help" {
			return
		}
		pages[pageName(c)] = []byte(renderPage(c))
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	walk(root)
	return pages
}

// renderPage renders one command. The version is deliberately left out: it
// changes every release and would turn the drift gate into noise.
func renderPage(c *cobra.Command) string {
	var b strings.Builder

	fmt.Fprintf(&b, "# %s\n\n", c.CommandPath())
	if s := strings.TrimSpace(c.Short); s != "" {
		fmt.Fprintf(&b, "%s\n\n", s)
	}
	if l := strings.TrimSpace(c.Long); l != "" && l != strings.TrimSpace(c.Short) {
		fmt.Fprintf(&b, "%s\n\n", l)
	}

	if c.Runnable() {
		b.WriteString("## Usage\n\n```\n" + c.UseLine() + "\n```\n\n")
	}
	if e := strings.TrimSpace(c.Example); e != "" {
		b.WriteString("## Examples\n\n```bash\n" + e + "\n```\n\n")
	}

	writeFlags(&b, "Flags", c.NonInheritedFlags())
	writeFlags(&b, "Inherited flags", c.InheritedFlags())

	var subs []*cobra.Command
	for _, sub := range c.Commands() {
		if sub.IsAvailableCommand() && sub.Name() != "help" {
			subs = append(subs, sub)
		}
	}
	if len(subs) > 0 {
		sort.Slice(subs, func(i, j int) bool { return subs[i].Name() < subs[j].Name() })
		b.WriteString("## Subcommands\n\n")
		for _, sub := range subs {
			fmt.Fprintf(&b, "- [`%s`](%s) — %s\n", sub.CommandPath(), pageName(sub), strings.TrimSpace(sub.Short))
		}
		b.WriteString("\n")
	}

	if p := c.Parent(); p != nil {
		fmt.Fprintf(&b, "## See also\n\n- [`%s`](%s) — %s\n\n", p.CommandPath(), pageName(p), strings.TrimSpace(p.Short))
	}

	b.WriteString("---\n\nGenerated from the command tree by `make cli-docs`. Do not edit by hand.\n")
	return b.String()
}

func writeFlags(b *strings.Builder, heading string, fs *pflag.FlagSet) {
	if !fs.HasAvailableFlags() {
		return
	}
	fmt.Fprintf(b, "## %s\n\n| Flag | Type | Default | Description |\n|---|---|---|---|\n", heading)
	fs.VisitAll(func(f *pflag.Flag) {
		if f.Hidden {
			return
		}
		name := "`--" + f.Name + "`"
		if f.Shorthand != "" {
			name = "`-" + f.Shorthand + ", --" + f.Name + "`"
		}
		def := "—"
		if f.DefValue != "" && f.DefValue != "false" && f.DefValue != "[]" {
			def = "`" + f.DefValue + "`"
		}
		fmt.Fprintf(b, "| %s | `%s` | %s | %s |\n", name, f.Value.Type(), def, escapePipes(strings.TrimSpace(f.Usage)))
	})
	b.WriteString("\n")
}

// escapePipes keeps a flag description with a literal | from breaking the table.
func escapePipes(s string) string { return strings.ReplaceAll(s, "|", `\|`) }
