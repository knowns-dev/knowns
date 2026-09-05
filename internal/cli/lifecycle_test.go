package cli

import (
	"strings"
	"testing"
)

// TestLifecycleEntriesResolve keeps the schedule honest: you cannot deprecate a
// command that does not exist, and a removed one must answer with a reason
// rather than cobra's "unknown command".
func TestLifecycleEntriesResolve(t *testing.T) {
	root := RootCommand()

	for _, entry := range commandLifecycle {
		cmd := findByPath(root, entry.Path)
		if cmd == nil {
			t.Errorf("%s: listed as %s but no such command; a deprecated command must stay registered, and a removed one needs its tombstone", entry.path(), entry.State)
			continue
		}

		switch entry.State {
		case stateDeprecated:
			if !cmd.Hidden {
				t.Errorf("%s: deprecated commands should be hidden from help", entry.path())
			}
		case stateRemoved:
			// Without this the test would call the live command's RunE and
			// report success for a removal that never happened.
			if !isTombstone(cmd) {
				t.Errorf("%s: listed as removed but the real command is still registered; delete it, or drop the lifecycle entry", entry.path())
				continue
			}
			if !cmd.Runnable() {
				t.Errorf("%s: tombstone must be runnable so it can explain itself", entry.path())
				continue
			}
			err := cmd.RunE(cmd, nil)
			if err == nil {
				t.Errorf("%s: tombstone must fail, not succeed silently", entry.path())
				continue
			}
			if entry.Replacement != "" && !strings.Contains(err.Error(), entry.Replacement) {
				t.Errorf("%s: tombstone error should point at %q, got: %v", entry.path(), entry.Replacement, err)
			}
		}

		if entry.Since == "" {
			t.Errorf("%s: needs the version it entered %s", entry.path(), entry.State)
		}
	}
}

// TestMachineFacingCommandsStaySilent is the rule that cost the most to learn.
// cobra prints its deprecation notice through OutOrStderr, so it reaches stdout
// as soon as anything calls SetOut, and adapters capturing combined output feed
// it into the agent's context regardless. Any command whose output a machine
// parses must therefore never announce.
func TestMachineFacingCommandsStaySilent(t *testing.T) {
	// Paths invoked by installed hook files or by the binary re-execing itself.
	machineFacing := map[string]bool{
		"runtime-memory":      true,
		"runtime-memory hook": true,
		"runtime memory hook": true,
		"__runtime":           true,
		"__runtime run":       true,
		"__runtime status":    true,
		"__lsp-daemon":        true,
		"__lsp-daemon run":    true,
	}

	for _, entry := range commandLifecycle {
		if machineFacing[entry.path()] && entry.Announce {
			t.Errorf("%s is machine-facing; Announce must stay false or the warning corrupts the payload its caller parses", entry.path())
		}
	}

	root := RootCommand()
	for path := range machineFacing {
		cmd := findByPath(root, strings.Fields(path))
		if cmd == nil {
			continue
		}
		if cmd.Deprecated != "" {
			t.Errorf("%s has cobra Deprecated set; that prints into output a machine parses", path)
		}
	}
}

// TestDeprecatedCommandsStillRun guards the whole point of deprecation: the
// command keeps working until its removal date.
func TestDeprecatedCommandsStillRun(t *testing.T) {
	root := RootCommand()
	for _, entry := range commandLifecycle {
		if entry.State != stateDeprecated {
			continue
		}
		cmd := findByPath(root, entry.Path)
		if cmd == nil {
			continue
		}
		if !cmd.Runnable() && len(cmd.Commands()) == 0 {
			t.Errorf("%s: deprecated command is neither runnable nor a group; it is effectively removed without a tombstone", entry.path())
		}
	}
}
