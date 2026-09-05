package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"
)

// Hand-written docs drift from the binary in a way generated pages cannot: they
// show commands and flags a reader is meant to type. Before this check the repo
// documented `knowns memory add --category` (add is not a subcommand), `template
// run --name` (the flag is --var), and, in a skill embedded in the binary,
// `validate --sdd` (now --scope sdd) - so every agent running kn-verify hit an
// error the repo could not see.
//
// Only fenced code is linted. Prose deliberately names commands that do not
// exist ("There is no `knowns model` command"), and treating that as drift
// would train people to ignore the check.
var docRoots = []string{
	"README.md", "README.vi.md", "ARCHITECTURE.md", "PHILOSOPHY.md",
	"AGENTS.md", "CLAUDE.md", "GEMINI.md", "OPENCODE.md",
	"docs", "internal/instructions",
}

// Source files tell users what to run too: doctor remediations, error hints,
// and a UI alert saying "Run 'knowns init' in your terminal". A rename rots
// those strings exactly like a stale README, and nothing was checking them.
// Every line counts here; unlike markdown there is no fence to be inside of.
var srcRoots = []string{"internal", "cmd", "ui/src"}

func isSourceFile(path string) bool {
	switch filepath.Ext(path) {
	case ".go", ".ts", ".tsx":
		return !strings.Contains(path, "/cli-reference/")
	}
	return false
}

var (
	invocationRE = regexp.MustCompile(`\bknowns\s+((?:[a-z][a-z0-9_-]*\s*)+)`)
	flagTokenRE  = regexp.MustCompile(`--([a-z][a-z0-9-]*)`)
	fenceRE      = regexp.MustCompile("^\\s*```")
)

type docFinding struct {
	file, line string
	detail     string
}

// lintDocs reports every fenced `knowns ...` invocation whose flags the command
// no longer accepts. Returns the findings and how many invocations were checked.
func lintDocs(root *cobra.Command) ([]docFinding, int) {
	var findings []docFinding
	checked := 0

	scan := func(roots []string, want func(string) bool, fenced bool) {
		for _, r := range roots {
			_ = filepath.Walk(r, func(path string, info os.FileInfo, err error) error {
				if err != nil || info.IsDir() || !want(path) {
					return nil
				}
				if strings.Contains(path, "node_modules") {
					return nil
				}
				body, readErr := os.ReadFile(path)
				if readErr != nil {
					return nil
				}
				inFence := !fenced
				for n, line := range strings.Split(string(body), "\n") {
					if fenced && fenceRE.MatchString(line) {
						inFence = !inFence
						continue
					}
					if !inFence {
						continue
					}
					for _, detail := range lintLine(root, line) {
						checked++
						if detail != "" {
							findings = append(findings, docFinding{path, fmt.Sprint(n + 1), detail})
						}
					}
				}
				return nil
			})
		}
	}

	// Markdown: only fenced code, because prose deliberately names commands
	// that do not exist ("There is no `knowns model` command").
	scan(docRoots, func(p string) bool {
		return strings.HasSuffix(p, ".md") && !strings.Contains(p, "cli-reference")
	}, true)
	scan(srcRoots, isSourceFile, false)

	return findings, checked
}

// lintLine assigns each flag to the invocation that precedes it, the way a
// shell does. A line often mentions two commands, and attributing every flag to
// the first one reports drift that is not there.
func lintLine(root *cobra.Command, line string) []string {
	locs := invocationRE.FindAllStringSubmatchIndex(line, -1)
	if len(locs) == 0 {
		return nil
	}

	out := make([]string, 0, len(locs))
	for i, loc := range locs {
		cmd, path := resolvePath(root, strings.Fields(line[loc[2]:loc[3]]))
		if cmd == nil {
			out = append(out, "")
			continue
		}
		end := len(line)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}

		problem := ""
		for _, m := range flagTokenRE.FindAllStringSubmatch(line[loc[1]:end], -1) {
			if cmd.Flags().Lookup(m[1]) == nil && cmd.InheritedFlags().Lookup(m[1]) == nil {
				problem = fmt.Sprintf("knowns %s does not accept --%s", strings.Join(path, " "), m[1])
			}
		}
		out = append(out, problem)
	}
	return out
}

// resolvePath consumes as many subcommand words as resolve, stopping at the
// first token that is not a subcommand (a placeholder like <name>, or an arg).
func resolvePath(root *cobra.Command, words []string) (*cobra.Command, []string) {
	cur := root
	var path []string
	for _, w := range words {
		next := childNamed(cur, w)
		if next == nil {
			break
		}
		cur = next
		path = append(path, w)
	}
	if len(path) == 0 {
		return nil, nil
	}
	return cur, path
}

func childNamed(parent *cobra.Command, name string) *cobra.Command {
	for _, c := range parent.Commands() {
		if c.Name() == name {
			return c
		}
	}
	return nil
}
