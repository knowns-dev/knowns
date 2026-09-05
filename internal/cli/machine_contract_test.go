package cli

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/runtimeinstall"
	"github.com/spf13/cobra"
)

// TestInstalledHookArgvResolves is the gate for machine-facing commands, which
// the generated CLI reference cannot cover because they are hidden.
//
// runtimeinstall bakes an argv into hook scripts, an OpenCode plugin, and a Kiro
// hook file on users' machines. Those files are written by one version and
// invoked by a later one, so a rename or a dropped flag breaks installations in
// the field with nothing in this repo failing. This installs every adapter into
// a temp HOME, recovers the argv actually written, and resolves it against the
// live command tree.
func TestInstalledHookArgvResolves(t *testing.T) {
	home := t.TempDir()
	// The Kiro adapter resolves its hook path from the working directory
	// (runtimeinstall.kiroIDEHookPath), not from HomeDir. Without this the test
	// writes .kiro/hooks/ into the package source tree, and the scanner never
	// sees that artifact because it walks HomeDir.
	t.Chdir(home)

	opts := runtimeinstall.Options{
		HomeDir:        home,
		ExecutablePath: filepath.Join(home, "bin", "knowns"),
		// Pretend each adapter's CLI is installed so Install writes its artifacts,
		// but not knowns itself, so the argv keeps an absolute path like a real
		// install on a machine without knowns on PATH.
		LookPath: func(name string) (string, error) {
			if name == "knowns" {
				return "", errors.New("knowns not on PATH in tests")
			}
			return filepath.Join(home, "bin", name), nil
		},
		GOOS: runtime.GOOS,
	}

	for _, name := range runtimeinstall.RuntimeNames() {
		if err := runtimeinstall.Install(name, opts); err != nil {
			t.Fatalf("install %s: %v", name, err)
		}
	}

	invocations := scanInvocations(t, home, RootCommand())
	if len(invocations) == 0 {
		t.Fatal("no knowns invocations found in installed artifacts; the scanner or the installer changed")
	}

	sawHook := false
	for _, inv := range invocations {
		cmd, _, err := RootCommand().Find(inv.path)
		if err != nil || cmd == nil || cmd.CommandPath() != "knowns "+strings.Join(inv.path, " ") {
			t.Errorf("%s: installed artifacts invoke %q, which no longer resolves to a command",
				inv.source, strings.Join(inv.path, " "))
			continue
		}
		if !cmd.Runnable() {
			t.Errorf("%s: %q resolves to a group, not a runnable command", inv.source, cmd.CommandPath())
		}
		for _, flag := range inv.flags {
			if cmd.Flags().Lookup(flag) == nil && cmd.InheritedFlags().Lookup(flag) == nil {
				t.Errorf("%s: %q no longer accepts --%s", inv.source, cmd.CommandPath(), flag)
			}
		}
		if strings.Join(inv.path, " ") == "runtime-memory hook" {
			sawHook = true
		}
	}

	if !sawHook {
		t.Error("expected installed artifacts to still invoke the legacy `runtime-memory hook` path")
	}
}

type invocation struct {
	source string
	path   []string
	flags  []string
}

// scanInvocations recovers every knowns invocation written under dir. The three
// artifact kinds spell argv differently — a shell line, a JSON string, and a JS
// array of quoted tokens — so the text is flattened to bare tokens first and
// then walked against the command tree, which works for all three.
func scanInvocations(t *testing.T, dir string, root *cobra.Command) []invocation {
	t.Helper()

	replacer := strings.NewReplacer(`"`, " ", `'`, " ", ",", " ", "[", " ", "]", " ", "\\", " ")

	var found []invocation
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		rel, _ := filepath.Rel(dir, path)
		for _, line := range strings.Split(string(body), "\n") {
			tokens := strings.Fields(replacer.Replace(line))
			for i, tok := range tokens {
				if sub := childNamed(root, tok); sub != nil {
					if inv, ok := walkInvocation(sub, tokens[i+1:]); ok {
						inv.source = rel
						found = append(found, inv)
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	return found
}

// walkInvocation consumes subcommand tokens then flag tokens, returning the
// command path and the flags the artifact passes to it.
func walkInvocation(cmd *cobra.Command, rest []string) (invocation, bool) {
	inv := invocation{path: []string{cmd.Name()}}
	cur := cmd
	i := 0
	for ; i < len(rest); i++ {
		sub := childNamed(cur, rest[i])
		if sub == nil {
			break
		}
		inv.path = append(inv.path, sub.Name())
		cur = sub
	}
	for ; i < len(rest); i++ {
		if !strings.HasPrefix(rest[i], "--") {
			continue
		}
		name := strings.TrimPrefix(rest[i], "--")
		if eq := strings.Index(name, "="); eq >= 0 {
			name = name[:eq]
		}
		if name != "" {
			inv.flags = append(inv.flags, name)
		}
	}
	return inv, len(inv.flags) > 0
}

func childNamed(parent *cobra.Command, name string) *cobra.Command {
	for _, c := range parent.Commands() {
		if c.Name() == name {
			return c
		}
	}
	return nil
}
