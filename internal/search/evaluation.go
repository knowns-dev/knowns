package search

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/storage"
)

const (
	EvaluationFixtureSchemaVersion  = 1
	EvaluationBaselineSchemaVersion = 1
	EvaluationReportSchemaVersion   = 1

	CanonicalEvaluationFixturePath          = "internal/search/testdata/retrieval_evaluation_cases.json"
	CanonicalEvaluationBaselinePath         = "internal/search/testdata/retrieval_evaluation_baseline.json"
	CanonicalSemanticEvaluationBaselinePath = "internal/search/testdata/retrieval_evaluation_semantic_baseline.json"
	CanonicalHybridEvaluationBaselinePath   = "internal/search/testdata/retrieval_evaluation_hybrid_baseline.json"
)

// PinnedSemanticRuntimeID is the runtime the canonical semantic and hybrid
// baselines are generated against, and the value CI passes as --runtime-id.
// It is derived from the D2 default rather than written out, so changing the
// default model cannot leave this pin silently naming the old one — the
// baselines would then be regenerated against a runtime nobody pinned.
// The previous pin, local/gte-small@384, named the local ONNX runtime that
// spec ollama-only-embedding FR-2 removed.
func PinnedSemanticRuntimeID() string {
	for _, m := range storage.RecommendedModels() {
		if m.Default {
			return fmt.Sprintf("ollama/%s@%d", m.ID, m.Dimensions)
		}
	}
	// D2Models always carries exactly one default; a build without one is a
	// programming error, not a runtime condition to paper over.
	panic("search: no default model in the D2 registry")
}

var (
	//go:embed testdata/retrieval_evaluation_cases.json testdata/retrieval_evaluation_baseline.json
	evaluationFixtures embed.FS

	evaluationCaseIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	supportedEvaluationModes = map[string]bool{
		string(ModeKeyword):  true,
		string(ModeSemantic): true,
		string(ModeHybrid):   true,
	}
)

// RetrievalEvaluationFixture is the versioned collection of retrieval cases.
type RetrievalEvaluationFixture struct {
	SchemaVersion int                       `json:"schemaVersion"`
	Cases         []RetrievalEvaluationCase `json:"cases"`
}

// RetrievalEvaluationCase describes one ranked retrieval and ContextPack query.
type RetrievalEvaluationCase struct {
	ID                string           `json:"id"`
	Category          string           `json:"category"`
	Query             string           `json:"query"`
	Qrels             []EvaluationQrel `json:"qrels"`
	ExpectedCitations []string         `json:"expectedCitations,omitempty"`
	ForbiddenSources  []string         `json:"forbiddenSources,omitempty"`
	Modes             []string         `json:"modes"`
	Limit             int              `json:"limit,omitempty"`
	SourceTypes       []string         `json:"sourceTypes,omitempty"`
	ExpandReferences  bool             `json:"expandReferences,omitempty"`
	IncludeHistorical bool             `json:"includeHistorical,omitempty"`
	Notes             string           `json:"notes,omitempty"`
}

// EvaluationQrel assigns graded relevance from 0 (not relevant) to 3 (ideal).
type EvaluationQrel struct {
	Source    string `json:"source"`
	Relevance int    `json:"relevance"`
}

// EvaluationMetrics contains the ranked metrics used by the regression gate.
type EvaluationMetrics struct {
	NDCGAt10   float64 `json:"ndcgAt10"`
	MRRAt10    float64 `json:"mrrAt10"`
	RecallAt5  float64 `json:"recallAt5"`
	RecallAt10 float64 `json:"recallAt10"`
	RecallAt20 float64 `json:"recallAt20"`
	SuccessAtK float64 `json:"successAtK"`
}

// EvaluationLatencySummary is report-only timing information.
type EvaluationLatencySummary struct {
	P50Millis float64 `json:"p50Millis"`
	P95Millis float64 `json:"p95Millis"`
}

// RetrievalEvaluationBaseline is the committed comparison point for a mode.
type RetrievalEvaluationBaseline struct {
	SchemaVersion        int                      `json:"schemaVersion"`
	FixtureSchemaVersion int                      `json:"fixtureSchemaVersion"`
	FixtureDigest        string                   `json:"fixtureDigest"`
	Mode                 string                   `json:"mode"`
	RuntimeIdentity      string                   `json:"runtimeIdentity"`
	Reason               string                   `json:"reason"`
	Tolerances           map[string]float64       `json:"tolerances"`
	Aggregate            EvaluationMetrics        `json:"aggregate"`
	Cases                []EvaluationBaselineCase `json:"cases"`
}

