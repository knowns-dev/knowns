package search

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// DefaultEvaluationTolerances are reviewed quality regressions allowed by the
// canonical MVP gate. Latency is intentionally absent.
func DefaultEvaluationTolerances() map[string]float64 {
	return map[string]float64{
		"ndcgAt10":   0.01,
		"mrrAt10":    0.01,
		"recallAt5":  0.01,
		"recallAt10": 0.01,
		"recallAt20": 0.01,
		"successAtK": 0,
	}
}

// ApplyEvaluationBaselineGate compares quality metrics and annotates the report.
func ApplyEvaluationBaselineGate(
	report *RetrievalEvaluationReport,
	baseline *RetrievalEvaluationBaseline,
) error {
	if report == nil {
		return fmt.Errorf("evaluation report: required")
	}
	if baseline == nil {
		return fmt.Errorf("evaluation baseline: required")
	}
	if report.ReportOnly {
		return fmt.Errorf("report-only evaluation cannot be compared with a canonical baseline")
	}
	baselineCases := make(map[string]EvaluationBaselineCase, len(baseline.Cases))
	for _, tc := range baseline.Cases {
		baselineCases[tc.ID] = tc
	}
	currentCases := make(map[string]RetrievalEvaluationCaseReport, len(report.Cases))
	for _, tc := range report.Cases {
		currentCases[tc.ID] = tc
	}

	metricNames := make([]string, 0, len(baseline.Tolerances))
	for metric := range baseline.Tolerances {
		metricNames = append(metricNames, metric)
	}
	sort.Strings(metricNames)
	for _, metric := range metricNames {
		tolerance := baseline.Tolerances[metric]
		baselineValue, ok := baseline.Aggregate.Value(metric)
		if !ok {
			return fmt.Errorf("baseline.tolerances.%s: unsupported metric", metric)
		}
		observedValue, _ := report.Aggregate.Value(metric)
		delta := observedValue - baselineValue
		if delta >= -tolerance {
			continue
		}
		report.Failures = append(report.Failures, RetrievalEvaluationFailure{
			Kind:      EvaluationOutcomeGatedFailure,
			Metric:    metric,
			Baseline:  baselineValue,
			Observed:  observedValue,
			Delta:     delta,
			Tolerance: tolerance,
			Message: fmt.Sprintf(
				"%s regressed by %.4f (baseline %.4f, observed %.4f, tolerance %.4f)",
				metric,
				-delta,
				baselineValue,
				observedValue,
				tolerance,
			),
		})
		caseIDs := make([]string, 0, len(currentCases))
		for id := range currentCases {
			caseIDs = append(caseIDs, id)
		}
		sort.Strings(caseIDs)
		for _, id := range caseIDs {
			baselineCase, exists := baselineCases[id]
			if !exists {
				continue
			}
			currentCase := currentCases[id]
			caseBaseline, _ := baselineCase.Metrics.Value(metric)
			caseObserved, _ := currentCase.Metrics.Value(metric)
			caseDelta := caseObserved - caseBaseline
			if caseDelta >= 0 {
				continue
			}
			report.Failures = append(report.Failures, RetrievalEvaluationFailure{
				Kind:      EvaluationOutcomeGatedFailure,
				CaseID:    id,
				Metric:    metric,
				Baseline:  caseBaseline,
				Observed:  caseObserved,
				Delta:     caseDelta,
				Tolerance: tolerance,
				Message: fmt.Sprintf(
					"%s contributed a %.4f regression; expected/observed ranks are in the case report",
					metric,
					-caseDelta,
				),
			})
		}
	}
	if containsEvaluationFailureKind(report.Failures, EvaluationOutcomeHardInvariant) {
		report.Outcome = EvaluationOutcomeHardInvariant
	} else if containsEvaluationFailureKind(report.Failures, EvaluationOutcomeGatedFailure) {
		report.Outcome = EvaluationOutcomeGatedFailure
	} else {
		report.Outcome = EvaluationOutcomePass
	}
	return nil
}

