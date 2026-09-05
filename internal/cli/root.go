package cli

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/spf13/cobra"

	"github.com/howznguyen/knowns/internal/codegen"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/util"
)

var bannerLines = []string{
	"▄▄▄   ▄▄▄ ▄▄▄    ▄▄▄   ▄▄▄▄▄   ▄▄▄▄  ▄▄▄  ▄▄▄▄ ▄▄▄    ▄▄▄  ▄▄▄▄▄▄▄",
	"███ ▄███▀ ████▄  ███ ▄███████▄ ▀███  ███  ███▀ ████▄  ███ █████▀▀▀",
	"███████   ███▀██▄███ ███   ███  ███  ███  ███  ███▀██▄███  ▀████▄",
	"███▀███▄  ███  ▀████ ███▄▄▄███  ███▄▄███▄▄███  ███  ▀████    ▀████",
	"███  ▀███ ███    ███  ▀█████▀    ▀████▀████▀   ███    ███ ███████▀",
}

var rootCmd = &cobra.Command{
	Use:     "knowns [options] [command]",
	Short:   "The memory layer for AI-native software development",
	Version: util.Version,
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println()
		for _, line := range bannerLines {
			fmt.Println(StyleInfo.Render(line))
		}
		fmt.Println()
		fmt.Printf("  %s %s\n", StyleBold.Render("Knowns"), StyleSuccess.Render(util.Version))
		fmt.Println("  The memory layer for AI-native software development.")
		fmt.Println("  Enabling AI to understand your project instantly.")
		fmt.Println()
		fmt.Println(StyleBold.Render("  Quick Start:"))
		fmt.Printf("    %s  %s\n", StyleInfo.Render("knowns init"), "Initialize project")
		fmt.Printf("    %s  %s\n", StyleInfo.Render("knowns task list"), "List all tasks")
		fmt.Printf("    %s  %s\n", StyleInfo.Render("knowns browser"), "Open web UI")
		fmt.Printf("    %s  %s\n", StyleInfo.Render("knowns --help"), "Show all commands")
		fmt.Println()
		fmt.Printf("  %s  %s\n", StyleBold.Render("Homepage: "), StyleInfo.Render("https://knowns.sh"))
		fmt.Printf("  %s  %s\n", StyleBold.Render("Documents:"), StyleInfo.Render("https://knowns.sh/docs"))
		fmt.Printf("  %s  %s\n", StyleBold.Render("Discord:  "), StyleInfo.Render("https://discord.knowns.dev"))
		fmt.Println()
	},
}

// customHelpFunc renders a clean, styled help output matching the TS CLI style.
func customHelpFunc(cmd *cobra.Command, args []string) {
	// Cobra serves help without running PersistentPreRun, so --plain/--json
	// have to be honored here too.
	if isPlain(cmd) || isJSON(cmd) {
		SetPlainOutput(true)
	}

	// Header
	fmt.Printf("%s %s\n", StyleBold.Render(cmd.Short), StyleDim.Render("(v"+util.Version+")"))
	fmt.Println()

	// Usage
	fmt.Printf("%s %s\n", StyleBold.Render("Usage:"), StyleInfo.Render(cmd.UseLine()))
	fmt.Println()

	// Commands - grouped
	if cmd.HasAvailableSubCommands() {
		fmt.Println(StyleBold.Render("Commands:"))

		// Find max command name length for alignment
		maxLen := 0
		for _, c := range cmd.Commands() {
			if !c.IsAvailableCommand() || c.Name() == "help" || c.Name() == "completion" {
				continue
			}
			if len(c.Name()) > maxLen {
				maxLen = len(c.Name())
			}
		}

		for _, c := range cmd.Commands() {
			if !c.IsAvailableCommand() || c.Name() == "help" || c.Name() == "completion" {
				continue
			}
			padding := strings.Repeat(" ", maxLen-len(c.Name())+2)
			fmt.Printf("  %s%s%s\n",
				StyleInfo.Render(c.Name()),
				padding,
				StyleDim.Render(c.Short),
			)
		}
		fmt.Println()
	}

	// Flags
	if cmd.HasAvailableLocalFlags() {
		fmt.Println(StyleBold.Render("Options:"))
		fmt.Println(StyleDim.Render(cmd.LocalFlags().FlagUsages()))
	}

	// Footer
	fmt.Printf("%s\n", StyleDim.Render("Use \"knowns [command] --help\" for more information about a command."))
}

