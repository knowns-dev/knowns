package cli

import (
	"fmt"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

// migrateCmd is the top-level `knowns migrate` runner (spec
// ollama-only-embedding D10/D11). It lives at the top level rather than
// nested under `config` or grouped with `knowns decision migrate`: the
// registry will outgrow config, and it is a version-gated, idempotent
// schema upgrade, not the reviewed one-at-a-time data conversion
// `knowns decision migrate` performs.
var migrateCmd = &cobra.Command{
	Use:   "migrate",
	Short: "Apply pending project config schema migrations",
	Long: "Preview or apply registered project config schema migrations.\n\n" +
		"Preview (no flags) reports what is pending and changes nothing. " +
		"--write applies every pending migration in order and stamps the new " +
		"schema version. There is no rollback subcommand: the config is in " +
		"git, and git is the rollback.",
	Args: cobra.NoArgs,
	RunE: runMigrate,
}

func init() {
	migrateCmd.Flags().Bool("write", false, "Apply pending migrations and write the config")
	rootCmd.AddCommand(migrateCmd)
}

func runMigrate(cmd *cobra.Command, args []string) error {
	write, _ := cmd.Flags().GetBool("write")

	store, err := getStoreErr()
	if err != nil {
		return err
	}
	project, err := store.Config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	if write {
		return runMigrateWrite(cmd, store, project)
	}
	return runMigratePreview(cmd, project)
}

func runMigratePreview(cmd *cobra.Command, project *models.Project) error {
	result, err := storage.PreviewMigrations(project)
	if err != nil {
		return fmt.Errorf("preview migrations: %w", err)
	}

	if isJSON(cmd) {
		printJSON(result)
		return nil
	}

	if !result.Pending() {
		fmt.Println(RenderSuccess(fmt.Sprintf("Nothing to migrate. Config is at schema version %d.", project.SchemaVersion)))
		return nil
	}

	fmt.Println(StyleBold.Render(fmt.Sprintf("%d pending migration(s) (schema version %d -> %d):", len(result.Applied), result.FromVersion, result.ToVersion)))
	printPendingMigrations(project.SchemaVersion, result.Changes)
	fmt.Println()
	fmt.Println(RenderHint("No files were changed. Run " + RenderCmd("knowns migrate --write") + " to apply."))
	if len(result.Changes) > 0 {
		fmt.Println()
		printPostMigrationSteps("After applying, you will need:")
	}
	return nil
}

// printPostMigrationSteps names installing Ollama, pulling the model and
// reindexing. Both the preview and the write path print it, because every
// other command reports an unmigrated project with a single line pointing at
// `knowns migrate` (FR-4) — so a preview that stays silent breaks the
// guidance chain at precisely the command the user was sent to, and they
// would not learn what the migration requires until after writing the file.
func printPostMigrationSteps(heading string) {
	pull := ""
	for _, m := range storage.RecommendedModels() {
		if m.Default {
			pull = m.PullCommand
			break
		}
		if pull == "" {
			pull = m.PullCommand
		}
	}
	fmt.Println(StyleBold.Render(heading))
	fmt.Printf("  1. Install Ollama: %s\n", storage.OllamaInstallURL)
	fmt.Printf("  2. Pull the model: %s\n", pull)
	fmt.Println("  3. Reindex: " + RenderCmd("knowns search index --wait"))
	fmt.Println(RenderHint("  Read more: " + storage.OllamaGuidanceDocsURL))
}

// printPendingMigrations names every pending migration and lists the changes
// they would make. Naming them matters even when there is nothing to list: a
// migration can be pending and still change no fields — a project with no
// semanticSearch block has nothing for the v1 migration to rewrite, and only
// the schema version advances. Printing the count and a colon and then
// nothing reads as broken output and leaves the user unable to see what the
// pending migration actually is.
func printPendingMigrations(fromVersion int, changes []string) {
	for _, m := range storage.PendingMigrations(fromVersion) {
		fmt.Printf("  v%d  %s\n", m.Version, m.Description)
	}
	for _, line := range changes {
		fmt.Printf("    %s\n", line)
	}
	if len(changes) == 0 {
		fmt.Println(RenderHint("    No field changes; this records the schema version."))
	}
}

func runMigrateWrite(cmd *cobra.Command, store *storage.Store, project *models.Project) error {
	fromVersion := project.SchemaVersion
	result := storage.ApplyMigrations(project)

	if !result.Pending() {
		if isJSON(cmd) {
			printJSON(result)
			return nil
		}
		fmt.Println(RenderSuccess(fmt.Sprintf("Nothing to migrate. Config is at schema version %d.", fromVersion)))
		return nil
	}

	if err := store.Config.Save(project); err != nil {
		return fmt.Errorf("save migrated config: %w", err)
	}

	if isJSON(cmd) {
		printJSON(result)
		return nil
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Applied %d migration(s). Config is now at schema version %d.", len(result.Applied), result.ToVersion)))
	for _, line := range result.Changes {
		fmt.Printf("  %s\n", line)
	}
	if len(result.Changes) == 0 {
		// Nothing about the embedding identity moved, so installing Ollama,
		// pulling a model and reindexing do not apply: a project already on
		// the target configuration would be told to redo work it has done,
		// and to reindex when nothing changed.
		fmt.Println(RenderHint("Only the schema version was recorded; no further action is needed."))
		return nil
	}
	fmt.Println()
	printPostMigrationSteps("Next steps:")
	fmt.Println()
	fmt.Println(RenderHint("Review and commit the updated .knowns/config.json."))
	return nil
}
