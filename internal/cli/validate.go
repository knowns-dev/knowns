package cli

import (
	"fmt"
	"strings"

	"github.com/howznguyen/knowns/internal/validate"
	"github.com/spf13/cobra"
)

var validateCmd = &cobra.Command{
	Use:   "validate",
	Short: "Validate tasks, docs, and templates",
	RunE:  runValidate,
}

func runValidate(cmd *cobra.Command, args []string) error {
	store := getStore()

	scope, _ := cmd.Flags().GetString("scope")
	strict, _ := cmd.Flags().GetBool("strict")
	fix, _ := cmd.Flags().GetBool("fix")
	entity, _ := cmd.Flags().GetString("entity")
	includeGlobal, _ := cmd.Flags().GetBool("include-global")

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)

	// Run shared validation engine.
	result := validate.Run(store, validate.Options{
		Scope:  scope,
		Entity: entity,
		Strict: strict,
		Fix:    fix,

		IncludeGlobalMemory: includeGlobal,
	})

	if jsonOut {
		type jsonResult struct {
			Issues   []validate.Issue `json:"issues"`
			Errors   int              `json:"errors"`
			Warnings int              `json:"warnings"`
			Info     int              `json:"info"`
			Valid    bool             `json:"valid"`
		}
		printJSON(jsonResult{
			Issues:   result.Issues,
			Errors:   result.ErrorCount,
			Warnings: result.WarningCount,
			Info:     result.InfoCount,
			Valid:    result.Valid,
		})
		return nil
	}

	if plain {
		for _, iss := range result.Issues {
			fmt.Printf("%s [%s] %s\n",
				strings.ToUpper(iss.Level), iss.Entity, iss.Message)
		}
		fmt.Printf("\nSUMMARY: %d errors, %d warnings, %d info\n",
			result.ErrorCount, result.WarningCount, result.InfoCount)
		if result.Valid {
			fmt.Println("VALID: true")
		} else {
			fmt.Println("VALID: false")
		}
	} else {
		if len(result.Issues) == 0 {
			fmt.Println(RenderSuccess("Validation passed. No issues found."))
		} else {
			for _, iss := range result.Issues {
				var prefix string
				switch iss.Level {
				case "error":
					prefix = StyleError.Render("ERROR  ")
				case "warning":
					prefix = StyleWarning.Render("WARN   ")
				default:
					prefix = StyleInfo.Render("INFO   ")
				}
				fmt.Printf("%s %s %s\n", prefix, StyleDim.Render("["+iss.Entity+"]"), iss.Message)
			}
			fmt.Println()
			parts := []string{}
			if result.ErrorCount > 0 {
				parts = append(parts, StyleError.Render(fmt.Sprintf("%d error(s)", result.ErrorCount)))
			}
			if result.WarningCount > 0 {
				parts = append(parts, StyleWarning.Render(fmt.Sprintf("%d warning(s)", result.WarningCount)))
			}
			if result.InfoCount > 0 {
				parts = append(parts, StyleInfo.Render(fmt.Sprintf("%d info", result.InfoCount)))
			}
			fmt.Printf("%s %s\n", StyleBold.Render("Summary:"), strings.Join(parts, StyleDim.Render(", ")))
		}
	}

	if result.ErrorCount > 0 {
		return fmt.Errorf("validation failed with %d error(s)", result.ErrorCount)
	}
	return nil
}

func init() {
	validateCmd.Flags().String("scope", "all", "Validation scope: all|tasks|docs|templates|sdd")
	validateCmd.Flags().Bool("strict", false, "Treat warnings as errors")
	validateCmd.Flags().Bool("fix", false, "Auto-fix supported issues")
	validateCmd.Flags().String("entity", "", "Validate a specific entity (task ID or doc path)")
	validateCmd.Flags().Bool("include-global", false, "Also validate the user-level global memory layer, shared by every project")

	rootCmd.AddCommand(validateCmd)
}
