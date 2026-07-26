package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

var evalCmd = &cobra.Command{
	Use:   "eval",
	Short: "Evaluate deterministic quality gates",
}

var evalRetrievalCmd = &cobra.Command{
	Use:   "retrieval",
	Short: "Evaluate retrieval and final ContextPack quality",
	Args:  cobra.NoArgs,
	RunE:  runEvalRetrieval,
}

type evaluationExitError struct {
	outcome string
}

func (e evaluationExitError) Error() string {
	return "retrieval evaluation failed: " + e.outcome
}

func evaluationExit(cmd *cobra.Command, outcome string) error {
	cmd.Root().SilenceUsage = true
	return evaluationExitError{outcome: outcome}
}

func runEvalRetrieval(cmd *cobra.Command, _ []string) error {
	mode, _ := cmd.Flags().GetString("mode")
	casesPath, _ := cmd.Flags().GetString("cases")
	baselinePath, _ := cmd.Flags().GetString("baseline")
	updateBaseline, _ := cmd.Flags().GetBool("update-baseline")
	reason, _ := cmd.Flags().GetString("reason")
	runtimeIdentity, _ := cmd.Flags().GetString("runtime-id")
	outputPath, _ := cmd.Flags().GetString("output")

	if err := validateEvalRetrievalFlags(
		mode,
		casesPath,
		baselinePath,
		updateBaseline,
		reason,
		runtimeIdentity,
	); err != nil {
		report := evaluationFailureReport(
			mode,
			runtimeIdentity,
			evaluationScope(casesPath),
			casesPath != "",
			search.EvaluationOutcomeValidation,
			err,
		)
		if outputErr := emitEvaluationReport(cmd, report, outputPath); outputErr != nil {
			return outputErr
		}
		return evaluationExit(cmd, report.Outcome)
	}

	fixture, err := loadEvaluationFixture(casesPath)
	if err != nil {
		report := evaluationFailureReport(
			mode,
			runtimeIdentity,
			evaluationScope(casesPath),
			casesPath != "",
			search.EvaluationOutcomeValidation,
			err,
		)
		if outputErr := emitEvaluationReport(cmd, report, outputPath); outputErr != nil {
			return outputErr
		}
		return evaluationExit(cmd, report.Outcome)
	}
	if runtimeIdentity == "" && mode == string(search.ModeKeyword) {
		runtimeIdentity = "keyword"
	}

	if mode != string(search.ModeKeyword) {
		store, storeErr := getStoreErr()
		if storeErr != nil {
			report := evaluationFailureReport(
				mode,
				runtimeIdentity,
				evaluationScope(casesPath),
				casesPath != "",
				search.EvaluationOutcomeReadiness,
				storeErr,
			)
			if outputErr := emitEvaluationReport(cmd, report, outputPath); outputErr != nil {
				return outputErr
			}
			return evaluationExit(cmd, report.Outcome)
		}
		actualIdentity, readinessErr := search.RequirePinnedSemanticEvaluationRuntime(
			store,
			runtimeIdentity,
		)
		if readinessErr != nil {
			if actualIdentity != "" {
				runtimeIdentity = actualIdentity
			}
			report := evaluationFailureReport(
				mode,
				runtimeIdentity,
				evaluationScope(casesPath),
				casesPath != "",
				search.EvaluationOutcomeReadiness,
				readinessErr,
			)
			if outputErr := emitEvaluationReport(cmd, report, outputPath); outputErr != nil {
				return outputErr
			}
			return evaluationExit(cmd, report.Outcome)
		}
		runtimeIdentity = actualIdentity
	}

	var baseline *search.RetrievalEvaluationBaseline
	if casesPath == "" {
		baseline, err = loadEvaluationBaseline(baselinePath)
		if err != nil && !(updateBaseline && baselinePath != "" && errors.Is(err, os.ErrNotExist)) {
			report := evaluationFailureReport(
				mode,
				runtimeIdentity,
				"canonical",
				false,
				search.EvaluationOutcomeValidation,
				err,
			)
			if outputErr := emitEvaluationReport(cmd, report, outputPath); outputErr != nil {
				return outputErr
			}
			return evaluationExit(cmd, report.Outcome)
		}
		if !updateBaseline {
			if err := search.ValidateEvaluationBaseline(fixture, baseline, mode, runtimeIdentity); err != nil {
				report := evaluationFailureReport(
					mode,
					runtimeIdentity,
					"canonical",
					false,
					search.EvaluationOutcomeValidation,
					err,
				)
				if outputErr := emitEvaluationReport(cmd, report, outputPath); outputErr != nil {
					return outputErr
				}
				return evaluationExit(cmd, report.Outcome)
			}
		}
	}

	store, err := getStoreErr()
	if err != nil {
		report := evaluationFailureReport(
			mode,
			runtimeIdentity,
			evaluationScope(casesPath),
			casesPath != "",
			search.EvaluationOutcomeValidation,
			err,
		)
		if outputErr := emitEvaluationReport(cmd, report, outputPath); outputErr != nil {
			return outputErr
		}
		return evaluationExit(cmd, report.Outcome)
	}
	report, err := search.EvaluateRetrievalFixture(
		fixture,
		retrievalEvaluationExecutor(store),
		search.RetrievalEvaluationOptions{
			Mode:            mode,
			RuntimeIdentity: runtimeIdentity,
			Scope:           evaluationScope(casesPath),
			ReportOnly:      casesPath != "",
		},
	)
	if err != nil {
		outcome := search.EvaluationOutcomeValidation
		if mode != string(search.ModeKeyword) {
			outcome = search.EvaluationOutcomeReadiness
		}
		report = evaluationFailureReport(
			mode,
			runtimeIdentity,
			evaluationScope(casesPath),
			casesPath != "",
			outcome,
			err,
		)
		if outputErr := emitEvaluationReport(cmd, report, outputPath); outputErr != nil {
			return outputErr
		}
		return evaluationExit(cmd, report.Outcome)
	}

	if updateBaseline {
		if report.Outcome == search.EvaluationOutcomeHardInvariant {
			if err := emitEvaluationReport(cmd, report, outputPath); err != nil {
				return err
			}
			return evaluationExit(cmd, report.Outcome)
		}
		tolerances := search.DefaultEvaluationTolerances()
		if baseline != nil && len(baseline.Tolerances) > 0 {
			tolerances = baseline.Tolerances
		}
		updated, err := search.BuildEvaluationBaseline(
			fixture,
			report,
			reason,
			tolerances,
		)
		if err != nil {
			failure := evaluationFailureReport(
				mode,
				runtimeIdentity,
				"canonical",
				false,
				search.EvaluationOutcomeValidation,
				err,
			)
			if outputErr := emitEvaluationReport(cmd, failure, outputPath); outputErr != nil {
				return outputErr
			}
			return evaluationExit(cmd, failure.Outcome)
		}
		target := baselinePath
		if target == "" {
			target = search.CanonicalEvaluationBaselinePath
		}
		if err := search.WriteEvaluationBaseline(target, updated); err != nil {
			return err
		}
		fmt.Fprintf(cmd.ErrOrStderr(), "Updated retrieval evaluation baseline: %s\n", target)
	} else if casesPath == "" {
		if err := search.ApplyEvaluationBaselineGate(report, baseline); err != nil {
			return err
		}
	}

	if err := emitEvaluationReport(cmd, report, outputPath); err != nil {
		return err
	}
	if !report.ReportOnly && report.Outcome != search.EvaluationOutcomePass {
		return evaluationExit(cmd, report.Outcome)
	}
	return nil
}

