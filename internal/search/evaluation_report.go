package search

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

const (
	EvaluationOutcomePass          = "pass"
	EvaluationOutcomeGatedFailure  = "gated-failure"
	EvaluationOutcomeHardInvariant = "hard-invariant-failure"
	EvaluationOutcomeReadiness     = "readiness-failure"
	EvaluationOutcomeValidation    = "validation-failure"
	EvaluationOutcomeReportOnly    = "report-only"
)

// RetrievalEvaluationExecutor runs one already-validated case in an exact mode.
type RetrievalEvaluationExecutor func(
	tc RetrievalEvaluationCase,
	mode string,
) (*models.RetrievalResponse, error)

// RetrievalEvaluationOptions configures reporting without altering retrieval.
type RetrievalEvaluationOptions struct {
	Mode            string
	RuntimeIdentity string
	Scope           string
	ReportOnly      bool
	Now             func() time.Time
}

// RetrievalEvaluationReport is the stable machine-readable evaluation artifact.
type RetrievalEvaluationReport struct {
	SchemaVersion        int                             `json:"schemaVersion"`
	FixtureSchemaVersion int                             `json:"fixtureSchemaVersion"`
	FixtureDigest        string                          `json:"fixtureDigest"`
	Mode                 string                          `json:"mode"`
	RuntimeIdentity      string                          `json:"runtimeIdentity"`
	Scope                string                          `json:"scope"`
	ReportOnly           bool                            `json:"reportOnly"`
	Outcome              string                          `json:"outcome"`
	Summary              BenchmarkSummary                `json:"summary"`
	Aggregate            EvaluationMetrics               `json:"aggregate"`
	Latency              EvaluationLatencySummary        `json:"latency"`
	Cases                []RetrievalEvaluationCaseReport `json:"cases"`
	Failures             []RetrievalEvaluationFailure    `json:"failures"`
}

// RetrievalEvaluationCaseReport contains both ranking and ContextPack evidence.
type RetrievalEvaluationCaseReport struct {
	ID                       string                   `json:"id"`
	Category                 string                   `json:"category"`
	Query                    string                   `json:"query"`
	Verdict                  string                   `json:"verdict"`
	Why                      string                   `json:"why"`
	Metrics                  EvaluationMetrics        `json:"metrics"`
	CandidateRecall          float64                  `json:"candidateRecall"`
	ContextPackRecall        float64                  `json:"contextPackRecall"`
	CandidateRanking         []string                 `json:"candidateRanking"`
	ContextPackItems         []string                 `json:"contextPackItems"`
	ExpectedRanks            []EvaluationExpectedRank `json:"expectedRanks"`
	RelevantLost             []string                 `json:"relevantLost"`
	ExpectedCitations        []string                 `json:"expectedCitations,omitempty"`
	ObservedCitations        []string                 `json:"observedCitations,omitempty"`
	ForbiddenSourcesObserved []string                 `json:"forbiddenSourcesObserved,omitempty"`
	ContextBytes             int                      `json:"contextBytes"`
	ContextTokens            int                      `json:"contextTokens"`
	RedundantItems           []string                 `json:"redundantItems,omitempty"`
	Latency                  EvaluationStageLatency   `json:"latency"`
	Notes                    string                   `json:"notes,omitempty"`
}

// EvaluationExpectedRank provides actionable expected/observed ranking detail.
type EvaluationExpectedRank struct {
	Source        string `json:"source"`
	Relevance     int    `json:"relevance"`
	CandidateRank int    `json:"candidateRank,omitempty"`
	ContextRank   int    `json:"contextRank,omitempty"`
}

// EvaluationStageLatency is report-only and never participates in gate status.
type EvaluationStageLatency struct {
	RetrievalMillis  float64 `json:"retrievalMillis"`
	EvaluationMillis float64 `json:"evaluationMillis"`
	TotalMillis      float64 `json:"totalMillis"`
}

