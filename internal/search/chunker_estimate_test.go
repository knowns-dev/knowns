package search

import "testing"

// Byte division charged accented text two or three times per character, so a
// Vietnamese chunk was estimated far above its real token count and split more
// aggressively than the model required. Counting pre-tokenizer pieces is
// script-neutral: the same sentence in Vietnamese and English costs a
// comparable number of pieces, as it does in the tokenizer itself.
func TestEstimateTokensDoesNotPenalizeNonASCII(t *testing.T) {
	// Same shape, same word count, different scripts.
	ascii := "The system uses a model to create vectors for documents and tasks"
	viet := "Hệ thống sử dụng mô hình để tạo vector biểu diễn tài liệu và nhiệm vụ"

	gotASCII := EstimateTokens(ascii)
	gotViet := EstimateTokens(viet)
	if gotASCII == 0 || gotViet == 0 {
		t.Fatalf("estimates must be positive: ascii=%d viet=%d", gotASCII, gotViet)
	}
	// Byte division returned roughly twice as many for the Vietnamese line.
	// Allow a modest spread, but not the doubling the old heuristic produced.
	ratio := float64(gotViet) / float64(gotASCII)
	if ratio > 1.35 || ratio < 0.65 {
		t.Fatalf("non-ASCII estimate skewed: ascii=%d viet=%d ratio=%.2f", gotASCII, gotViet, ratio)
	}
}

// The letter class has to be Unicode-aware. Go's \w is ASCII only, so using it
// would push every accented letter into the punctuation branch and inflate the
// count. This pins the regression: each accented word must stay one piece.
func TestEstimateTokensTreatsAccentedWordsAsSinglePieces(t *testing.T) {
	if got := EstimateTokens("nhiệm"); got != 1 {
		t.Fatalf("EstimateTokens(%q) = %d, want 1", "nhiệm", got)
	}
	if got := EstimateTokens("thống nhất"); got != 2 {
		t.Fatalf("EstimateTokens(%q) = %d, want 2", "thống nhất", got)
	}
}

func TestEstimateTokensEdgeCases(t *testing.T) {
	for _, test := range []struct {
		name string
		in   string
		want int
	}{
		{"empty is zero", "", 0},
		{"single word", "hello", 1},
		{"word and punctuation split", "hello!", 2},
		{"leading space joins its word", " hello", 1},
		// Whitespace alone still costs something: the tokenizer encodes it.
		{"whitespace only", "   ", 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := EstimateTokens(test.in); got != test.want {
				t.Fatalf("EstimateTokens(%q) = %d, want %d", test.in, got, test.want)
			}
		})
	}
}

// The estimate feeds chunk sizing, so it has to grow with the text rather than
// saturate: a longer passage must never be estimated as smaller than a prefix
// of itself.
func TestEstimateTokensIsMonotonic(t *testing.T) {
	base := "Doctor reported semantic staleness that no remediation could clear"
	prev := 0
	for i := 1; i <= 4; i++ {
		text := ""
		for j := 0; j < i; j++ {
			text += base + " "
		}
		got := EstimateTokens(text)
		if got < prev {
			t.Fatalf("estimate shrank as text grew: %d then %d", prev, got)
		}
		prev = got
	}
}
