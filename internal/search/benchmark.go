package search

import (
	"embed"
	"encoding/json"
	"fmt"
	"sort"
)

const KeywordBenchmarkFixturePath = "internal/search/testdata/keyword_benchmark_cases.json"

//go:embed testdata/keyword_benchmark_cases.json
var benchmarkFixtures embed.FS

type BenchmarkCase struct {
	ID             string   `json:"id"`
	Category       string   `json:"category"`
	Query          string   `json:"query"`
	Expected       []string `json:"expected"`
	FailureHints   []string `json:"failureHints"`
	Notes          string   `json:"notes,omitempty"`
	IgnoreDocPaths []string `json:"ignoreDocPaths,omitempty"`
}

type BenchmarkHit struct {
	Type  string  `json:"type"`
	ID    string  `json:"id"`
	Title string  `json:"title,omitempty"`
	Path  string  `json:"path,omitempty"`
	Score float64 `json:"score,omitempty"`
}

type BenchmarkCaseReport struct {
	ID           string         `json:"id"`
	Category     string         `json:"category"`
	Query        string         `json:"query"`
	Verdict      string         `json:"verdict"`
	Expected     []string       `json:"expected"`
	Observed     []string       `json:"observed"`
	Why          string         `json:"why"`
	Notes        string         `json:"notes,omitempty"`
	RankDeltas   []RankingDelta `json:"rankDeltas,omitempty"`
	FailureHints []string       `json:"failureHints,omitempty"`
}

type RankingDelta struct {
	Result        string `json:"result"`
	BaselineRank  int    `json:"baselineRank,omitempty"`
	CandidateRank int    `json:"candidateRank,omitempty"`
	Delta         int    `json:"delta"`
}

type BenchmarkSummary struct {
	Total    int `json:"total"`
	Pass     int `json:"pass"`
	Partial  int `json:"partial"`
	Fail     int `json:"fail"`
	Skipped  int `json:"skipped"`
	TopKUsed int `json:"topKUsed"`
}

func LoadKeywordBenchmarkCases() ([]BenchmarkCase, error) {
	data, err := benchmarkFixtures.ReadFile("testdata/keyword_benchmark_cases.json")
	if err != nil {
		return nil, fmt.Errorf("read keyword benchmark fixture: %w", err)
	}
	var cases []BenchmarkCase
	if err := json.Unmarshal(data, &cases); err != nil {
		return nil, fmt.Errorf("decode keyword benchmark fixture: %w", err)
	}
	for i, tc := range cases {
		if tc.ID == "" || tc.Category == "" || tc.Query == "" || len(tc.Expected) == 0 {
			return nil, fmt.Errorf("invalid keyword benchmark case at index %d", i)
		}
	}
	return cases, nil
}

func FilterBenchmarkHits(results []BenchmarkHit, ignoreDocPaths []string) []BenchmarkHit {
	ignore := make(map[string]bool, len(ignoreDocPaths))
	for _, path := range ignoreDocPaths {
		ignore[path] = true
	}
	filtered := make([]BenchmarkHit, 0, len(results))
	for _, result := range results {
		if result.Type == "doc" && ignore[result.ID] {
			continue
		}
		filtered = append(filtered, result)
	}
	return filtered
}

func EvaluateBenchmarkCase(tc BenchmarkCase, results []BenchmarkHit, limit int) BenchmarkCaseReport {
	filtered := FilterBenchmarkHits(results, tc.IgnoreDocPaths)
	observed := TopBenchmarkHitKeys(filtered, limit)
	verdict, why := classifyBenchmarkCase(tc, filtered)
	return BenchmarkCaseReport{
		ID:           tc.ID,
		Category:     tc.Category,
		Query:        tc.Query,
		Verdict:      verdict,
		Expected:     append([]string{}, tc.Expected...),
		Observed:     observed,
		Why:          why,
		Notes:        tc.Notes,
		FailureHints: append([]string{}, tc.FailureHints...),
	}
}

