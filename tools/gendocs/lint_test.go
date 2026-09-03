package main

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// tree builds a small command tree so these tests do not depend on the real
// CLI surface, which changes for unrelated reasons.
func tree() *cobra.Command {
	root := &cobra.Command{Use: "knowns"}

	setup := &cobra.Command{Use: "setup", Short: "Configure integrations", Run: func(*cobra.Command, []string) {}}
	setup.Flags().Bool("global", false, "Install to user-level paths")

	initCmd := &cobra.Command{Use: "init", Short: "Initialize", Run: func(*cobra.Command, []string) {}}
	initCmd.Flags().Bool("force", false, "Force")

	memory := &cobra.Command{Use: "memory", Short: "Manage memory"}
	create := &cobra.Command{Use: "create <title>", Short: "Create a memory", Run: func(*cobra.Command, []string) {}}
	create.Flags().String("category", "", "Memory category")
	memory.AddCommand(create)

	root.AddCommand(setup, initCmd, memory)
	return root
}

// TestLintLineAttributesFlagsToNearestCommand covers the bug that made the
// first version of this check useless: a line often names two commands, and
// giving every flag to the first one reported drift that was not there. The
// real line below is from quick-start.md, where --global belongs to `setup`
// even though `knowns init` appears earlier in the sentence.
func TestLintLineAttributesFlagsToNearestCommand(t *testing.T) {
	root := tree()

	cases := []struct {
		name string
		line string
		want string // "" means no finding
	}{
		{
			name: "flag belongs to the second command on the line",
			line: "`knowns init` creates the store; integrations use `knowns setup <target> --global`.",
			want: "",
		},
		{
			name: "flag genuinely missing",
			line: "knowns init --global",
			want: "knowns init does not accept --global",
		},
		{
			name: "subcommand flag resolves through the path",
			line: `knowns memory create "x" --category pattern`,
			want: "",
		},
		{
			name: "flag on the group, not the subcommand",
			line: `knowns memory --category pattern`,
			want: "knowns memory does not accept --category",
		},
		{
			name: "placeholder stops path resolution without a false finding",
			line: "knowns setup <target> --global",
			want: "",
		},
		{
			name: "unknown command yields no finding, since it may not be ours",
			line: "knowns notacommand --whatever",
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			for _, f := range lintLine(root, tc.line) {
				if f != "" {
					got = append(got, f)
				}
			}
			if tc.want == "" {
				if len(got) > 0 {
					t.Errorf("expected no finding, got %q", got)
				}
				return
			}
			if len(got) != 1 || got[0] != tc.want {
				t.Errorf("got %q, want [%q]", got, tc.want)
			}
		})
	}
}

// TestSourceFilesAreScanned covers the surface markdown-only linting missed:
// a Go remediation string or a UI alert naming a command the binary lacks.
// internal/cli/agents.go told users to run `knowns agents --sync`, which has
// never been a flag, and nothing noticed until source files were included.
func TestSourceFilesAreScanned(t *testing.T) {
	for _, path := range []string{"internal/cli/agents.go", "ui/src/pages/WelcomePage.tsx", "cmd/knowns/main.go"} {
		if !isSourceFile(path) {
			t.Errorf("%s should be scanned for command references", path)
		}
	}
	for _, path := range []string{"README.md", "docs/en/cli-reference/knowns_task.md", "ui/src/styles.css"} {
		if isSourceFile(path) {
			t.Errorf("%s should not be scanned as source", path)
		}
	}
}

// TestUnfencedLineIsLintedLikeSource is the behavioural half: source has no
// code fence to be inside of, so every line must be considered.
func TestUnfencedLineIsLintedLikeSource(t *testing.T) {
	root := tree()
	line := `fmt.Println("Use 'knowns init --global' to set up")`

	var got []string
	for _, f := range lintLine(root, line) {
		if f != "" {
			got = append(got, f)
		}
	}
	if len(got) != 1 || got[0] != "knowns init does not accept --global" {
		t.Errorf("got %q, want one finding about --global", got)
	}
}

func TestResolvePathStopsAtNonSubcommand(t *testing.T) {
	root := tree()

	cmd, path := resolvePath(root, strings.Fields("memory create x"))
	if cmd == nil || strings.Join(path, " ") != "memory create" {
		t.Errorf("got path %q, want \"memory create\"", strings.Join(path, " "))
	}

	if cmd, _ := resolvePath(root, strings.Fields("nope")); cmd != nil {
		t.Error("an unknown first word should resolve to nothing")
	}
}

// TestRenderPageOmitsVersion guards the property that keeps the drift gate
// usable: a generated page must not embed anything that changes on its own,
// or every release produces a diff nobody asked for.
func TestRenderPageOmitsVersion(t *testing.T) {
	root := tree()
	root.Version = "9.9.9"

	page := renderPage(root)
	if strings.Contains(page, "9.9.9") {
		t.Error("generated page embeds the version; every release would look like drift")
	}
	if !strings.Contains(page, "Do not edit by hand") {
		t.Error("generated page should say it is generated")
	}
}

func TestRenderTreeSkipsHiddenAndHelp(t *testing.T) {
	root := tree()
	hidden := &cobra.Command{Use: "__daemon", Hidden: true, Run: func(*cobra.Command, []string) {}}
	root.AddCommand(hidden)

	pages := renderTree(root)
	if _, ok := pages["knowns___daemon.md"]; ok {
		t.Error("hidden commands must not get a human reference page")
	}
	if _, ok := pages["knowns_memory_create.md"]; !ok {
		t.Error("nested visible commands must get a page")
	}
}
