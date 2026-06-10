package search

import (
	"strings"
	"testing"
)

func TestLoadKeywordBenchmarkCases(t *testing.T) {
	cases, err := LoadKeywordBenchmarkCases()
	if err != nil {
		t.Fatalf("LoadKeywordBenchmarkCases: %v", err)
	}
	if len(cases) < 15 {
		t.Fatalf("case count = %d, want at least 15", len(cases))
	}

	categories := map[string]bool{}
	for _, tc := range cases {
		categories[tc.Category] = true
		if !containsKey(tc.IgnoreDocPaths, "research/keyword-search-benchmark-matrix") {
			t.Fatalf("case %s does not exclude self-polluting benchmark doc", tc.ID)
		}
	}
	for _, category := range []string{"exact_lookup", "common_terms", "multi_word_intent", "source_balance", "token_boundary"} {
		if !categories[category] {
			t.Fatalf("missing benchmark category %q", category)
		}
	}
}

func TestKeywordBenchmarkFixtureIsIsolatedFromSearchDocs(t *testing.T) {
	if strings.Contains(KeywordBenchmarkFixturePath, ".knowns/docs") {
		t.Fatalf("fixture path %q must stay outside searchable docs", KeywordBenchmarkFixturePath)
	}
	if !strings.HasPrefix(KeywordBenchmarkFixturePath, "internal/search/testdata/") {
		t.Fatalf("fixture path %q should live in Go testdata, outside normal Knowns docs", KeywordBenchmarkFixturePath)
	}
}

func TestEvaluateBenchmarkCaseClassifiesPassPartialFail(t *testing.T) {
	tc := BenchmarkCase{
		ID:           "intent",
		Category:     "multi_word_intent",
		Query:        "search quality improvements",
		Expected:     []string{"specs/semantic-search-quality-improvements"},
		FailureHints: []string{"multi-word weakness"},
	}

	pass := EvaluateBenchmarkCase(tc, []BenchmarkHit{{Type: "doc", ID: "specs/semantic-search-quality-improvements"}}, 3)
	if pass.Verdict != "pass" {
		t.Fatalf("pass verdict = %q", pass.Verdict)
	}

	partial := EvaluateBenchmarkCase(tc, []BenchmarkHit{
		{Type: "doc", ID: "a"},
		{Type: "doc", ID: "b"},
		{Type: "doc", ID: "c"},
		{Type: "doc", ID: "specs/semantic-search-quality-improvements"},
	}, 3)
	if partial.Verdict != "partial" {
		t.Fatalf("partial verdict = %q", partial.Verdict)
	}

	fail := EvaluateBenchmarkCase(tc, []BenchmarkHit{{Type: "doc", ID: "a"}}, 3)
	if fail.Verdict != "fail" || fail.Why != "multi-word weakness" {
		t.Fatalf("fail = (%q, %q), want fail with hint", fail.Verdict, fail.Why)
	}
}

func TestCompareBenchmarkCaseReportsRankingDeltas(t *testing.T) {
	tc := BenchmarkCase{
		ID:       "exact",
		Category: "exact_lookup",
		Query:    "semantic search",
		Expected: []string{"specs/semantic-search"},
	}
	report := CompareBenchmarkCase(tc,
		[]BenchmarkHit{{ID: "a"}, {ID: "specs/semantic-search"}, {ID: "b"}},
		[]BenchmarkHit{{ID: "specs/semantic-search"}, {ID: "a"}, {ID: "b"}},
		3,
	)
	if report.Verdict != "pass" {
		t.Fatalf("verdict = %q, want pass", report.Verdict)
	}
	if len(report.RankDeltas) == 0 {
		t.Fatal("expected ranking deltas")
	}
	if report.RankDeltas[0].Result != "specs/semantic-search" || report.RankDeltas[0].Delta != -1 {
		t.Fatalf("first delta = %+v, want expected result improved by one rank", report.RankDeltas[0])
	}
}

func TestFilterBenchmarkHitsRemovesSelfPollutingBenchmarkDoc(t *testing.T) {
	results := []BenchmarkHit{
		{Type: "doc", ID: "research/keyword-search-benchmark-matrix"},
		{Type: "doc", ID: "specs/semantic-search"},
		{Type: "task", ID: "phxsq7"},
	}
	filtered := FilterBenchmarkHits(results, []string{"research/keyword-search-benchmark-matrix"})
	keys := TopBenchmarkHitKeys(filtered, 0)
	if len(keys) != 2 || containsKey(keys, "research/keyword-search-benchmark-matrix") {
		t.Fatalf("filtered keys = %v", keys)
	}
}