func CompareBenchmarkCase(tc BenchmarkCase, baseline []BenchmarkHit, candidate []BenchmarkHit, limit int) BenchmarkCaseReport {
	report := EvaluateBenchmarkCase(tc, candidate, limit)
	report.RankDeltas = RankingDeltas(
		TopBenchmarkHitKeys(FilterBenchmarkHits(baseline, tc.IgnoreDocPaths), 0),
		TopBenchmarkHitKeys(FilterBenchmarkHits(candidate, tc.IgnoreDocPaths), 0),
		tc.Expected,
	)
	return report
}

func TopBenchmarkHitKeys(results []BenchmarkHit, limit int) []string {
	if limit <= 0 || limit > len(results) {
		limit = len(results)
	}
	keys := make([]string, 0, limit)
	for _, result := range results[:limit] {
		keys = append(keys, BenchmarkHitKey(result))
	}
	return keys
}

func BenchmarkHitKey(r BenchmarkHit) string {
	return r.ID
}

func RankingDeltas(baseline []string, candidate []string, expected []string) []RankingDelta {
	watch := append([]string{}, expected...)
	for _, key := range candidate {
		if !containsKey(watch, key) {
			watch = append(watch, key)
		}
		if len(watch) >= len(expected)+3 {
			break
		}
	}

	deltas := make([]RankingDelta, 0, len(watch))
	for _, key := range watch {
		baseRank := rankOf(baseline, key)
		candidateRank := rankOf(candidate, key)
		if baseRank == 0 && candidateRank == 0 {
			continue
		}
		deltas = append(deltas, RankingDelta{
			Result:        key,
			BaselineRank:  baseRank,
			CandidateRank: candidateRank,
			Delta:         rankDelta(baseRank, candidateRank),
		})
	}
	return deltas
}

func SummarizeBenchmarkReports(reports []BenchmarkCaseReport, limit int) BenchmarkSummary {
	s := BenchmarkSummary{Total: len(reports), TopKUsed: limit}
	for _, report := range reports {
		switch report.Verdict {
		case "pass":
			s.Pass++
		case "partial":
			s.Partial++
		case "skip":
			s.Skipped++
		default:
			s.Fail++
		}
	}
	return s
}

func SortBenchmarkHits(results []BenchmarkHit) {
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].Score != results[j].Score {
			return results[i].Score > results[j].Score
		}
		return BenchmarkHitKey(results[i]) < BenchmarkHitKey(results[j])
	})
}

func classifyBenchmarkCase(tc BenchmarkCase, results []BenchmarkHit) (string, string) {
	if len(results) == 0 {
		return "fail", "no results"
	}

	maxCheck := minInt(3, len(results))
	matchedTop3 := 0
	for _, expected := range tc.Expected {
		for _, result := range results[:maxCheck] {
			if BenchmarkHitKey(result) == expected {
				matchedTop3++
				break
			}
		}
	}

	if matchedTop3 == len(tc.Expected) || (len(tc.Expected) > 0 && BenchmarkHitKey(results[0]) == tc.Expected[0]) {
		return "pass", "expected result is in top results"
	}

	for _, expected := range tc.Expected {
		for _, result := range results {
			if BenchmarkHitKey(result) == expected {
				return "partial", "expected result found but ranked below top 3"
			}
		}
	}

	if len(tc.FailureHints) > 0 {
		return "fail", tc.FailureHints[0]
	}
	return "fail", "expected result missing"
}

func rankOf(keys []string, key string) int {
	for i, candidate := range keys {
		if candidate == key {
			return i + 1
		}
	}
	return 0
}

func rankDelta(baselineRank, candidateRank int) int {
	if baselineRank == 0 && candidateRank == 0 {
		return 0
	}
	if baselineRank == 0 {
		return -candidateRank
	}
	if candidateRank == 0 {
		return baselineRank
	}
	return candidateRank - baselineRank
}

func containsKey(keys []string, key string) bool {
	for _, candidate := range keys {
		if candidate == key {
			return true
		}
	}
	return false
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
