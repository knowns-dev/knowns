package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
	searchbench "github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

type modeReport struct {
	Mode    string                            `json:"mode"`
	Cases   []searchbench.BenchmarkCaseReport `json:"cases"`
	Summary searchbench.BenchmarkSummary      `json:"summary"`
	Skipped bool                              `json:"skipped,omitempty"`
	SkipWhy string                            `json:"skipWhy,omitempty"`
}

func main() {
	limit := flag.Int("limit", 3, "number of top results to show per query")
	jsonOut := flag.Bool("json", false, "emit report as JSON")
	baselineMode := flag.String("baseline", "heuristic", "baseline internal lexical backend")
	candidateMode := flag.String("candidate", "bm25", "candidate internal lexical backend")
	flag.Parse()

	cases, err := searchbench.LoadKeywordBenchmarkCases()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load benchmark cases: %v\n", err)
		os.Exit(1)
	}

	reports := []modeReport{
		runMode(*baselineMode, cases, *limit, nil),
		runCandidate(*candidateMode, *baselineMode, cases, *limit),
	}

	if *jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(reports)
		return
	}

	printReports(reports, *baselineMode, *candidateMode, *limit)
}

func runCandidate(mode, baselineMode string, cases []searchbench.BenchmarkCase, limit int) modeReport {
	if !modeAvailable(mode) {
		return runMode(mode, cases, limit, nil)
	}
	baseline := collectResults(baselineMode, cases)
	return runMode(mode, cases, limit, baseline)
}

func runMode(mode string, cases []searchbench.BenchmarkCase, limit int, baseline map[string][]searchbench.BenchmarkHit) modeReport {
	report := modeReport{Mode: mode}
	if !modeAvailable(mode) {
		report.Skipped = true
		report.SkipWhy = "internal lexical backend not implemented yet"
		report.Summary = searchbench.BenchmarkSummary{Total: len(cases), Skipped: len(cases), TopKUsed: limit}
		return report
	}

	for _, tc := range cases {
		results, err := runSearch(mode, tc.Query)
		if err != nil {
			report.Cases = append(report.Cases, searchbench.BenchmarkCaseReport{
				ID:           tc.ID,
				Category:     tc.Category,
				Query:        tc.Query,
				Verdict:      "fail",
				Expected:     tc.Expected,
				Why:          err.Error(),
				Notes:        tc.Notes,
				FailureHints: tc.FailureHints,
			})
			continue
		}
		if baseline != nil {
			report.Cases = append(report.Cases, searchbench.CompareBenchmarkCase(tc, baseline[tc.ID], results, limit))
			continue
		}
		report.Cases = append(report.Cases, searchbench.EvaluateBenchmarkCase(tc, results, limit))
	}

	report.Summary = searchbench.SummarizeBenchmarkReports(report.Cases, limit)
	return report
}

func collectResults(mode string, cases []searchbench.BenchmarkCase) map[string][]searchbench.BenchmarkHit {
	results := make(map[string][]searchbench.BenchmarkHit, len(cases))
	if !modeAvailable(mode) {
		return results
	}
	for _, tc := range cases {
		hits, err := runSearch(mode, tc.Query)
		if err != nil {
			continue
		}
		results[tc.ID] = hits
	}
	return results
}

func runSearch(mode, query string) ([]searchbench.BenchmarkHit, error) {
	store, err := benchmarkStore()
	if err != nil {
		return nil, err
	}
	results, err := searchbench.SearchWithLexicalBackend(store, mode, query, searchbench.SearchOptions{
		Query: query,
		Mode:  string(searchbench.ModeKeyword),
		Type:  "all",
		Limit: 50,
	})
	if err != nil {
		return nil, err
	}
	return benchmarkHits(results), nil
}

func printReports(reports []modeReport, baseline, candidate string, limit int) {
	fmt.Println("Lexical Search Shadow Comparison")
	fmt.Println("================================")
	fmt.Printf("Fixture: %s\n", searchbench.KeywordBenchmarkFixturePath)
	fmt.Printf("Baseline: %s  Candidate: %s\n", strings.ToUpper(baseline), strings.ToUpper(candidate))
	for _, report := range reports {
		fmt.Printf("\nMode: %s\n", strings.ToUpper(report.Mode))
		if report.Skipped {
			fmt.Printf("Skipped: %s\n", report.SkipWhy)
			continue
		}
		fmt.Printf("Total: %d  Pass: %d  Partial: %d  Fail: %d\n", report.Summary.Total, report.Summary.Pass, report.Summary.Partial, report.Summary.Fail)
		for _, c := range report.Cases {
			fmt.Printf("- %-36s %-7s top %d: %s\n", c.Query, strings.ToUpper(c.Verdict), limit, strings.Join(c.Observed, ", "))
			if len(c.RankDeltas) > 0 {
				fmt.Printf("  deltas: %s\n", formatDeltas(c.RankDeltas))
			}
		}
	}
}

func formatDeltas(deltas []searchbench.RankingDelta) string {
	parts := make([]string, 0, len(deltas))
	for _, delta := range deltas {
		parts = append(parts, fmt.Sprintf("%s %d->%d (%+d)", delta.Result, delta.BaselineRank, delta.CandidateRank, delta.Delta))
	}
	return strings.Join(parts, ", ")
}

func modeAvailable(mode string) bool {
	switch mode {
	case "heuristic", "keyword", "bm25":
		return true
	default:
		return false
	}
}

func repoRoot() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	if filepath.Base(wd) == "search_compare" {
		return filepath.Dir(filepath.Dir(wd))
	}
	return wd
}

func benchmarkStore() (*storage.Store, error) {
	root, err := storage.FindProjectRoot(repoRoot())
	if err != nil {
		return nil, err
	}
	return storage.NewStore(root), nil
}

func benchmarkHits(results []models.SearchResult) []searchbench.BenchmarkHit {
	hits := make([]searchbench.BenchmarkHit, 0, len(results))
	for _, result := range results {
		hits = append(hits, searchbench.BenchmarkHit{
			Type:  result.Type,
			ID:    result.ID,
			Title: result.Title,
			Path:  result.Path,
			Score: result.Score,
		})
	}
	searchbench.SortBenchmarkHits(hits)
	return hits
}
