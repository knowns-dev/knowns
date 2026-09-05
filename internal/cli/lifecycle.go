package cli

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

// Retiring a command is a lifecycle, not a delete. This file holds the whole
// list, so "what is going away, and when" is one file to read rather than a
// grep across the tree.
//
//	active     -> not listed here
//	deprecated -> still works; scheduled to go
//	removed    -> a tombstone that refuses with a reason, not "unknown command"
//
// The contract snapshot (TestCommandContract) records the state, so moving a
// command between states is a reviewed diff, and lifecycle_test.go refuses a
// deprecated command that vanishes without first becoming a tombstone.
type lifecycleState string

const (
	stateDeprecated lifecycleState = "deprecated"
	stateRemoved    lifecycleState = "removed"
)

// tombstoneAnnotation marks a command that exists only to report its own
// removal, so tests can tell it apart from the command it replaced.
const tombstoneAnnotation = "knowns.lifecycle/removed-in"

// isTombstone reports whether cmd is a removal marker rather than a real command.
func isTombstone(cmd *cobra.Command) bool {
	_, ok := cmd.Annotations[tombstoneAnnotation]
	return ok
}

type lifecycleEntry struct {
	// Path is the command path below the root, e.g. {"runtime-memory", "hook"}.
	Path  []string
	State lifecycleState

	// Since is the version the command entered this state.
	Since string

	// Replacement is the path users (or scripts) should move to.
	Replacement string

	// Reason explains why, and shows up in a tombstone's error.
	Reason string

	// Announce prints a warning when the command runs.
	//
	// It MUST stay false for anything a machine invokes. cobra writes the
	// warning through OutOrStderr, so it lands on stdout the moment something
	// calls SetOut, and adapters that capture combined output feed it straight
	// into the agent's context either way. `runtime-memory hook` emits the
	// memory payload itself, which is exactly the output that must stay clean.
	Announce bool
}

func (e lifecycleEntry) path() string { return strings.Join(e.Path, " ") }

// commandLifecycle is the full retirement schedule.
var commandLifecycle = []lifecycleEntry{
	{
		Path:        []string{"runtime-memory"},
		State:       stateDeprecated,
		Since:       "0.33.0",
		Replacement: "knowns runtime memory",
		Reason:      "grouped under the runtime noun instead of sitting beside it",
		// Silent on purpose: runtimeinstall baked this path into hook scripts,
		// the OpenCode plugin, and Kiro hook files already on users' machines.
		// It cannot be removed until those are all refreshed.
		Announce: false,
	},
}

// applyLifecycle wires the schedule into the command tree. Call it after every
// command is registered.
func applyLifecycle(root *cobra.Command) {
	for _, entry := range commandLifecycle {
		switch entry.State {
		case stateDeprecated:
			cmd := findByPath(root, entry.Path)
			if cmd == nil {
				// lifecycle_test.go turns this into a build-time failure; at
				// runtime there is nothing useful to do.
				continue
			}
			cmd.Hidden = true
			if entry.Announce {
				cmd.Deprecated = fmt.Sprintf("use %q instead (since %s)", entry.Replacement, entry.Since)
			}
		case stateRemoved:
			addTombstone(root, entry)
		}
	}
}

// addTombstone registers a command that exists only to explain its own absence.
// Without it the user gets cobra's "unknown command", which says nothing about
// what replaced it.
func addTombstone(root *cobra.Command, entry lifecycleEntry) {
	parent := root
	for _, name := range entry.Path[:len(entry.Path)-1] {
		next := childByName(parent, name)
		if next == nil {
			next = &cobra.Command{Use: name, Hidden: true}
			parent.AddCommand(next)
		}
		parent = next
	}

	leaf := entry.Path[len(entry.Path)-1]
	if childByName(parent, leaf) != nil {
		// The command is still registered, so the schedule and the tree
		// disagree. Shadowing a working command would be worse than doing
		// nothing; lifecycle_test.go fails on the contradiction instead.
		return
	}

	msg := fmt.Sprintf("%q was removed in %s", "knowns "+entry.path(), entry.Since)
	if entry.Reason != "" {
		msg += ": " + entry.Reason
	}
	if entry.Replacement != "" {
		msg += fmt.Sprintf("\nUse %q instead.", entry.Replacement)
	}

	parent.AddCommand(&cobra.Command{
		Use:                leaf,
		Hidden:             true,
		DisableFlagParsing: true, // old call sites still pass their old flags
		Annotations:        map[string]string{tombstoneAnnotation: entry.Since},
		RunE: func(*cobra.Command, []string) error {
			return fmt.Errorf("%s", msg)
		},
	})
}

func findByPath(root *cobra.Command, path []string) *cobra.Command {
	cur := root
	for _, name := range path {
		cur = childByName(cur, name)
		if cur == nil {
			return nil
		}
	}
	return cur
}

func childByName(parent *cobra.Command, name string) *cobra.Command {
	for _, c := range parent.Commands() {
		if c.Name() == name {
			return c
		}
	}
	return nil
}

// lifecycleStateOf reports the scheduled state of a full command path
// ("knowns runtime-memory"), or "" when the command is active.
func lifecycleStateOf(commandPath string) string {
	trimmed := strings.TrimPrefix(commandPath, "knowns ")
	for _, entry := range commandLifecycle {
		if entry.path() == trimmed {
			return string(entry.State)
		}
	}
	return ""
}
