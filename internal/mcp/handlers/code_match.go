package handlers

import (
	"strings"
	"unicode"
)

const symbolScoreThreshold = 0.3

// symbolScore returns a relevance score (0.0–1.0) for how well query matches symbolName.
func symbolScore(query, symbolName string) float64 {
	if query == "" || symbolName == "" {
		return 0
	}

	lowerQuery := strings.ToLower(query)
	lowerName := strings.ToLower(symbolName)

	// Exact substring match — highest score.
	if strings.Contains(lowerName, lowerQuery) {
		// Bonus for exact full match.
		if lowerName == lowerQuery {
			return 1.0
		}
		// Bonus for prefix match.
		if strings.HasPrefix(lowerName, lowerQuery) {
			return 0.95
		}
		return 0.9
	}

	queryWords := splitQueryWords(query)
	if len(queryWords) == 0 {
		return 0
	}

	symbolWords := splitSymbolWords(symbolName)
	if len(symbolWords) == 0 {
		return 0
	}

	// Abbreviation match: "SFP" matches "ServerForPath".
	score := abbreviationScore(lowerQuery, symbolWords)

	// Word-level matching.
	wordScore := wordMatchScore(queryWords, symbolWords)
	if wordScore > score {
		score = wordScore
	}

	return score
}

// wordMatchScore scores how many query words match symbol words.
func wordMatchScore(queryWords, symbolWords []string) float64 {
	if len(queryWords) == 0 {
		return 0
	}

	var totalScore float64
	for _, qw := range queryWords {
		best := wordBestMatch(qw, symbolWords)
		totalScore += best
	}

	// Cap word-level matching below exact substring (0.9).
	return (totalScore / float64(len(queryWords))) * 0.85
}

// wordBestMatch returns the best match score for a single query word against symbol words.
func wordBestMatch(qw string, symbolWords []string) float64 {
	var best float64
	for _, sw := range symbolWords {
		if sw == qw {
			return 1.0
		}
		if strings.HasPrefix(sw, qw) {
			if s := 0.9; s > best {
				best = s
			}
		} else if strings.Contains(sw, qw) {
			if s := 0.6; s > best {
				best = s
			}
		}
	}
	return best
}

// abbreviationScore checks if query is an abbreviation of symbol words.
// "SFP" matches "ServerForPath" → 0.8.
func abbreviationScore(lowerQuery string, symbolWords []string) float64 {
	if len(lowerQuery) > len(symbolWords) || len(lowerQuery) < 2 {
		return 0
	}
	// Check if each character matches the first letter of consecutive symbol words.
	for i, ch := range lowerQuery {
		if i >= len(symbolWords) {
			return 0
		}
		if len(symbolWords[i]) == 0 || rune(symbolWords[i][0]) != ch {
			return 0
		}
	}
	// Bonus if abbreviation covers all words.
	if len(lowerQuery) == len(symbolWords) {
		return 0.75
	}
	return 0.6
}

// splitQueryWords splits a query string into lowercase words on spaces and punctuation.
func splitQueryWords(query string) []string {
	words := strings.FieldsFunc(query, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for i, w := range words {
		words[i] = strings.ToLower(w)
	}
	return words
}

// splitSymbolWords splits a symbol name into lowercase words on camelCase, PascalCase,
// snake_case, and kebab-case boundaries.
func splitSymbolWords(name string) []string {
	var words []string
	var current []rune

	flush := func() {
		if len(current) > 0 {
			words = append(words, strings.ToLower(string(current)))
			current = current[:0]
		}
	}

	runes := []rune(name)
	for i := 0; i < len(runes); i++ {
		r := runes[i]

		if r == '_' || r == '-' || r == '.' {
			flush()
			continue
		}

		if unicode.IsUpper(r) {
			// Handle consecutive uppercase: "XMLParser" → ["xml", "parser"]
			if len(current) > 0 && unicode.IsLower(current[len(current)-1]) {
				flush()
			} else if len(current) > 1 && i+1 < len(runes) && unicode.IsLower(runes[i+1]) {
				// "XMLParser" at 'P': flush "XM", start "P"
				flush()
			}
		}

		current = append(current, r)
	}
	flush()

	return words
}
