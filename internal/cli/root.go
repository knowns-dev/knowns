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
		for _, row := range [][2]string{
			{"knowns init", "Initialize project"},
			{"knowns quickstart", "Learn the short path to a finished task"},
			{"knowns task list", "List all tasks"},
			{"knowns --help", "Show all commands"},
		} {
			fmt.Printf("    %s%s%s\n",
				StyleInfo.Render(row[0]),
				strings.Repeat(" ", len("knowns quickstart")-len(row[0])+2),
				row[1],
			)
		}
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

	// Usage. A command that both takes arguments itself and has subcommands
	// gets both lines; printing only UseLine() hid `knowns task create` and the
	// `knowns task <id>` shorthand behind a bare `knowns task [flags]`.
	fmt.Printf("%s %s\n", StyleBold.Render("Usage:"), StyleInfo.Render(cmd.UseLine()))
	if cmd.HasAvailableSubCommands() {
		fmt.Printf("%s %s\n", strings.Repeat(" ", len("Usage:")), StyleInfo.Render(cmd.CommandPath()+" [command]"))
	}
	fmt.Println()

	// Examples. A flag list says what a command accepts; only a worked example
	// says what a real invocation looks like, which is the part a reader is
	// usually here for. Comment lines are dimmed so the runnable lines stand out.
	if cmd.Example != "" {
		fmt.Println(StyleBold.Render("Examples:"))
		for _, line := range strings.Split(strings.TrimRight(cmd.Example, "\n"), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "#") {
				fmt.Println(StyleDim.Render(line))
			} else if strings.TrimSpace(line) == "" {
				fmt.Println()
			} else {
				fmt.Println(StyleInfo.Render(line))
			}
		}
		fmt.Println()
	}

	// Commands. The root list is grouped by job; a subcommand's own list is
	// short enough that a flat list still reads at a glance.
	if cmd.HasAvailableSubCommands() {
		short := map[string]string{}
		maxLen := 0
		for _, c := range cmd.Commands() {
			if !isListableCommand(c) {
				continue
			}
			short[c.Name()] = c.Short
			if len(c.Name()) > maxLen {
				maxLen = len(c.Name())
			}
		}

		// The description is the content of this list, not a footnote on it.
		// The cyan command name already carries the hierarchy, so the text next
		// to it stays at the terminal's default foreground; rendering it in
		// colorGray ("8", the lowest-contrast entry in the palette) sank the
		// half of each line a reader is actually here for.
		printCommand := func(name string) {
			padding := strings.Repeat(" ", maxLen-len(name)+2)
			fmt.Printf("  %s%s%s\n", StyleInfo.Render(name), padding, short[name])
		}

		if cmd.Parent() == nil {
			for _, g := range groupRootCommands(cmd) {
				fmt.Println(StyleBold.Render(g.Title + ":"))
				for _, name := range g.Commands {
					printCommand(name)
				}
				fmt.Println()
			}
		} else {
			var names []string
			for _, c := range cmd.Commands() {
				if !isListableCommand(c) {
					continue
				}
				names = append(names, c.Name())
			}
			fmt.Println(StyleBold.Render("Commands:"))
			for _, name := range sortSubcommands(names) {
				printCommand(name)
			}
			fmt.Println()
		}
	}

	// Flags
	if cmd.HasAvailableLocalFlags() {
		fmt.Println(StyleBold.Render("Options:"))
		fmt.Println(cmd.LocalFlags().FlagUsages())
	}

	// Global flags, on subcommands only; on the root they are already the
	// Options block above. Leaving them out is how `--plain` came to be
	// documented as something only certain commands accepted, when it has
	// always been valid everywhere.
	if cmd.Parent() != nil && cmd.InheritedFlags().HasAvailableFlags() {
		fmt.Println(StyleBold.Render("Global options:"))
		fmt.Println(cmd.InheritedFlags().FlagUsages())
	}

	// Footer
	fmt.Printf("%s\n", StyleDim.Render("Use \"knowns [command] --help\" for more information about a command."))
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

	// Warn once per command if the project config has pending schema migrations.
	maybeWarnUnmigratedConfig()

	return executeWithUpdateNotice(args, rootCmd.Execute, util.CheckForUpdate, 3*time.Second, os.Stderr)
}

func executeWithUpdateNotice(args []string, run func() error, check func() string, timeout time.Duration, output io.Writer) error {
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
	// The pager it disabled is gone; output is always printed directly now. The
	// flag stays registered and hidden so a script that still passes it keeps
	// working instead of failing on an unknown flag.
	rootCmd.PersistentFlags().Bool("no-pager", false, "No effect; output is always printed directly")
	_ = rootCmd.PersistentFlags().MarkHidden("no-pager")
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
