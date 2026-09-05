// Command gendocs renders the CLI reference straight from the cobra command
// tree, and can verify that the committed copy still matches.
//
// The point is not the docs themselves but the gate: without it, a reference
// page can describe a command the binary never had (docs/en/reference had
// `knowns model`) or miss eight that it does. Run with --check in CI.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/howznguyen/knowns/internal/cli"
)

const defaultOutDir = "docs/en/cli-reference"

func main() {
	out := flag.String("out", defaultOutDir, "directory to write the CLI reference into")
	check := flag.Bool("check", false, "verify the committed reference matches the command tree; write nothing")
	lint := flag.Bool("lint", false, "verify hand-written docs only use commands and flags that exist")
	flag.Parse()

	if *lint {
		// Both checks always run. Exiting inside the first would hide every
		// broken file reference until the last broken flag was fixed.
		bad := runLint()
		if runPathLint() {
			bad = true
		}
		if bad {
			os.Exit(1)
		}
		return
	}

	generated := renderTree(cli.RootCommand())
	if len(generated) == 0 {
		fail(fmt.Errorf("command tree produced no pages"))
	}

	if *check {
		if err := verify(*out, generated); err != nil {
			fail(err)
		}
		fmt.Printf("CLI reference is up to date (%d pages).\n", len(generated))
		return
	}

	if err := write(*out, generated); err != nil {
		fail(err)
	}
	fmt.Printf("Wrote %d pages to %s.\n", len(generated), *out)
}

func write(dir string, pages map[string][]byte) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	// Drop pages for commands that no longer exist, so a removed command cannot
	// leave a stale page behind.
	existing, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read %s: %w", dir, err)
	}
	for _, e := range existing {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		if _, keep := pages[e.Name()]; !keep {
			if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
				return fmt.Errorf("remove stale %s: %w", e.Name(), err)
			}
		}
	}
	for name, body := range pages {
		if err := os.WriteFile(filepath.Join(dir, name), body, 0o644); err != nil {
			return fmt.Errorf("write %s: %w", name, err)
		}
	}
	return nil
}

func verify(dir string, pages map[string][]byte) error {
	var missing, stale, changed []string

	for name, want := range pages {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if os.IsNotExist(err) {
			missing = append(missing, name)
			continue
		}
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		if string(got) != string(want) {
			changed = append(changed, name)
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read %s: %w", dir, err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		if _, ok := pages[e.Name()]; !ok {
			stale = append(stale, e.Name())
		}
	}

	if len(missing)+len(stale)+len(changed) == 0 {
		return nil
	}

	var b strings.Builder
	b.WriteString("CLI reference is out of date. Run: make cli-docs\n")
	report(&b, "missing (command exists, page does not)", missing)
	report(&b, "stale (page exists, command does not)", stale)
	report(&b, "changed (flags or help text differ)", changed)
	return fmt.Errorf("%s", b.String())
}

func report(b *strings.Builder, label string, names []string) {
	if len(names) == 0 {
		return
	}
	sort.Strings(names)
	fmt.Fprintf(b, "\n  %s:\n", label)
	for _, n := range names {
		fmt.Fprintf(b, "    %s\n", n)
	}
}

// runLint reports command and flag drift in hand-written docs.
// It returns whether anything was wrong.
func runLint() bool {
	findings, checked := lintDocs(cli.RootCommand())
	if len(findings) == 0 {
		fmt.Printf("Docs are consistent with the command tree (%d invocations checked).\n", checked)
		return false
	}
	fmt.Fprintf(os.Stderr, "Docs reference commands or flags that do not exist:\n\n")
	for _, f := range findings {
		fmt.Fprintf(os.Stderr, "  %s:%s  %s\n", f.file, f.line, f.detail)
	}
	fmt.Fprintf(os.Stderr, "\n%d of %d fenced invocations are broken.\n", len(findings), checked)
	return true
}

// runPathLint reports file references that point at nothing.
// It returns whether anything was wrong.
func runPathLint() bool {
	findings, checked := lintPaths()
	if len(findings) == 0 {
		fmt.Printf("Docs reference %d files, all of which exist.\n", checked)
		return false
	}
	fmt.Fprintf(os.Stderr, "\nDocs reference files that do not exist:\n\n")
	for _, f := range findings {
		fmt.Fprintf(os.Stderr, "  %s:%s  %s\n", f.file, f.line, f.token)
	}
	fmt.Fprintf(os.Stderr, "\n%d of %d file references are broken.\n"+
		"Fix the reference, or add it to %s with a reason.\n", len(findings), checked, allowFile)
	return true
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "gendocs: %v\n", err)
	os.Exit(1)
}
