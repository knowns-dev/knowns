package cli

import (
	"bytes"
	"strings"
	"testing"
)

// TestQuickstartOmitsInfrastructure guards the whole point of the command. The
// value of `knowns quickstart` is what it leaves out; a later change that helpfully
// adds `knowns qdrant status` to it turns the guide back into the flat command list
// it was written to replace.
func TestQuickstartOmitsInfrastructure(t *testing.T) {
	var buf bytes.Buffer
	SetPlainOutput(true)
	t.Cleanup(func() { SetPlainOutput(false) })
	writeQuickstart(&buf, quickstartGroups)
	got := buf.String()

	for _, name := range []string{"qdrant", "lsp", "provider", "tunnel", "migrate", "reconcile", "audit", "eval", "import", "runtime"} {
		if strings.Contains(got, "knowns "+name) {
			t.Errorf("quickstart mentions infrastructure command %q; it is meant to show only the day-one path", name)
		}
	}
}

// TestQuickstartEndsWithOneAction pins the closing line. A reader who has just
// been shown thirty commands needs exactly one thing to type next.
func TestQuickstartEndsWithOneAction(t *testing.T) {
	var buf bytes.Buffer
	SetPlainOutput(true)
	t.Cleanup(func() { SetPlainOutput(false) })
	writeQuickstart(&buf, quickstartGroups)

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	last := lines[len(lines)-1]
	if !strings.HasPrefix(last, "Run knowns task create") {
		t.Errorf("quickstart should end with a single runnable next action, got %q", last)
	}
}

// TestQuickstartCommandsAreRealCommands catches the failure that makes a guide
// worse than none: telling someone to run a command the binary does not have.
// It checks the first two words of each entry against the actual command tree,
// which is what catches a rename like `memory add` to `memory create`.
func TestQuickstartCommandsAreRealCommands(t *testing.T) {
	root := RootCommand()

	for _, g := range quickstartGroups {
		for _, e := range g.Entries {
			fields := strings.Fields(e.Cmd)
			if len(fields) == 0 || fields[0] != "knowns" {
				continue // flag-only entries, e.g. the --plain line
			}
			path := fields[1:]
			// Trim to the leading non-flag, non-placeholder words: the command path.
			var cmdPath []string
			for _, f := range path {
				if strings.HasPrefix(f, "-") || strings.HasPrefix(f, "<") || strings.HasPrefix(f, `"`) {
					break
				}
				cmdPath = append(cmdPath, f)
			}
			if len(cmdPath) == 0 {
				continue
			}
			found, _, err := root.Find(cmdPath)
			if err != nil || found == nil || found == root {
				t.Errorf("quickstart shows %q but %q is not a command", e.Cmd, strings.Join(cmdPath, " "))
				continue
			}
			if found.Name() != cmdPath[len(cmdPath)-1] {
				t.Errorf("quickstart shows %q but %q resolves to %q", e.Cmd, strings.Join(cmdPath, " "), found.CommandPath())
			}
		}
	}
}

// TestHelpGroupsCoverAllCommands keeps the "Other" bucket empty. The bucket is a
// safety net so a new command can never vanish from --help; this test makes sure
// nobody relies on it, since a command landing there has been given no thought
// about where a reader would look for it.
func TestHelpGroupsCoverAllCommands(t *testing.T) {
	for _, g := range groupRootCommands(RootCommand()) {
		if g.Title == ungroupedTitle {
			t.Errorf("commands %v are not in helpGroups; add them to a group in helpgroups.go", g.Commands)
		}
	}
}

// TestHelpGroupsNameOnlyRealCommands is the other direction: a command removed or
// renamed should not leave a dead entry in the taxonomy.
func TestHelpGroupsNameOnlyRealCommands(t *testing.T) {
	root := RootCommand()
	real := map[string]bool{}
	for _, c := range root.Commands() {
		if isListableCommand(c) {
			real[c.Name()] = true
		}
	}

	for _, g := range helpGroups {
		for _, name := range g.Commands {
			if !real[name] {
				t.Errorf("helpGroups lists %q under %q but there is no such command", name, g.Title)
			}
		}
	}
}

// TestSubcommandRankPutsEverydayVerbsFirst pins the ordering that alphabetical
// sorting got wrong: `knowns task --help` used to open with archive,
// batch-archive, batch-unarchive and hard-delete, burying create at fifth.
func TestSubcommandRankPutsEverydayVerbsFirst(t *testing.T) {
	got := sortSubcommands([]string{
		"archive", "batch-archive", "batch-unarchive", "create", "edit",
		"hard-delete", "history", "list", "unarchive", "view",
	})

	want := []string{"create", "list", "view", "edit", "history"}
	for i, name := range want {
		if got[i] != name {
			t.Fatalf("subcommand order[%d] = %q, want %q (full order: %v)", i, got[i], name, got)
		}
	}

	// Destructive and bulk operations belong at the bottom, whatever they are called.
	for _, name := range []string{"archive", "batch-archive", "batch-unarchive", "hard-delete", "unarchive"} {
		if indexOf(got, name) < len(want) {
			t.Errorf("%q sorted into the everyday verbs at position %d", name, indexOf(got, name))
		}
	}
}

// TestSubcommandRankIsStableAcrossNouns checks the lexicon is generic rather than
// tuned to one command: task, doc, memory and decision share these verbs, and a
// per-command table would be the thing that rots.
func TestSubcommandRankIsStableAcrossNouns(t *testing.T) {
	for _, name := range []string{"task", "doc", "memory", "decision"} {
		found, _, err := RootCommand().Find([]string{name})
		if err != nil || found == nil {
			t.Fatalf("no %q command", name)
		}
		var names []string
		for _, c := range found.Commands() {
			if isListableCommand(c) {
				names = append(names, c.Name())
			}
		}
		if len(names) == 0 {
			continue
		}
		if first := sortSubcommands(names)[0]; first != "create" {
			t.Errorf("knowns %s --help opens with %q, want create", name, first)
		}
	}
}

func indexOf(haystack []string, needle string) int {
	for i, s := range haystack {
		if s == needle {
			return i
		}
	}
	return -1
}
