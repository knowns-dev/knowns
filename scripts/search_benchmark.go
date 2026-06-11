package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	searchbench "github.com/howznguyen/knowns/internal/search"
)

func main() {
	limit := flag.Int("limit", 3, "number of top results to show per query")
	jsonOut := flag.Bool("json", false, "emit report as JSON")
	flag.Parse()

	cases, err := searchbench.LoadKeywordBenchmarkCases()
	if err != nil {
		fmt.Fprintf(os.Stderr, "load benchmark cases: %v\n", err)
		os.Exit(1)
	}

	reports := make([]searchbench.BenchmarkCaseReport, 0, len(cases))
	for _, tc := range cases {
		results, err := runSearch(tc.Query)
		if err != nil {
			fmt.Fprintf(os.Stderr, "benchmark %q failed: %v\n", tc.Query, err)
			os.Exit(1)
		}
		reports = append(reports, searchbench.EvaluateBenchmarkCase(tc, results, *limit))
	}

	if *jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(reports)
		return
	}

	printReport(reports, *limit)
}

func runSearch(query string) ([]searchbench.BenchmarkHit, error) {
	cmd := exec.Command("go", "run", "./cmd/knowns", "search", query, "--keyword", "--json")
	cmd.Dir = repoRoot()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}

	var results []searchbench.BenchmarkHit
	if err := json.Unmarshal(stdout.Bytes(), &results); err != nil {
		return nil, fmt.Errorf("decode search response: %w", err)
	}
	searchbench.SortBenchmarkHits(results)
	return results, nil
}

func printReport(reports []searchbench.BenchmarkCaseReport, limit int) {
	summary := searchbench.SummarizeBenchmarkReports(reports, limit)

	fmt.Printf("Keyword Search Benchmark\n")
	fmt.Printf("========================\n")
	fmt.Printf("Fixture: %s\n", searchbench.KeywordBenchmarkFixturePath)
	fmt.Printf("Total: %d  Pass: %d  Partial: %d  Fail: %d\n\n", summary.Total, summary.Pass, summary.Partial, summary.Fail)

	for _, report := range reports {
		fmt.Printf("Query: %s\n", report.Query)
		fmt.Printf("Verdict: %s\n", strings.ToUpper(report.Verdict))
		fmt.Printf("Expected: %s\n", strings.Join(report.Expected, ", "))
		fmt.Printf("Observed top %d: %s\n", limit, strings.Join(report.Observed, ", "))
		if report.Why != "" {
			fmt.Printf("Why: %s\n", report.Why)
		}
		if report.Notes != "" {
			fmt.Printf("Notes: %s\n", report.Notes)
		}
		fmt.Println()
	}
}

func repoRoot() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	if filepath.Base(wd) == "scripts" {
		return filepath.Dir(wd)
	}
	return wd
}
