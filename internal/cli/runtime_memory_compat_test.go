package cli

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func find(root *cobra.Command, path ...string) *cobra.Command {
	cur := root
	for _, name := range path {
		var next *cobra.Command
		for _, c := range cur.Commands() {
			if c.Name() == name {
				next = c
				break
			}
		}
		if next == nil {
			return nil
		}
		cur = next
	}
	return cur
}

// TestRuntimeMemoryLegacyPathStillRuns guards the compatibility path. Every hook
// script, OpenCode plugin, and Kiro hook file that runtimeinstall has written
// invokes `knowns runtime-memory hook`, and doctor matches that exact string
// (internal/runtimeinstall/runtimeinstall.go). Removing it silently breaks every
// installation already in the field.
func TestRuntimeMemoryLegacyPathStillRuns(t *testing.T) {
	root := RootCommand()

	legacy := find(root, "runtime-memory", "hook")
	if legacy == nil {
		t.Fatal("knowns runtime-memory hook must stay runnable for installed hooks")
	}
	if !legacy.Runnable() {
		t.Error("legacy hook command must be runnable, not just present")
	}
	if parent := find(root, "runtime-memory"); parent != nil && !parent.Hidden {
		t.Error("legacy runtime-memory should be hidden from help")
	}

	modern := find(root, "runtime", "memory", "hook")
	if modern == nil {
		t.Fatal("knowns runtime memory hook should be the discoverable path")
	}

	// Both paths must accept the same flags, or one of them silently diverges.
	for _, name := range []string{"runtime", "event", "project", "cwd", "mode", "capture", "max-items", "max-bytes"} {
		if legacy.Flags().Lookup(name) == nil {
			t.Errorf("legacy hook missing --%s", name)
		}
		if modern.Flags().Lookup(name) == nil {
			t.Errorf("runtime memory hook missing --%s", name)
		}
	}
}

// TestTopLevelCommandsAreGrouped keeps a second top-level command from
// reappearing beside the noun it belongs under.
func TestTopLevelCommandsAreGrouped(t *testing.T) {
	for _, c := range RootCommand().Commands() {
		if c.Hidden || !c.IsAvailableCommand() {
			continue
		}
		if strings.Contains(c.Name(), "-") && strings.HasPrefix(c.Name(), "runtime") {
			t.Errorf("%q should be a subcommand of runtime, not a top-level command", c.Name())
		}
	}
}
