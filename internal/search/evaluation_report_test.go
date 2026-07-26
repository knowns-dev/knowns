package search

import (
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestEvaluateRetrievalFixtureReportsContextPackLossAndLatency(t *testing.T) {
	fixture := evaluationTestFixture()
	times := []time.Time{
		time.Unix(0, 0),
		time.Unix(0, int64(8*time.Millisecond)),
		time.Unix(0, int64(10*time.Millisecond)),
	}
	timeIndex := 0
	report, err := EvaluateRetrievalFixture(
		fixture,
		func(_ RetrievalEvaluationCase, _ string) (*models.RetrievalResponse, error) {
			return &models.RetrievalResponse{
				Mode: "keyword",
				Candidates: []models.RetrievalCandidate{
					{Type: "doc", ID: "doc-a", Citation: models.Citation{Type: "doc", Path: "doc-a"}},
					{Type: "doc", ID: "doc-b", Citation: models.Citation{Type: "doc", Path: "doc-b"}},
				},
				ContextPack: models.ContextPack{Items: []models.ContextItem{{
					Type:     "doc",
					ID:       "doc-a",
					Content:  "four token sized text",
					Citation: models.Citation{Type: "doc", Path: "doc-a"},
				}}},
			}, nil
		},
		RetrievalEvaluationOptions{
			Mode:            "keyword",
			RuntimeIdentity: "keyword",
			Now: func() time.Time {
				value := times[timeIndex]
				timeIndex++
				return value
			},
		},
	)
	if err != nil {
		t.Fatalf("EvaluateRetrievalFixture: %v", err)
	}
	tc := report.Cases[0]
	if tc.CandidateRecall != 1 || tc.ContextPackRecall != 0.5 {
		t.Fatalf("recalls = candidate %.2f pack %.2f", tc.CandidateRecall, tc.ContextPackRecall)
	}
	if len(tc.RelevantLost) != 1 || tc.RelevantLost[0] != "doc-b" {
		t.Fatalf("relevant lost = %v, want doc-b", tc.RelevantLost)
	}
	if tc.Latency.RetrievalMillis != 8 || tc.Latency.EvaluationMillis != 2 || report.Latency.P50Millis != 10 {
		t.Fatalf("latency = case %+v aggregate %+v", tc.Latency, report.Latency)
	}
	if tc.ContextBytes == 0 || tc.ContextTokens == 0 {
		t.Fatalf("context size = %d bytes / %d tokens", tc.ContextBytes, tc.ContextTokens)
	}
}

func TestEvaluateRetrievalFixtureHardInvariantsOverrideQuality(t *testing.T) {
	fixture := evaluationTestFixture()
	fixture.Cases[0].ForbiddenSources = []string{"doc:doc-stale"}
	report, err := EvaluateRetrievalFixture(
		fixture,
		func(_ RetrievalEvaluationCase, _ string) (*models.RetrievalResponse, error) {
			return &models.RetrievalResponse{
				Mode: "keyword",
				Candidates: []models.RetrievalCandidate{
					{Type: "doc", ID: "doc-a", Citation: models.Citation{Type: "doc", Path: "doc-a"}},
					{Type: "doc", ID: "doc-b", Citation: models.Citation{Type: "doc", Path: "doc-b"}},
					{Type: "doc", ID: "doc-stale", Citation: models.Citation{Type: "doc", Path: "doc-stale"}},
				},
				ContextPack: models.ContextPack{Items: []models.ContextItem{
					{Type: "doc", ID: "doc-a", Citation: models.Citation{Type: "doc", Path: "doc-a"}},
					{Type: "doc", ID: "doc-b", Citation: models.Citation{Type: "doc", Path: "doc-b"}},
					{Type: "doc", ID: "doc-stale", Citation: models.Citation{Type: "doc", Path: "doc-stale"}},
				}},
			}, nil
		},
		RetrievalEvaluationOptions{Mode: "keyword"},
	)
	if err != nil {
		t.Fatalf("EvaluateRetrievalFixture: %v", err)
	}
	if report.Aggregate.RecallAt10 != 1 || report.Outcome != EvaluationOutcomeHardInvariant {
		t.Fatalf("aggregate=%+v outcome=%q", report.Aggregate, report.Outcome)
	}
	if len(report.Failures) != 1 || !strings.Contains(report.Failures[0].Message, "doc-stale") {
		t.Fatalf("failures = %+v", report.Failures)
	}
}

func TestProjectLocalEvaluationIsReportOnly(t *testing.T) {
	fixture := evaluationTestFixture()
	report, err := EvaluateRetrievalFixture(
		fixture,
		func(_ RetrievalEvaluationCase, _ string) (*models.RetrievalResponse, error) {
			return &models.RetrievalResponse{
				Mode: "keyword",
				Candidates: []models.RetrievalCandidate{{
					Type: "doc",
					ID:   "noise",
				}},
				ContextPack: models.ContextPack{},
			}, nil
		},
		RetrievalEvaluationOptions{
			Mode:       "keyword",
			Scope:      "project-local",
			ReportOnly: true,
		},
	)
	if err != nil {
		t.Fatalf("EvaluateRetrievalFixture: %v", err)
	}
	if report.Outcome != EvaluationOutcomeReportOnly || !report.ReportOnly {
		t.Fatalf("report-only outcome = %+v", report)
	}
}

func TestFormatRetrievalEvaluationReportIncludesMachineReportEvidence(t *testing.T) {
	fixture := evaluationTestFixture()
	report, err := EvaluateRetrievalFixture(
		fixture,
		func(_ RetrievalEvaluationCase, _ string) (*models.RetrievalResponse, error) {
			return &models.RetrievalResponse{
				Mode: "keyword",
				Candidates: []models.RetrievalCandidate{
					{Type: "doc", ID: "doc-a", Citation: models.Citation{Type: "doc", Path: "doc-a"}},
					{Type: "doc", ID: "doc-b", Citation: models.Citation{Type: "doc", Path: "doc-b"}},
				},
				ContextPack: models.ContextPack{Items: []models.ContextItem{
					{Type: "doc", ID: "doc-a", Citation: models.Citation{Type: "doc", Path: "doc-a"}},
					{Type: "doc", ID: "doc-b", Citation: models.Citation{Type: "doc", Path: "doc-b"}},
				}},
			}, nil
		},
		RetrievalEvaluationOptions{Mode: "keyword"},
	)
	if err != nil {
		t.Fatal(err)
	}
	human := FormatRetrievalEvaluationReport(report)
	for _, expected := range []string{
		"Retrieval evaluation: pass",
		"nDCG@10=",
		"MRR@10=",
		"Recall@5=",
		"Latency (report-only):",
		"candidateRecall=",
		"expected doc-a",
	} {
		if !strings.Contains(human, expected) {
			t.Fatalf("human report missing %q:\n%s", expected, human)
		}
	}
}

func evaluationTestFixture() *RetrievalEvaluationFixture {
	return &RetrievalEvaluationFixture{
		SchemaVersion: EvaluationFixtureSchemaVersion,
		Cases: []RetrievalEvaluationCase{{
			ID:                "case-1",
			Category:          "exact",
			Query:             "query",
			Qrels:             []EvaluationQrel{{Source: "doc-a", Relevance: 3}, {Source: "doc-b", Relevance: 2}},
			ExpectedCitations: []string{"doc:doc-a"},
			Modes:             []string{"keyword"},
		}},
	}
}