// RetrievalEvaluationFailure is a typed, actionable evaluation observation.
type RetrievalEvaluationFailure struct {
	Kind      string  `json:"kind"`
	CaseID    string  `json:"caseId,omitempty"`
	Metric    string  `json:"metric,omitempty"`
	Baseline  float64 `json:"baseline,omitempty"`
	Observed  float64 `json:"observed,omitempty"`
	Delta     float64 `json:"delta,omitempty"`
	Tolerance float64 `json:"tolerance,omitempty"`
	Message   string  `json:"message"`
}

// EvaluateRetrievalFixture evaluates existing retrieval output without
// modifying ranking, routing, reference expansion, or ContextPack assembly.
func EvaluateRetrievalFixture(
	fixture *RetrievalEvaluationFixture,
	execute RetrievalEvaluationExecutor,
	opts RetrievalEvaluationOptions,
) (*RetrievalEvaluationReport, error) {
	if err := ValidateEvaluationFixture(fixture); err != nil {
		return nil, err
	}
	if execute == nil {
		return nil, fmt.Errorf("evaluation executor: required")
	}
	if !supportedEvaluationModes[opts.Mode] {
		return nil, fmt.Errorf("mode: unsupported evaluation mode %q", opts.Mode)
	}
	for _, tc := range fixture.Cases {
		if !containsKey(tc.Modes, opts.Mode) {
			return nil, fmt.Errorf("case %q modes: mode %q is not supported", tc.ID, opts.Mode)
		}
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	scope := strings.TrimSpace(opts.Scope)
	if scope == "" {
		scope = "canonical"
	}
	runtimeIdentity := strings.TrimSpace(opts.RuntimeIdentity)
	if runtimeIdentity == "" && opts.Mode == string(ModeKeyword) {
		runtimeIdentity = "keyword"
	}
	digest, err := EvaluationFixtureDigest(fixture)
	if err != nil {
		return nil, err
	}
	report := &RetrievalEvaluationReport{
		SchemaVersion:        EvaluationReportSchemaVersion,
		FixtureSchemaVersion: fixture.SchemaVersion,
		FixtureDigest:        digest,
		Mode:                 opts.Mode,
		RuntimeIdentity:      runtimeIdentity,
		Scope:                scope,
		ReportOnly:           opts.ReportOnly,
		Outcome:              EvaluationOutcomePass,
		Cases:                make([]RetrievalEvaluationCaseReport, 0, len(fixture.Cases)),
		Failures:             []RetrievalEvaluationFailure{},
	}

	legacyReports := make([]BenchmarkCaseReport, 0, len(fixture.Cases))
	caseMetrics := make([]EvaluationMetrics, 0, len(fixture.Cases))
	latencies := make([]time.Duration, 0, len(fixture.Cases))
	for _, tc := range fixture.Cases {
		startedAt := now()
		response, err := execute(tc, opts.Mode)
		retrievedAt := now()
		if err != nil {
			return nil, fmt.Errorf("case %q retrieval: %w", tc.ID, err)
		}
		if response == nil {
			return nil, fmt.Errorf("case %q retrieval: empty response", tc.ID)
		}
		caseReport, legacy, failures := buildRetrievalEvaluationCaseReport(tc, response)
		finishedAt := now()
		caseReport.Latency = EvaluationStageLatency{
			RetrievalMillis:  durationMillis(retrievedAt.Sub(startedAt)),
			EvaluationMillis: durationMillis(finishedAt.Sub(retrievedAt)),
			TotalMillis:      durationMillis(finishedAt.Sub(startedAt)),
		}
		report.Cases = append(report.Cases, caseReport)
		report.Failures = append(report.Failures, failures...)
		legacyReports = append(legacyReports, legacy)
		caseMetrics = append(caseMetrics, caseReport.Metrics)
		latencies = append(latencies, finishedAt.Sub(startedAt))
	}
	report.Summary = SummarizeBenchmarkReports(legacyReports, 10)
	report.Aggregate = AggregateEvaluationMetrics(caseMetrics)
	report.Latency = SummarizeEvaluationLatency(latencies)

	if opts.ReportOnly {
		report.Outcome = EvaluationOutcomeReportOnly
	} else if containsEvaluationFailureKind(report.Failures, EvaluationOutcomeHardInvariant) {
		report.Outcome = EvaluationOutcomeHardInvariant
	}
	return report, nil
}

// FormatRetrievalEvaluationReport renders the same report fields for humans.
func FormatRetrievalEvaluationReport(report *RetrievalEvaluationReport) string {
	if report == nil {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Retrieval evaluation: %s\n", report.Outcome)
	fmt.Fprintf(&b, "Mode: %s (%s)\n", report.Mode, report.RuntimeIdentity)
	fmt.Fprintf(&b, "Scope: %s", report.Scope)
	if report.ReportOnly {
		fmt.Fprint(&b, " [report-only]")
	}
	fmt.Fprintln(&b)
	fmt.Fprintf(
		&b,
		"Cases: %d | pass=%d partial=%d fail=%d skipped=%d\n",
		report.Summary.Total,
		report.Summary.Pass,
		report.Summary.Partial,
		report.Summary.Fail,
		report.Summary.Skipped,
	)
	fmt.Fprintf(
		&b,
		"Metrics: nDCG@10=%.4f MRR@10=%.4f Recall@5=%.4f Recall@10=%.4f Recall@20=%.4f Success@K=%.4f\n",
		report.Aggregate.NDCGAt10,
		report.Aggregate.MRRAt10,
		report.Aggregate.RecallAt5,
		report.Aggregate.RecallAt10,
		report.Aggregate.RecallAt20,
		report.Aggregate.SuccessAtK,
	)
	fmt.Fprintf(
		&b,
		"Latency (report-only): p50=%.2fms p95=%.2fms\n",
		report.Latency.P50Millis,
		report.Latency.P95Millis,
	)
	for _, tc := range report.Cases {
		fmt.Fprintf(
			&b,
			"\n[%s] %s — %s\n  candidateRecall=%.4f contextPackRecall=%.4f context=%dB/~%d tokens latency=%.2fms\n",
			strings.ToUpper(tc.Verdict),
			tc.ID,
			tc.Why,
			tc.CandidateRecall,
			tc.ContextPackRecall,
			tc.ContextBytes,
			tc.ContextTokens,
			tc.Latency.TotalMillis,
		)
		for _, expected := range tc.ExpectedRanks {
			fmt.Fprintf(
				&b,
				"  expected %s (rel=%d): candidateRank=%d contextRank=%d\n",
				expected.Source,
				expected.Relevance,
				expected.CandidateRank,
				expected.ContextRank,
			)
		}
		if len(tc.RelevantLost) > 0 {
			fmt.Fprintf(&b, "  lost during ContextPack assembly: %s\n", strings.Join(tc.RelevantLost, ", "))
		}
		if len(tc.RedundantItems) > 0 {
			fmt.Fprintf(&b, "  redundancy: %s\n", strings.Join(tc.RedundantItems, ", "))
		}
	}
	if len(report.Failures) > 0 {
		fmt.Fprintln(&b, "\nFailures:")
		for _, failure := range report.Failures {
			caseLabel := ""
			if failure.CaseID != "" {
				caseLabel = " [" + failure.CaseID + "]"
			}
			fmt.Fprintf(&b, "  - %s%s: %s\n", failure.Kind, caseLabel, failure.Message)
		}
	}
	return b.String()
}

func buildRetrievalEvaluationCaseReport(
	tc RetrievalEvaluationCase,
	response *models.RetrievalResponse,
) (RetrievalEvaluationCaseReport, BenchmarkCaseReport, []RetrievalEvaluationFailure) {
	candidateRanking := make([]string, 0, len(response.Candidates))
	benchmarkHits := make([]BenchmarkHit, 0, len(response.Candidates))
	for _, candidate := range response.Candidates {
		candidateRanking = append(candidateRanking, candidate.ID)
		benchmarkHits = append(benchmarkHits, BenchmarkHit{
			Type:  candidate.Type,
			ID:    candidate.ID,
			Title: candidate.Title,
			Path:  candidate.Path,
			Score: candidate.Score,
		})
	}
	contextItems := make([]string, 0, len(response.ContextPack.Items))
	for _, item := range response.ContextPack.Items {
		contextItems = append(contextItems, item.ID)
	}

	expected := relevantQrelSources(tc.Qrels)
	legacyCase := BenchmarkCase{
		ID:       tc.ID,
		Category: tc.Category,
		Query:    tc.Query,
		Expected: expected,
		Notes:    tc.Notes,
	}
	legacy := EvaluateBenchmarkCase(legacyCase, benchmarkHits, 10)
	metrics := EvaluateRankingMetrics(tc.Qrels, candidateRanking, 10)
	expectedRanks := make([]EvaluationExpectedRank, 0, len(tc.Qrels))
	relevantLost := make([]string, 0)
	for _, qrel := range tc.Qrels {
		if qrel.Relevance <= 0 {
			continue
		}
		candidateRank := rankOf(candidateRanking, qrel.Source)
		contextRank := rankOf(contextItems, qrel.Source)
		expectedRanks = append(expectedRanks, EvaluationExpectedRank{
			Source:        qrel.Source,
			Relevance:     qrel.Relevance,
			CandidateRank: candidateRank,
			ContextRank:   contextRank,
		})
		if candidateRank > 0 && contextRank == 0 {
			relevantLost = append(relevantLost, qrel.Source)
		}
	}

	observedCitations := contextPackCitations(response.ContextPack.Items)
	failures := hardInvariantFailures(tc, response, observedCitations)
	contextBytes := 0
	for _, item := range response.ContextPack.Items {
		contextBytes += len([]byte(item.Content))
	}
	report := RetrievalEvaluationCaseReport{
		ID:                       tc.ID,
		Category:                 tc.Category,
		Query:                    tc.Query,
		Verdict:                  legacy.Verdict,
		Why:                      legacy.Why,
		Metrics:                  metrics,
		CandidateRecall:          recallForAllRelevant(tc.Qrels, candidateRanking),
		ContextPackRecall:        recallForAllRelevant(tc.Qrels, contextItems),
		CandidateRanking:         candidateRanking,
		ContextPackItems:         contextItems,
		ExpectedRanks:            expectedRanks,
		RelevantLost:             relevantLost,
		ExpectedCitations:        append([]string{}, tc.ExpectedCitations...),
		ObservedCitations:        observedCitations,
		ForbiddenSourcesObserved: observedForbiddenSources(tc, response),
		ContextBytes:             contextBytes,
		ContextTokens:            (contextBytes + 3) / 4,
		RedundantItems:           contextPackRedundancy(response.ContextPack.Items),
		Notes:                    tc.Notes,
	}
	return report, legacy, failures
}

func relevantQrelSources(qrels []EvaluationQrel) []string {
	relevant := make([]EvaluationQrel, 0, len(qrels))
	for _, qrel := range qrels {
		if qrel.Relevance > 0 {
			relevant = append(relevant, qrel)
		}
	}
	sort.SliceStable(relevant, func(i, j int) bool {
		if relevant[i].Relevance != relevant[j].Relevance {
			return relevant[i].Relevance > relevant[j].Relevance
		}
		return relevant[i].Source < relevant[j].Source
	})
	sources := make([]string, 0, len(relevant))
	for _, qrel := range relevant {
		sources = append(sources, qrel.Source)
	}
	return sources
}

func recallForAllRelevant(qrels []EvaluationQrel, observed []string) float64 {
	relevant := relevantQrelSources(qrels)
	if len(relevant) == 0 {
		return 0
	}
	found := 0
	for _, source := range relevant {
		if containsKey(observed, source) {
			found++
		}
	}
	return float64(found) / float64(len(relevant))
}

func contextPackCitations(items []models.ContextItem) []string {
	citations := make([]string, 0, len(items))
	for _, item := range items {
		citation := evaluationCitationKey(item.Citation)
		if citation != "" && !containsKey(citations, citation) {
			citations = append(citations, citation)
		}
	}
	return citations
}

func evaluationCitationKey(citation models.Citation) string {
	if citation.Type == "" {
		return ""
	}
	if citation.Path != "" {
		return citation.Type + ":" + citation.Path
	}
	if citation.ID != "" {
		return citation.Type + ":" + citation.ID
	}
	return ""
}

func hardInvariantFailures(
	tc RetrievalEvaluationCase,
	response *models.RetrievalResponse,
	observedCitations []string,
) []RetrievalEvaluationFailure {
	failures := make([]RetrievalEvaluationFailure, 0)
	for _, expected := range tc.ExpectedCitations {
		if !containsKey(observedCitations, expected) {
			failures = append(failures, RetrievalEvaluationFailure{
				Kind:    EvaluationOutcomeHardInvariant,
				CaseID:  tc.ID,
				Message: fmt.Sprintf("expected citation %q is absent from the final ContextPack", expected),
			})
		}
	}
	for _, source := range observedForbiddenSources(tc, response) {
		failures = append(failures, RetrievalEvaluationFailure{
			Kind:    EvaluationOutcomeHardInvariant,
			CaseID:  tc.ID,
			Message: fmt.Sprintf("forbidden or stale source %q was selected", source),
		})
	}
	return failures
}

func observedForbiddenSources(
	tc RetrievalEvaluationCase,
	response *models.RetrievalResponse,
) []string {
	observed := make(map[string]bool)
	for _, candidate := range response.Candidates {
		addEvaluationSourceKeys(observed, candidate.Type, candidate.ID, candidate.Path, candidate.Citation)
	}
	for _, item := range response.ContextPack.Items {
		addEvaluationSourceKeys(observed, item.Type, item.ID, item.Citation.Path, item.Citation)
	}
	found := make([]string, 0)
	for _, forbidden := range tc.ForbiddenSources {
		if observed[forbidden] {
			found = append(found, forbidden)
		}
	}
	return found
}

func addEvaluationSourceKeys(
	keys map[string]bool,
	sourceType string,
	id string,
	path string,
	citation models.Citation,
) {
	if id != "" {
		keys[id] = true
		if sourceType != "" {
			keys[sourceType+":"+id] = true
		}
	}
	if path != "" {
		keys[path] = true
		if sourceType != "" {
			keys[sourceType+":"+path] = true
		}
	}
	if citationKey := evaluationCitationKey(citation); citationKey != "" {
		keys[citationKey] = true
	}
}

func contextPackRedundancy(items []models.ContextItem) []string {
	seenIDs := make(map[string]bool, len(items))
	contentOwners := make(map[string]string, len(items))
	redundant := make([]string, 0)
	for _, item := range items {
		if seenIDs[item.ID] {
			redundant = append(redundant, "duplicate-id:"+item.ID)
		}
		seenIDs[item.ID] = true
		content := strings.TrimSpace(item.Content)
		if content == "" {
			continue
		}
		sum := sha256.Sum256([]byte(content))
		digest := hex.EncodeToString(sum[:8])
		if owner, ok := contentOwners[digest]; ok && owner != item.ID {
			redundant = append(redundant, "duplicate-content:"+owner+":"+item.ID)
		} else {
			contentOwners[digest] = item.ID
		}
	}
	sort.Strings(redundant)
	return redundant
}

func containsEvaluationFailureKind(failures []RetrievalEvaluationFailure, kind string) bool {
	for _, failure := range failures {
		if failure.Kind == kind {
			return true
		}
	}
	return false
}

func durationMillis(duration time.Duration) float64 {
	return float64(duration) / float64(time.Millisecond)
}