func retrievalEvaluationExecutor(store *storage.Store) search.RetrievalEvaluationExecutor {
	return func(tc search.RetrievalEvaluationCase, mode string) (*models.RetrievalResponse, error) {
		limit := tc.Limit
		if limit <= 0 {
			limit = 20
		}
		response, runtimeMeta, err := search.RetrieveWithRuntime(store, models.RetrievalOptions{
			Query:             tc.Query,
			Mode:              mode,
			Limit:             limit,
			SourceTypes:       append([]string{}, tc.SourceTypes...),
			ExpandReferences:  tc.ExpandReferences,
			IncludeHistorical: tc.IncludeHistorical,
		})
		if err != nil {
			return nil, err
		}
		if runtimeMeta != nil && runtimeMeta.Degraded {
			return nil, fmt.Errorf(
				"%s runtime degraded (%s): %s; evaluation forbids fallback",
				mode,
				runtimeMeta.Reason,
				runtimeMeta.Message,
			)
		}
		if response.Mode != mode {
			return nil, fmt.Errorf(
				"requested %s mode but retrieval returned %s; evaluation forbids fallback",
				mode,
				response.Mode,
			)
		}
		return response, nil
	}
}

func validateEvalRetrievalFlags(
	mode string,
	casesPath string,
	baselinePath string,
	updateBaseline bool,
	reason string,
	runtimeIdentity string,
) error {
	switch mode {
	case string(search.ModeKeyword), string(search.ModeSemantic), string(search.ModeHybrid):
	default:
		return fmt.Errorf("mode: unsupported evaluation mode %q", mode)
	}
	if casesPath != "" {
		if baselinePath != "" {
			return fmt.Errorf("project-local --cases cannot use a canonical --baseline")
		}
		if updateBaseline {
			return fmt.Errorf("project-local --cases are report-only and cannot update baselines")
		}
	}
	if updateBaseline && strings.TrimSpace(reason) == "" {
		return fmt.Errorf("--update-baseline requires a non-empty --reason")
	}
	if mode != string(search.ModeKeyword) && strings.TrimSpace(runtimeIdentity) == "" {
		return fmt.Errorf("--runtime-id is required for %s evaluation", mode)
	}
	if mode != string(search.ModeKeyword) && updateBaseline && baselinePath == "" {
		return fmt.Errorf("--baseline is required when updating a %s baseline", mode)
	}
	return nil
}

