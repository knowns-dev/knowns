package handlers

import (
	"testing"
)

func TestSplitSymbolWords(t *testing.T) {
	tests := []struct {
		name string
		want []string
	}{
		{"ServerForPath", []string{"server", "for", "path"}},
		{"startDetected", []string{"start", "detected"}},
		{"NewMCPServer", []string{"new", "mcp", "server"}},
		{"XMLParser", []string{"xml", "parser"}},
		{"snake_case_name", []string{"snake", "case", "name"}},
		{"kebab-case-name", []string{"kebab", "case", "name"}},
		{"ClientConnected", []string{"client", "connected"}},
		{"handleCodeFind", []string{"handle", "code", "find"}},
		{"LSPManager", []string{"lsp", "manager"}},
		{"", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := splitSymbolWords(tt.name)
			if len(got) != len(tt.want) {
				t.Fatalf("splitSymbolWords(%q) = %v, want %v", tt.name, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("splitSymbolWords(%q)[%d] = %q, want %q", tt.name, i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestSplitQueryWords(t *testing.T) {
	tests := []struct {
		query string
		want  []string
	}{
		{"server path", []string{"server", "path"}},
		{"MCP server start", []string{"mcp", "server", "start"}},
		{"snake_case", []string{"snake", "case"}},
		{"one", []string{"one"}},
		{"", nil},
	}
	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			got := splitQueryWords(tt.query)
			if len(got) != len(tt.want) {
				t.Fatalf("splitQueryWords(%q) = %v, want %v", tt.query, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("splitQueryWords(%q)[%d] = %q, want %q", tt.query, i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestSymbolScore(t *testing.T) {
	tests := []struct {
		query  string
		symbol string
		minScore float64
		maxScore float64
	}{
		// Exact full match.
		{"ServerForPath", "ServerForPath", 1.0, 1.0},
		// Exact substring.
		{"Server", "ServerForPath", 0.9, 0.96},
		// Prefix match.
		{"Server", "ServerForPath", 0.9, 0.96},
		// Word match: "server path" → ServerForPath.
		{"server path", "ServerForPath", 0.7, 0.89},
		// Word match: "start detected" → startDetected.
		{"start detected", "startDetected", 0.7, 0.89},
		// Single word prefix: "Start" → StartAll.
		{"Start", "StartAll", 0.9, 0.96},
		// Abbreviation: "SFP" → ServerForPath.
		{"SFP", "ServerForPath", 0.7, 0.8},
		// Abbreviation: "NM" → NewManager.
		{"NM", "NewManager", 0.7, 0.8},
		// Partial word match: "detect" → startDetected.
		{"detect", "startDetected", 0.5, 0.95},
		// Multi-word partial: "MCP server" → NewMCPServer.
		{"MCP server", "NewMCPServer", 0.5, 0.89},
		// No match.
		{"completely unrelated", "ServerForPath", 0, 0.29},
		{"xyz", "ServerForPath", 0, 0.29},
		// Empty inputs.
		{"", "ServerForPath", 0, 0},
		{"query", "", 0, 0},
	}
	for _, tt := range tests {
		t.Run(tt.query+"→"+tt.symbol, func(t *testing.T) {
			score := symbolScore(tt.query, tt.symbol)
			if score < tt.minScore || score > tt.maxScore {
				t.Errorf("symbolScore(%q, %q) = %f, want [%f, %f]", tt.query, tt.symbol, score, tt.minScore, tt.maxScore)
			}
		})
	}
}

func TestSymbolScoreOrdering(t *testing.T) {
	// Exact match should score higher than word match.
	exact := symbolScore("ServerForPath", "ServerForPath")
	word := symbolScore("server path", "ServerForPath")
	if exact <= word {
		t.Errorf("exact (%f) should be > word match (%f)", exact, word)
	}

	// Word match should score higher than abbreviation.
	abbr := symbolScore("SFP", "ServerForPath")
	if word <= abbr {
		t.Errorf("word match (%f) should be > abbreviation (%f)", word, abbr)
	}

	// Abbreviation should score higher than no match.
	none := symbolScore("xyz", "ServerForPath")
	if abbr <= none {
		t.Errorf("abbreviation (%f) should be > no match (%f)", abbr, none)
	}
}