// EvaluationBaselineCase preserves reviewable per-case metrics and rankings.
type EvaluationBaselineCase struct {
	ID               string            `json:"id"`
	Metrics          EvaluationMetrics `json:"metrics"`
	CandidateRanking []string          `json:"candidateRanking"`
	ContextPackItems []string          `json:"contextPackItems"`
}

// LoadCanonicalEvaluationFixture loads the embedded canonical fixture.
func LoadCanonicalEvaluationFixture() (*RetrievalEvaluationFixture, error) {
	data, err := evaluationFixtures.ReadFile("testdata/retrieval_evaluation_cases.json")
	if err != nil {
		return nil, fmt.Errorf("read canonical evaluation fixture: %w", err)
	}
	return DecodeEvaluationFixture(data)
}

// LoadCanonicalEvaluationBaseline loads the embedded canonical keyword baseline.
func LoadCanonicalEvaluationBaseline() (*RetrievalEvaluationBaseline, error) {
	data, err := evaluationFixtures.ReadFile("testdata/retrieval_evaluation_baseline.json")
	if err != nil {
		return nil, fmt.Errorf("read canonical evaluation baseline: %w", err)
	}
	return DecodeEvaluationBaseline(data)
}

// LoadEvaluationFixtureFile reads and validates a project-local fixture.
func LoadEvaluationFixtureFile(path string) (*RetrievalEvaluationFixture, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read evaluation fixture %q: %w", path, err)
	}
	return DecodeEvaluationFixture(data)
}

// LoadEvaluationBaselineFile reads and decodes an external baseline.
func LoadEvaluationBaselineFile(path string) (*RetrievalEvaluationBaseline, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read evaluation baseline %q: %w", path, err)
	}
	return DecodeEvaluationBaseline(data)
}

// DecodeEvaluationFixture decodes and validates fixture data before retrieval.
func DecodeEvaluationFixture(data []byte) (*RetrievalEvaluationFixture, error) {
	var fixture RetrievalEvaluationFixture
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		return nil, fmt.Errorf("decode evaluation fixture: %w", err)
	}
	if err := ensureEvaluationJSONEOF(decoder, "fixture"); err != nil {
		return nil, err
	}
	if err := ValidateEvaluationFixture(&fixture); err != nil {
		return nil, err
	}
	return &fixture, nil
}

// DecodeEvaluationBaseline decodes baseline data. Fixture compatibility is
// checked separately so callers can report missing cases before retrieval.
func DecodeEvaluationBaseline(data []byte) (*RetrievalEvaluationBaseline, error) {
	var baseline RetrievalEvaluationBaseline
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&baseline); err != nil {
		return nil, fmt.Errorf("decode evaluation baseline: %w", err)
	}
	if err := ensureEvaluationJSONEOF(decoder, "baseline"); err != nil {
		return nil, err
	}
	if baseline.SchemaVersion != EvaluationBaselineSchemaVersion {
		return nil, fmt.Errorf(
			"baseline.schemaVersion: unsupported value %d (expected %d)",
			baseline.SchemaVersion,
			EvaluationBaselineSchemaVersion,
		)
	}
	return &baseline, nil
}

