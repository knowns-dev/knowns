package search

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplyEvaluationBaselineGateUsesToleranceAndNamesCases(t *testing.T) {
	report := evaluationGateReport(0.79)
	baseline := evaluationGateBaseline(0.80, 0.02)
	if err := ApplyEvaluationBaselineGate(report, baseline); err != nil {
		t.Fatal(err)
	}
	if report.Outcome != EvaluationOutcomePass {
		t.Fatalf("within-tolerance outcome = %q", report.Outcome)
	}

	report = evaluationGateReport(0.70)
	if err := ApplyEvaluationBaselineGate(report, baseline); err != nil {
		t.Fatal(err)
	}
	if report.Outcome != EvaluationOutcomeGatedFailure {
		t.Fatalf("regression outcome = %q", report.Outcome)
	}
	if len(report.Failures) < 2 {
		t.Fatalf("failures = %+v, want aggregate and case diagnostics", report.Failures)
	}
	if report.Failures[0].Metric != "recallAt10" ||
		report.Failures[1].CaseID != "case-1" {
		t.Fatalf("failures = %+v", report.Failures)
	}
}

func TestBuildEvaluationBaselineRequiresExplicitReasonAndIsDeterministic(t *testing.T) {
	fixture := evaluationTestFixture()
	report := evaluationGateReport(1)
	report.FixtureSchemaVersion = fixture.SchemaVersion
	report.Scope = "canonical"
	report.Mode = "keyword"
	report.RuntimeIdentity = "keyword"
	report.Cases[0].CandidateRanking = []string{"doc-a", "doc-b"}
	report.Cases[0].ContextPackItems = []string{"doc-a"}

	if _, err := BuildEvaluationBaseline(fixture, report, "", nil); err == nil ||
		!strings.Contains(err.Error(), "reason") {
		t.Fatalf("missing reason error = %v", err)
	}
	baseline, err := BuildEvaluationBaseline(fixture, report, "Reviewed ranking change", nil)
	if err != nil {
		t.Fatal(err)
	}
	if baseline.Reason != "Reviewed ranking change" || baseline.FixtureDigest == "" {
		t.Fatalf("baseline = %+v", baseline)
	}

	path := filepath.Join(t.TempDir(), "baseline.json")
	if err := WriteEvaluationBaseline(path, baseline); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteEvaluationBaseline(path, baseline); err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatal("baseline write is not deterministic")
	}
}

func TestBuildEvaluationBaselineRejectsProjectLocalReport(t *testing.T) {
	fixture := evaluationTestFixture()
	report := evaluationGateReport(1)
	report.Scope = "project-local"
	report.ReportOnly = true
	report.Outcome = EvaluationOutcomeReportOnly
	if _, err := BuildEvaluationBaseline(fixture, report, "reason", nil); err == nil {
		t.Fatal("expected project-local baseline update rejection")
	}
}

func evaluationGateReport(recallAt10 float64) *RetrievalEvaluationReport {
	metrics := EvaluationMetrics{RecallAt10: recallAt10}
	return &RetrievalEvaluationReport{
		SchemaVersion: EvaluationReportSchemaVersion,
		Scope:         "canonical",
		Outcome:       EvaluationOutcomePass,
		Aggregate:     metrics,
		Cases: []RetrievalEvaluationCaseReport{{
			ID:      "case-1",
			Metrics: metrics,
		}},
	}
}

func evaluationGateBaseline(recallAt10, tolerance float64) *RetrievalEvaluationBaseline {
	metrics := EvaluationMetrics{RecallAt10: recallAt10}
	return &RetrievalEvaluationBaseline{
		Tolerances: map[string]float64{"recallAt10": tolerance},
		Aggregate:  metrics,
		Cases: []EvaluationBaselineCase{{
			ID:      "case-1",
			Metrics: metrics,
		}},
	}
}