func loadEvaluationFixture(path string) (*search.RetrievalEvaluationFixture, error) {
	if path == "" {
		return search.LoadCanonicalEvaluationFixture()
	}
	return search.LoadEvaluationFixtureFile(path)
}

func loadEvaluationBaseline(path string) (*search.RetrievalEvaluationBaseline, error) {
	if path == "" {
		return search.LoadCanonicalEvaluationBaseline()
	}
	return search.LoadEvaluationBaselineFile(path)
}

func evaluationScope(casesPath string) string {
	if casesPath == "" {
		return "canonical"
	}
	return "project-local"
}

func evaluationFailureReport(
	mode string,
	runtimeIdentity string,
	scope string,
	reportOnly bool,
	outcome string,
	err error,
) *search.RetrievalEvaluationReport {
	message := "evaluation failed"
	if err != nil {
		message = err.Error()
	}
	return &search.RetrievalEvaluationReport{
		SchemaVersion:   search.EvaluationReportSchemaVersion,
		Mode:            mode,
		RuntimeIdentity: runtimeIdentity,
		Scope:           scope,
		ReportOnly:      reportOnly,
		Outcome:         outcome,
		Cases:           []search.RetrievalEvaluationCaseReport{},
		Failures: []search.RetrievalEvaluationFailure{{
			Kind:    outcome,
			Message: message,
		}},
	}
}

func emitEvaluationReport(
	cmd *cobra.Command,
	report *search.RetrievalEvaluationReport,
	outputPath string,
) error {
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return fmt.Errorf("encode evaluation report: %w", err)
	}
	data = append(data, '\n')
	if outputPath != "" {
		if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
			return fmt.Errorf("create evaluation report directory: %w", err)
		}
		if err := os.WriteFile(outputPath, data, 0o644); err != nil {
			return fmt.Errorf("write evaluation report: %w", err)
		}
	}
	if isJSON(cmd) {
		_, err = cmd.OutOrStdout().Write(data)
		return err
	}
	_, err = fmt.Fprint(cmd.OutOrStdout(), search.FormatRetrievalEvaluationReport(report))
	return err
}

func init() {
	evalRetrievalCmd.Flags().String(
		"cases",
		"",
		"Project-local fixture path (report-only; never gates or updates canonical baselines)",
	)
	evalRetrievalCmd.Flags().String(
		"baseline",
		"",
		"Baseline file override (canonical runs only)",
	)
	evalRetrievalCmd.Flags().String(
		"mode",
		string(search.ModeKeyword),
		"Evaluation mode: keyword|semantic|hybrid",
	)
	evalRetrievalCmd.Flags().String(
		"runtime-id",
		"",
		"Pinned runtime/model identity required by semantic and hybrid evaluation",
	)
	evalRetrievalCmd.Flags().Bool(
		"update-baseline",
		false,
		"Explicitly replace a canonical baseline from the current reviewed result",
	)
	evalRetrievalCmd.Flags().String(
		"reason",
		"",
		"Review reason required with --update-baseline",
	)
	evalRetrievalCmd.Flags().String(
		"output",
		"",
		"Write the versioned JSON report to this explicit path",
	)

	evalCmd.AddCommand(evalRetrievalCmd)
	rootCmd.AddCommand(evalCmd)
}

var _ error = evaluationExitError{}