// ValidateEvaluationFixture validates all case fields before any retrieval runs.
func ValidateEvaluationFixture(fixture *RetrievalEvaluationFixture) error {
	if fixture == nil {
		return fmt.Errorf("fixture: required")
	}
	if fixture.SchemaVersion != EvaluationFixtureSchemaVersion {
		return fmt.Errorf(
			"fixture.schemaVersion: unsupported value %d (expected %d)",
			fixture.SchemaVersion,
			EvaluationFixtureSchemaVersion,
		)
	}
	if len(fixture.Cases) == 0 {
		return fmt.Errorf("fixture.cases: at least one case is required")
	}

	caseIDs := make(map[string]bool, len(fixture.Cases))
	for i, tc := range fixture.Cases {
		field := fmt.Sprintf("cases[%d]", i)
		if tc.ID == "" {
			return fmt.Errorf("%s.id: required", field)
		}
		if !evaluationCaseIDPattern.MatchString(tc.ID) {
			return fmt.Errorf("%s.id: %q is not a stable case ID", field, tc.ID)
		}
		if caseIDs[tc.ID] {
			return fmt.Errorf("%s.id: duplicate case ID %q", field, tc.ID)
		}
		caseIDs[tc.ID] = true
		if strings.TrimSpace(tc.Category) == "" {
			return fmt.Errorf("case %q category: required", tc.ID)
		}
		if strings.TrimSpace(tc.Query) == "" {
			return fmt.Errorf("case %q query: required", tc.ID)
		}
		if tc.Limit < 0 {
			return fmt.Errorf("case %q limit: must be non-negative", tc.ID)
		}
		if err := validateCaseModes(tc); err != nil {
			return err
		}
		if err := validateCaseQrels(tc); err != nil {
			return err
		}
		if err := validateUniqueStrings(tc.ID, "expectedCitations", tc.ExpectedCitations); err != nil {
			return err
		}
		if err := validateUniqueStrings(tc.ID, "forbiddenSources", tc.ForbiddenSources); err != nil {
			return err
		}
		for _, citation := range tc.ExpectedCitations {
			if containsKey(tc.ForbiddenSources, citation) {
				return fmt.Errorf(
					"case %q expectedCitations: %q is also forbidden",
					tc.ID,
					citation,
				)
			}
		}
	}
	return nil
}

// ValidateEvaluationBaseline checks fixture/baseline compatibility before retrieval.
func ValidateEvaluationBaseline(
	fixture *RetrievalEvaluationFixture,
	baseline *RetrievalEvaluationBaseline,
	mode string,
	runtimeIdentity string,
) error {
	if err := ValidateEvaluationFixture(fixture); err != nil {
		return err
	}
	if baseline == nil {
		return fmt.Errorf("baseline: required; run an explicit baseline update with a review reason")
	}
	if baseline.SchemaVersion != EvaluationBaselineSchemaVersion {
		return fmt.Errorf(
			"baseline.schemaVersion: unsupported value %d (expected %d)",
			baseline.SchemaVersion,
			EvaluationBaselineSchemaVersion,
		)
	}
	if baseline.FixtureSchemaVersion != fixture.SchemaVersion {
		return fmt.Errorf(
			"baseline.fixtureSchemaVersion: got %d, fixture uses %d",
			baseline.FixtureSchemaVersion,
			fixture.SchemaVersion,
		)
	}
	if !supportedEvaluationModes[mode] {
		return fmt.Errorf("mode: unsupported evaluation mode %q", mode)
	}
	if baseline.Mode != mode {
		return fmt.Errorf("baseline.mode: got %q, expected %q", baseline.Mode, mode)
	}
	if strings.TrimSpace(baseline.Reason) == "" {
		return fmt.Errorf("baseline.reason: required")
	}
	if strings.TrimSpace(runtimeIdentity) == "" {
		if mode == string(ModeKeyword) {
			runtimeIdentity = "keyword"
		} else {
			return fmt.Errorf("runtimeIdentity: required for %s evaluation", mode)
		}
	}
	if baseline.RuntimeIdentity != runtimeIdentity {
		return fmt.Errorf(
			"baseline.runtimeIdentity: got %q, pinned runtime is %q",
			baseline.RuntimeIdentity,
			runtimeIdentity,
		)
	}
	digest, err := EvaluationFixtureDigest(fixture)
	if err != nil {
		return err
	}
	if baseline.FixtureDigest != digest {
		return fmt.Errorf(
			"baseline.fixtureDigest: fixture changed; run an explicit baseline update with a review reason",
		)
	}
	if len(baseline.Tolerances) == 0 {
		return fmt.Errorf("baseline.tolerances: at least one gated metric is required")
	}
	for name, tolerance := range baseline.Tolerances {
		if _, ok := baseline.Aggregate.Value(name); !ok {
			return fmt.Errorf("baseline.tolerances.%s: unsupported metric", name)
		}
		if tolerance < 0 || tolerance > 1 {
			return fmt.Errorf("baseline.tolerances.%s: must be between 0 and 1", name)
		}
	}

	baselineCases := make(map[string]bool, len(baseline.Cases))
	for i, tc := range baseline.Cases {
		if tc.ID == "" {
			return fmt.Errorf("baseline.cases[%d].id: required", i)
		}
		if baselineCases[tc.ID] {
			return fmt.Errorf("baseline.cases[%d].id: duplicate case ID %q", i, tc.ID)
		}
		baselineCases[tc.ID] = true
	}
	for _, tc := range fixture.Cases {
		if !baselineCases[tc.ID] {
			return fmt.Errorf(
				"baseline.cases: canonical case %q has no baseline; run an explicit baseline update with a review reason",
				tc.ID,
			)
		}
	}
	for id := range baselineCases {
		if !fixtureHasCase(fixture, id) {
			return fmt.Errorf("baseline.cases: case %q is not present in the fixture", id)
		}
	}
	return nil
}

