package cli

import (
	"os"

	"github.com/howznguyen/knowns/internal/lspdaemon"
	"github.com/spf13/cobra"
)

var lspDaemonInternalCmd = &cobra.Command{
	Use:    "__lsp-daemon",
	Hidden: true,
}

var lspDaemonRunCmd = &cobra.Command{
	Use:          "run",
	Short:        "Run the project LSP daemon",
	Hidden:       true,
	SilenceUsage: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectRoot, _ := cmd.Flags().GetString("project")
		if projectRoot == "" {
			var err error
			projectRoot, err = os.Getwd()
			if err != nil {
				return err
			}
		}
		return lspdaemon.Run(cmd.Context(), projectRoot)
	},
}

func init() {
	lspDaemonRunCmd.Flags().String("project", "", "Project root directory")
	lspDaemonInternalCmd.AddCommand(lspDaemonRunCmd)
	rootCmd.AddCommand(lspDaemonInternalCmd)
}
