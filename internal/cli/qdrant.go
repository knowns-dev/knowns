package cli

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/qdrantruntime"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

type qdrantCommandDependencies struct {
	findStore  func() (*storage.Store, error)
	newManager func(*storage.Store) (*qdrantruntime.Manager, error)
}

func defaultQdrantCommandDependencies() qdrantCommandDependencies {
	return qdrantCommandDependencies{
		findStore:  findOptionalQdrantStore,
		newManager: qdrantManagerFromStore,
	}
}

func newQdrantCmd(deps qdrantCommandDependencies) *cobra.Command {
	if deps.findStore == nil {
		deps.findStore = findOptionalQdrantStore
	}
	if deps.newManager == nil {
		deps.newManager = qdrantManagerFromStore
	}
	cmd := &cobra.Command{
		Use:   "qdrant",
		Short: "Inspect and control the semantic Qdrant runtime",
		Long: `Inspect and control the Qdrant runtime used by semantic vector search.

Managed mode owns a local Qdrant process rooted at ~/.knowns/runtime/qdrant.
External URL mode reports the configured endpoint and bypasses local process
start/stop/cleanup ownership.`,
	}

	cmd.AddCommand(&cobra.Command{
		Use:   "install",
		Short: "Install the pinned managed Qdrant binary with checksum verification",
		RunE: func(cmd *cobra.Command, args []string) error {
			mgr, err := qdrantManagerForCommand(deps)
			if err != nil {
				return err
			}
			if mgr.Config.Mode == models.SemanticVectorStoreModeExternal {
				return fmt.Errorf("qdrant install applies only to managed mode")
			}
			installer := qdrantruntime.Installer{Root: mgr.Paths().Root, Mirror: os.Getenv("KNOWNS_QDRANT_MIRROR")}
			paths, err := installer.Install(cmd.Context())
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "installed pinned Qdrant %s at %s\n", qdrantruntime.SupportedQdrantVersion, paths.BinaryPath)
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "purge",
		Short: "Immediately purge positively owned semantic collections",
		Long:  "Explicit privacy/hard purge. Retention is bypassed, but deletion fails closed unless pointer and generation history prove ownership.",
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := deps.findStore()
			if err != nil {
				return err
			}
			if store == nil {
				return fmt.Errorf("qdrant purge requires a Knowns store")
			}
			deleted, err := search.PurgeConfiguredQdrantStore(context.Background(), store)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "purged %d positively owned Qdrant collections\n", len(deleted))
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "status",
		Short: "Show Qdrant runtime status and paths",
		RunE: func(cmd *cobra.Command, args []string) error {
			mgr, err := qdrantManagerForCommand(deps)
			if err != nil {
				return err
			}
			status, err := mgr.Status(cmd.Context())
			if err != nil {
				return err
			}
			renderQdrantStatus(cmd, status)
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "start",
		Short: "Start managed Qdrant when in managed mode",
		RunE: func(cmd *cobra.Command, args []string) error {
			mgr, err := qdrantManagerForCommand(deps)
			if err != nil {
				return err
			}
			status, err := mgr.Start(cmd.Context())
			renderQdrantStatus(cmd, status)
			return err
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "stop",
		Short: "Stop managed Qdrant when Knowns owns a local process",
		RunE: func(cmd *cobra.Command, args []string) error {
			mgr, err := qdrantManagerForCommand(deps)
			if err != nil {
				return err
			}
			status, err := mgr.Stop(cmd.Context())
			if err != nil {
				return err
			}
			renderQdrantStatus(cmd, status)
			return nil
		},
	})
	logsCmd := &cobra.Command{
		Use:   "logs",
		Short: "Show managed Qdrant log lines",
		RunE: func(cmd *cobra.Command, args []string) error {
			mgr, err := qdrantManagerForCommand(deps)
			if err != nil {
				return err
			}
			tailN, _ := cmd.Flags().GetInt("tail")
			return mgr.TailLog(cmd.OutOrStdout(), tailN)
		},
	}
	logsCmd.Flags().IntP("tail", "n", 50, "Number of trailing lines to show")
	cmd.AddCommand(logsCmd)
	cmd.AddCommand(&cobra.Command{
		Use:   "cleanup",
		Short: "Remove stale managed Qdrant runtime metadata",
		Long:  "Remove stale managed Qdrant PID/status metadata. This does not delete vector data or collections.",
		RunE: func(cmd *cobra.Command, args []string) error {
			mgr, err := qdrantManagerForCommand(deps)
			if err != nil {
				return err
			}
			status, err := mgr.Cleanup(cmd.Context())
			if err != nil {
				return err
			}
			renderQdrantStatus(cmd, status)
			return nil
		},
	})
	return cmd
}

func qdrantManagerForCommand(deps qdrantCommandDependencies) (*qdrantruntime.Manager, error) {
	store, err := deps.findStore()
	if err != nil {
		return nil, err
	}
	return deps.newManager(store)
}

func findOptionalQdrantStore() (*storage.Store, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("cannot determine working directory: %w", err)
	}
	root, err := storage.FindProjectRoot(cwd)
	if err != nil {
		return nil, nil
	}
	return storage.NewStore(root), nil
}