// maybeWarnSkillsOutOfSync prints a one-line warning if embedded skills differ
// from the on-disk copies. This nudges the user to run `knowns sync` after upgrading.
func maybeWarnSkillsOutOfSync() {
	cwd, err := os.Getwd()
	if err != nil {
		return
	}
	root := filepath.Join(cwd, ".knowns")
	if _, err := os.Stat(root); err != nil {
		return
	}
	if codegen.SkillsOutOfSync(cwd) {
		fmt.Fprintf(os.Stderr, "%s\n", StyleWarning.Render("⚠ Skills are out of sync. Run 'knowns sync' to update."))
	}
}

// maybeWarnUnmigratedConfig prints a one-line notice naming `knowns migrate`
// when the project config carries a schema version older than current
// (spec ollama-only-embedding FR-4). It deliberately says only that a
// migration is pending, not the full remediation (install Ollama, pull the
// model, reindex) — that belongs to `knowns migrate` itself and to
// `doctor`, where the user has asked for it.
func maybeWarnUnmigratedConfig() {
	cwd, err := os.Getwd()
	if err != nil {
		return
	}
	root := filepath.Join(cwd, ".knowns")
	if _, err := os.Stat(root); err != nil {
		return
	}
	store := storage.NewStore(root)
	project, err := store.Config.Load()
	if err != nil || project == nil {
		return
	}
	if !storage.NeedsMigration(project) {
		return
	}
	fmt.Fprintf(os.Stderr, "%s\n", StyleWarning.Render("⚠ This project's config needs migrating. Run "+RenderCmd("knowns migrate")+"."))
}

func shouldSkipCLIWarnings(args []string) bool {
	for _, name := range []string{"doctor", "runtime", "runtime-memory", "qdrant", "__runtime", "__lsp-daemon", "migrate"} {
		if slices.Contains(args, name) {
			return true
		}
	}
	return false
}

// Execute runs the root command.
func Execute() error {
	RootCommand() // apply the lifecycle schedule before dispatch
	args := os.Args[1:]
	if shouldSkipCLIWarnings(args) {
		return rootCmd.Execute()
	}

	// Warn if skills are out of sync after a CLI upgrade.
	maybeWarnSkillsOutOfSync()

	// Warn once per command if the project config has pending schema migrations.
	maybeWarnUnmigratedConfig()

	return executeWithUpdateNotice(args, rootCmd.Execute, util.CheckForUpdate, 3*time.Second, os.Stderr)
}

func executeWithUpdateNotice(args []string, run func() error, check func() string, timeout time.Duration, output io.Writer) error {
	resetSuppressedTUICancel()
	defer resetSuppressedTUICancel()

	if !util.ShouldCheckForUpdate(args) {
		return run()
	}

	msgCh := make(chan string, 1)
	go func() {
		msgCh <- check()
	}()

	if err := run(); err != nil {
		return err
	}
	if wasTUICancelSuppressed() {
		return nil
	}

	select {
	case msg := <-msgCh:
		if msg != "" {
			fmt.Fprint(output, msg)
		}
	case <-time.After(timeout):
	}

	return nil
}

func init() {
	rootCmd.SetHelpFunc(customHelpFunc)
	// --plain and --json are global, so honoring them has to happen once, before
	// any command renders. NO_COLOR rides along here for the same reason.
	rootCmd.PersistentPreRun = func(cmd *cobra.Command, _ []string) {
		SetPlainOutput(isPlain(cmd) || isJSON(cmd) || noColorRequested())
	}
	rootCmd.PersistentFlags().Bool("plain", false, "Plain text output (for AI agents)")
	rootCmd.PersistentFlags().Bool("json", false, "JSON output")
	rootCmd.PersistentFlags().Bool("no-pager", false, "Disable TUI pager (print styled output directly)")
	rootCmd.PersistentFlags().Int("page", 0, "Page number for paginated output (e.g. --page 2)")
	rootCmd.PersistentFlags().Int("page-size", 0, "Lines per page (default 50)")
}

var lifecycleOnce sync.Once

// RootCommand exposes the fully assembled command tree for documentation
// generation. It is the same tree Execute runs, so generated docs cannot
// describe a command surface the binary does not have.
//
// The lifecycle schedule is applied here rather than in an init(), which would
// depend on the order Go happens to run this package's init functions.
func RootCommand() *cobra.Command {
	lifecycleOnce.Do(func() { applyLifecycle(rootCmd) })
	return rootCmd
}
