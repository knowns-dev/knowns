package cli

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

var updateContract = flag.Bool("update-contract", false, "rewrite testdata/command-contract.txt")

const contractPath = "testdata/command-contract.txt"

// TestCommandContract locks the whole command surface, hidden commands included.
//
// The generated CLI reference (tools/gendocs) only covers what a human can see,
// so it says nothing about `__runtime run`, `__lsp-daemon run`, or the legacy
// `runtime-memory hook`. Those are invoked by other processes — the binary
// re-execing itself, or hook files written to a user's machine — where a rename
// or a dropped flag fails at runtime, far from this repo. This snapshot makes
// any such change a visible diff a reviewer has to approve.
//
// Regenerate with: go test ./internal/cli -run TestCommandContract -update-contract
func TestCommandContract(t *testing.T) {
	got := renderContract(RootCommand())

	if *updateContract {
		// The directory is absent on a tree that has never had the snapshot,
		// which is exactly when someone is regenerating it.
		if err := os.MkdirAll(filepath.Dir(contractPath), 0o755); err != nil {
			t.Fatalf("create %s: %v", filepath.Dir(contractPath), err)
		}
		if err := os.WriteFile(contractPath, []byte(got), 0o644); err != nil {
			t.Fatalf("write %s: %v", contractPath, err)
		}
		t.Logf("rewrote %s", contractPath)
		return
	}

	raw, err := os.ReadFile(contractPath)
	if err != nil {
		t.Fatalf("read %s (regenerate with -update-contract): %v", contractPath, err)
	}
	// git checks the snapshot out with CRLF wherever core.autocrlf is on, which
	// is the default on the Windows runners. Comparing raw bytes there reports
	// every line as changed and says nothing about the command surface.
	want := strings.ReplaceAll(string(raw), "\r\n", "\n")
	if want == got {
		return
	}

	for _, line := range diffLines(strings.Split(want, "\n"), strings.Split(got, "\n")) {
		t.Error(line)
	}
	t.Fatalf("command surface changed; if intended, regenerate:\n" +
		"  go test ./internal/cli -run TestCommandContract -update-contract\n" +
		"  make cli-docs")
}

// renderContract prints one line per command: its path, whether it is hidden and
// runnable, and its own flags with types.
func renderContract(root *cobra.Command) string {
	var lines []string
	var walk func(*cobra.Command)
	walk = func(c *cobra.Command) {
		if c.Name() == "help" {
			return
		}
		vis := "visible"
		if c.Hidden {
			vis = "hidden"
		}
		// Retirement state travels in the snapshot so scheduling a command for
		// removal, or actually removing it, shows up as a reviewed diff.
		if st := lifecycleStateOf(c.CommandPath()); st != "" {
			vis += "/" + st
		}
		run := "group"
		if c.Runnable() {
			run = "runnable"
		}

		var flags []string
		c.NonInheritedFlags().VisitAll(func(f *pflag.Flag) {
			flags = append(flags, fmt.Sprintf("--%s:%s", f.Name, f.Value.Type()))
		})
		sort.Strings(flags)

		line := fmt.Sprintf("%s\t%s\t%s", c.CommandPath(), vis, run)
		if len(flags) > 0 {
			line += "\t" + strings.Join(flags, " ")
		}
		lines = append(lines, line)

		subs := append([]*cobra.Command(nil), c.Commands()...)
		sort.Slice(subs, func(i, j int) bool { return subs[i].Name() < subs[j].Name() })
		for _, sub := range subs {
			walk(sub)
		}
	}
	walk(root)
	sort.Strings(lines)
	return strings.Join(lines, "\n") + "\n"
}

// diffLines reports added and removed lines, which is all a reviewer needs here.
func diffLines(want, got []string) []string {
	inWant := map[string]bool{}
	for _, l := range want {
		inWant[l] = true
	}
	inGot := map[string]bool{}
	for _, l := range got {
		inGot[l] = true
	}

	var out []string
	for _, l := range got {
		if l != "" && !inWant[l] {
			out = append(out, "+ "+l)
		}
	}
	for _, l := range want {
		if l != "" && !inGot[l] {
			out = append(out, "- "+l)
		}
	}
	sort.Strings(out)
	return out
}