// BuildEvaluationBaseline creates deterministic baseline data from a report.
func BuildEvaluationBaseline(
	fixture *RetrievalEvaluationFixture,
	report *RetrievalEvaluationReport,
	reason string,
	tolerances map[string]float64,
) (*RetrievalEvaluationBaseline, error) {
	if err := ValidateEvaluationFixture(fixture); err != nil {
		return nil, err
	}
	if report == nil {
		return nil, fmt.Errorf("evaluation report: required")
	}
	if strings.TrimSpace(reason) == "" {
		return nil, fmt.Errorf("baseline update reason: required")
	}
	if report.ReportOnly || report.Scope != "canonical" {
		return nil, fmt.Errorf("project-local or report-only evaluation cannot update the canonical baseline")
	}
	if report.Outcome == EvaluationOutcomeHardInvariant ||
		report.Outcome == EvaluationOutcomeReadiness ||
		report.Outcome == EvaluationOutcomeValidation {
		return nil, fmt.Errorf("cannot update baseline from %s", report.Outcome)
	}
	if len(tolerances) == 0 {
		tolerances = DefaultEvaluationTolerances()
	}
	toleranceCopy := make(map[string]float64, len(tolerances))
	for metric, tolerance := range tolerances {
		if _, ok := report.Aggregate.Value(metric); !ok {
			return nil, fmt.Errorf("baseline tolerance %q: unsupported metric", metric)
		}
		if tolerance < 0 || tolerance > 1 {
			return nil, fmt.Errorf("baseline tolerance %q: must be between 0 and 1", metric)
		}
		toleranceCopy[metric] = tolerance
	}
	digest, err := EvaluationFixtureDigest(fixture)
	if err != nil {
		return nil, err
	}
	reportCases := make(map[string]RetrievalEvaluationCaseReport, len(report.Cases))
	for _, tc := range report.Cases {
		reportCases[tc.ID] = tc
	}
	baselineCases := make([]EvaluationBaselineCase, 0, len(fixture.Cases))
	for _, fixtureCase := range fixture.Cases {
		reportCase, ok := reportCases[fixtureCase.ID]
		if !ok {
			return nil, fmt.Errorf("evaluation report: missing case %q", fixtureCase.ID)
		}
		baselineCases = append(baselineCases, EvaluationBaselineCase{
			ID:               fixtureCase.ID,
			Metrics:          reportCase.Metrics,
			CandidateRanking: append([]string{}, reportCase.CandidateRanking...),
			ContextPackItems: append([]string{}, reportCase.ContextPackItems...),
		})
	}
	return &RetrievalEvaluationBaseline{
		SchemaVersion:        EvaluationBaselineSchemaVersion,
		FixtureSchemaVersion: fixture.SchemaVersion,
		FixtureDigest:        digest,
		Mode:                 report.Mode,
		RuntimeIdentity:      report.RuntimeIdentity,
		Reason:               strings.TrimSpace(reason),
		Tolerances:           toleranceCopy,
		Aggregate:            report.Aggregate,
		Cases:                baselineCases,
	}, nil
}

// WriteEvaluationBaseline writes a deterministic, atomic reviewable baseline.
func WriteEvaluationBaseline(path string, baseline *RetrievalEvaluationBaseline) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("baseline path: required")
	}
	if baseline == nil {
		return fmt.Errorf("evaluation baseline: required")
	}
	data, err := json.MarshalIndent(baseline, "", "  ")
	if err != nil {
		return fmt.Errorf("encode evaluation baseline: %w", err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create evaluation baseline directory: %w", err)
	}
	temp, err := os.CreateTemp(dir, ".retrieval-evaluation-baseline-*")
	if err != nil {
		return fmt.Errorf("create temporary evaluation baseline: %w", err)
	}
	tempPath := temp.Name()
	cleanup := func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}
	if _, err := temp.Write(data); err != nil {
		cleanup()
		return fmt.Errorf("write temporary evaluation baseline: %w", err)
	}
	if err := temp.Chmod(0o644); err != nil {
		cleanup()
		return fmt.Errorf("chmod temporary evaluation baseline: %w", err)
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		return fmt.Errorf("close temporary evaluation baseline: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		if runtime.GOOS != "windows" {
			_ = os.Remove(tempPath)
			return fmt.Errorf("replace evaluation baseline: %w", err)
		}
		if removeErr := os.Remove(path); removeErr != nil && !os.IsNotExist(removeErr) {
			_ = os.Remove(tempPath)
			return fmt.Errorf("replace evaluation baseline: %w", err)
		}
		if retryErr := os.Rename(tempPath, path); retryErr != nil {
			_ = os.Remove(tempPath)
			return fmt.Errorf("replace evaluation baseline after Windows target removal: %w", retryErr)
		}
	}
	return nil
}