func qdrantManagerFromStore(store *storage.Store) (*qdrantruntime.Manager, error) {
	project, global := qdrantSemanticSettings(store)
	res := models.ResolveSemanticVectorStore(project, global, nil)
	cfg := qdrantruntime.ConfigFromResolution(res)
	return qdrantruntime.NewManager(cfg), nil
}

func qdrantSemanticSettings(store *storage.Store) (*models.SemanticSearchSettings, *models.SemanticSearchSettings) {
	var project *models.SemanticSearchSettings
	if store != nil {
		if cfg, err := store.Config.Load(); err == nil && cfg != nil {
			project = cfg.Settings.SemanticSearch
		}
	}
	var global *models.SemanticSearchSettings
	if settings, err := storage.NewEmbeddingSettingsStore().Load(); err == nil && settings.ProjectDefaults != nil {
		global = settings.ProjectDefaults.Settings.SemanticSearch
	}
	return project, global
}

func renderQdrantStatus(cmd *cobra.Command, status qdrantruntime.Status) {
	if isJSON(cmd) {
		printJSON(status)
		return
	}
	if isPlain(cmd) {
		renderQdrantStatusPlain(cmd, status)
		return
	}
	renderQdrantStatusStyled(cmd, status)
}

func renderQdrantStatusPlain(cmd *cobra.Command, s qdrantruntime.Status) {
	w := cmd.OutOrStdout()
	fmt.Fprintf(w, "state\t%s\n", s.State)
	fmt.Fprintf(w, "enabled\t%v\n", s.Enabled)
	fmt.Fprintf(w, "backend\t%s\n", emptyDash(s.Backend))
	fmt.Fprintf(w, "mode\t%s\n", emptyDash(s.Mode))
	fmt.Fprintf(w, "managed\t%v\n", s.Managed)
	fmt.Fprintf(w, "running\t%v\n", s.Running)
	fmt.Fprintf(w, "installed\t%v\n", s.Installed)
	if s.PID != 0 {
		fmt.Fprintf(w, "pid\t%d\n", s.PID)
	}
	fmt.Fprintf(w, "endpoint\t%s\n", emptyDash(s.Endpoint))
	if s.ExternalURL != "" {
		fmt.Fprintf(w, "externalURL\t%s\n", s.ExternalURL)
	}
	fmt.Fprintf(w, "root\t%s\n", s.Paths.Root)
	fmt.Fprintf(w, "bin\t%s\n", s.Paths.BinDir)
	fmt.Fprintf(w, "binary\t%s\n", s.Paths.BinaryPath)
	fmt.Fprintf(w, "data\t%s\n", s.Paths.DataDir)
	fmt.Fprintf(w, "logs\t%s\n", s.Paths.LogPath)
	fmt.Fprintf(w, "pidFile\t%s\n", s.Paths.PIDPath)
	fmt.Fprintf(w, "statusFile\t%s\n", s.Paths.StatusPath)
	if s.Message != "" {
		fmt.Fprintf(w, "message\t%s\n", s.Message)
	}
}

func renderQdrantStatusStyled(cmd *cobra.Command, s qdrantruntime.Status) {
	w := cmd.OutOrStdout()
	badge := RenderBadge(strings.ToUpper(s.State), colorBlue)
	if s.State == qdrantruntime.StatusRunning || s.State == qdrantruntime.StatusExternal {
		badge = RenderBadge(strings.ToUpper(s.State), colorGreen)
	} else if s.State == qdrantruntime.StatusStale || s.State == qdrantruntime.StatusNotInstalled {
		badge = RenderBadge(strings.ToUpper(s.State), colorYellow)
	}
	fmt.Fprintf(w, "%s Qdrant semantic vector runtime\n", badge)
	fmt.Fprintf(w, "  Backend: %s\n", emptyDash(s.Backend))
	fmt.Fprintf(w, "  Mode: %s\n", emptyDash(s.Mode))
	fmt.Fprintf(w, "  Managed: %v\n", s.Managed)
	fmt.Fprintf(w, "  Running: %v\n", s.Running)
	fmt.Fprintf(w, "  Installed: %v\n", s.Installed)
	if s.PID != 0 {
		fmt.Fprintf(w, "  PID: %d\n", s.PID)
	}
	fmt.Fprintf(w, "  Endpoint: %s\n", emptyDash(s.Endpoint))
	if s.ExternalURL != "" {
		fmt.Fprintf(w, "  External URL: %s\n", s.ExternalURL)
	}
	fmt.Fprintf(w, "  Root: %s\n", s.Paths.Root)
	fmt.Fprintf(w, "  Binary: %s\n", s.Paths.BinaryPath)
	fmt.Fprintf(w, "  Data: %s\n", s.Paths.DataDir)
	fmt.Fprintf(w, "  Logs: %s\n", s.Paths.LogPath)
	fmt.Fprintf(w, "  PID file: %s\n", s.Paths.PIDPath)
	fmt.Fprintf(w, "  Status file: %s\n", s.Paths.StatusPath)
	if s.Message != "" {
		fmt.Fprintf(w, "  Message: %s\n", s.Message)
	}
}

func emptyDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}

var qdrantCmd = newQdrantCmd(defaultQdrantCommandDependencies())

func init() {
	rootCmd.AddCommand(qdrantCmd)
}