// EvaluationFixtureDigest returns a stable digest for reviewable fixture changes.
func EvaluationFixtureDigest(fixture *RetrievalEvaluationFixture) (string, error) {
	if err := ValidateEvaluationFixture(fixture); err != nil {
		return "", err
	}
	data, err := json.Marshal(fixture)
	if err != nil {
		return "", fmt.Errorf("encode evaluation fixture digest: %w", err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// EvaluateRankingMetrics calculates the deterministic ranked quality metrics.
func EvaluateRankingMetrics(qrels []EvaluationQrel, observed []string, successK int) EvaluationMetrics {
	if successK <= 0 {
		successK = 10
	}
	relevance := make(map[string]int, len(qrels))
	relevantCount := 0
	ideal := make([]int, 0, len(qrels))
	for _, qrel := range qrels {
		relevance[qrel.Source] = qrel.Relevance
		if qrel.Relevance > 0 {
			relevantCount++
			ideal = append(ideal, qrel.Relevance)
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(ideal)))

	seen := make(map[string]bool, len(observed))
	relevantAt := func(limit int) int {
		if limit > len(observed) {
			limit = len(observed)
		}
		count := 0
		for _, source := range observed[:limit] {
			if seen[source] {
				continue
			}
			seen[source] = true
			if relevance[source] > 0 {
				count++
			}
		}
		clear(seen)
		return count
	}
	recall := func(limit int) float64 {
		if relevantCount == 0 {
			return 0
		}
		return float64(relevantAt(limit)) / float64(relevantCount)
	}

	dcg := 0.0
	firstRelevantRank := 0
	limit10 := minInt(10, len(observed))
	for i, source := range observed[:limit10] {
		rel := relevance[source]
		if rel <= 0 {
			continue
		}
		dcg += (math.Pow(2, float64(rel)) - 1) / math.Log2(float64(i+2))
		if firstRelevantRank == 0 {
			firstRelevantRank = i + 1
		}
	}
	idcg := 0.0
	for i, rel := range ideal[:minInt(10, len(ideal))] {
		idcg += (math.Pow(2, float64(rel)) - 1) / math.Log2(float64(i+2))
	}
	ndcg := 0.0
	if idcg > 0 {
		ndcg = dcg / idcg
	}
	mrr := 0.0
	if firstRelevantRank > 0 {
		mrr = 1 / float64(firstRelevantRank)
	}
	success := 0.0
	if relevantAt(successK) > 0 {
		success = 1
	}
	return EvaluationMetrics{
		NDCGAt10:   ndcg,
		MRRAt10:    mrr,
		RecallAt5:  recall(5),
		RecallAt10: recall(10),
		RecallAt20: recall(20),
		SuccessAtK: success,
	}
}

// AggregateEvaluationMetrics averages case metrics without weighting categories.
func AggregateEvaluationMetrics(metrics []EvaluationMetrics) EvaluationMetrics {
	if len(metrics) == 0 {
		return EvaluationMetrics{}
	}
	var aggregate EvaluationMetrics
	for _, metric := range metrics {
		aggregate.NDCGAt10 += metric.NDCGAt10
		aggregate.MRRAt10 += metric.MRRAt10
		aggregate.RecallAt5 += metric.RecallAt5
		aggregate.RecallAt10 += metric.RecallAt10
		aggregate.RecallAt20 += metric.RecallAt20
		aggregate.SuccessAtK += metric.SuccessAtK
	}
	divisor := float64(len(metrics))
	aggregate.NDCGAt10 /= divisor
	aggregate.MRRAt10 /= divisor
	aggregate.RecallAt5 /= divisor
	aggregate.RecallAt10 /= divisor
	aggregate.RecallAt20 /= divisor
	aggregate.SuccessAtK /= divisor
	return aggregate
}

// SummarizeEvaluationLatency calculates nearest-rank p50 and p95 durations.
func SummarizeEvaluationLatency(samples []time.Duration) EvaluationLatencySummary {
	if len(samples) == 0 {
		return EvaluationLatencySummary{}
	}
	sorted := append([]time.Duration{}, samples...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	percentile := func(p float64) float64 {
		index := int(math.Ceil(float64(len(sorted))*p)) - 1
		if index < 0 {
			index = 0
		}
		return float64(sorted[index]) / float64(time.Millisecond)
	}
	return EvaluationLatencySummary{
		P50Millis: percentile(0.50),
		P95Millis: percentile(0.95),
	}
}

// Value returns a named metric for tolerance comparisons.
func (m EvaluationMetrics) Value(name string) (float64, bool) {
	switch name {
	case "ndcgAt10":
		return m.NDCGAt10, true
	case "mrrAt10":
		return m.MRRAt10, true
	case "recallAt5":
		return m.RecallAt5, true
	case "recallAt10":
		return m.RecallAt10, true
	case "recallAt20":
		return m.RecallAt20, true
	case "successAtK":
		return m.SuccessAtK, true
	default:
		return 0, false
	}
}

func validateCaseModes(tc RetrievalEvaluationCase) error {
	if len(tc.Modes) == 0 {
		return fmt.Errorf("case %q modes: at least one mode is required", tc.ID)
	}
	seen := make(map[string]bool, len(tc.Modes))
	for i, mode := range tc.Modes {
		if !supportedEvaluationModes[mode] {
			return fmt.Errorf("case %q modes[%d]: unsupported mode %q", tc.ID, i, mode)
		}
		if seen[mode] {
			return fmt.Errorf("case %q modes[%d]: duplicate mode %q", tc.ID, i, mode)
		}
		seen[mode] = true
	}
	return nil
}

func validateCaseQrels(tc RetrievalEvaluationCase) error {
	if len(tc.Qrels) == 0 {
		return fmt.Errorf("case %q qrels: at least one qrel is required", tc.ID)
	}
	seen := make(map[string]bool, len(tc.Qrels))
	relevant := 0
	for i, qrel := range tc.Qrels {
		if strings.TrimSpace(qrel.Source) == "" {
			return fmt.Errorf("case %q qrels[%d].source: required", tc.ID, i)
		}
		if seen[qrel.Source] {
			return fmt.Errorf("case %q qrels[%d].source: duplicate source %q", tc.ID, i, qrel.Source)
		}
		seen[qrel.Source] = true
		if qrel.Relevance < 0 || qrel.Relevance > 3 {
			return fmt.Errorf(
				"case %q qrels[%d].relevance: got %d, expected 0..3",
				tc.ID,
				i,
				qrel.Relevance,
			)
		}
		if qrel.Relevance > 0 {
			relevant++
		}
	}
	if relevant == 0 {
		return fmt.Errorf("case %q qrels: at least one source must have relevance > 0", tc.ID)
	}
	return nil
}

func validateUniqueStrings(caseID, field string, values []string) error {
	seen := make(map[string]bool, len(values))
	for i, value := range values {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("case %q %s[%d]: required", caseID, field, i)
		}
		if seen[value] {
			return fmt.Errorf("case %q %s[%d]: duplicate value %q", caseID, field, i, value)
		}
		seen[value] = true
	}
	return nil
}

func fixtureHasCase(fixture *RetrievalEvaluationFixture, id string) bool {
	for _, tc := range fixture.Cases {
		if tc.ID == id {
			return true
		}
	}
	return false
}

func ensureEvaluationJSONEOF(decoder *json.Decoder, entity string) error {
	var trailing any
	err := decoder.Decode(&trailing)
	if err == io.EOF {
		return nil
	}
	if err != nil {
		return fmt.Errorf("decode evaluation %s trailing data: %w", entity, err)
	}
	return fmt.Errorf("decode evaluation %s: multiple JSON values are not allowed", entity)
}
