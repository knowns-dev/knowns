package search

import (
	"fmt"
	"sort"
	"strings"

	"github.com/howznguyen/knowns/internal/lsp"
)

// codeSymbolKindString converts LSP SymbolKind numeric code to human-readable string.
func codeSymbolKindString(kind int) string {
	switch kind {
	case 1:
		return "File"
	case 2:
		return "Module"
	case 3:
		return "Namespace"
	case 4:
		return "Package"
	case 5:
		return "Class"
	case 6:
		return "Method"
	case 7:
		return "Property"
	case 8:
		return "Field"
	case 9:
		return "Constructor"
	case 10:
		return "Enum"
	case 11:
		return "Interface"
	case 12:
		return "Function"
	case 13:
		return "Variable"
	case 14:
		return "Constant"
	case 15:
		return "String"
	case 16:
		return "Number"
	case 17:
		return "Boolean"
	case 18:
		return "Array"
	case 19:
		return "Object"
	case 20:
		return "Key"
	case 21:
		return "Null"
	case 22:
		return "EnumMember"
	case 23:
		return "Struct"
	case 24:
		return "Event"
	case 25:
		return "Operator"
	case 26:
		return "TypeParameter"
	default:
		return "Unknown"
	}
}

// CodeSummary is a BM25-indexable summary of a single LSP symbol.
type CodeSummary struct {
	Name           string // symbol name e.g. "handleCodeFind"
	Kind           string // human-readable kind e.g. "Function", "Method", "Class"
	Container      string // owner/parent e.g. "handlers" or "Server"
	Signature      string // detail/type info from LSP
	Path           string // relative file path
	Package        string // directory or module context
	Comments       string // docstrings/comments extracted from source
	Relationships  string // cheap relationship context (calls, imports, implements keywords found in body)
	StartLine      int    // 1-based start line for LSP navigation
	EndLine        int    // 1-based end line for LSP navigation
	StartCharacter int    // 1-based start character
	SelectionStart int    // 1-based selection start line
	SelectionChar  int    // 1-based selection start character
}

// CodeBM25Result is a single BM25 code discovery result with LSP navigation metadata.
type CodeBM25Result struct {
	Name           string  `json:"name"`
	Kind           string  `json:"kind"`
	Container      string  `json:"container,omitempty"`
	Signature      string  `json:"signature,omitempty"`
	Path           string  `json:"path"`
	Package        string  `json:"package,omitempty"`
	StartLine      int     `json:"start_line"`
	EndLine        int     `json:"end_line"`
	StartCharacter int     `json:"start_character"`
	SelectionStart int     `json:"selection_start"`
	SelectionChar  int     `json:"selection_char"`
	Score          float64 `json:"score"`
	Snippet        string  `json:"snippet,omitempty"`
}

// CodeBM25Scorer provides opt-in BM25 lexical search over LSP-derived code summaries.
// It does not use semantic embeddings and is separate from default ingest/reindex.
type CodeBM25Scorer struct {
	summaries []CodeSummary
}

// NewCodeBM25Scorer creates a scorer from pre-built code summaries.
func NewCodeBM25Scorer(summaries []CodeSummary) *CodeBM25Scorer {
	return &CodeBM25Scorer{summaries: summaries}
}

// Search performs BM25 lexical search over code summaries without embeddings.
// Returns results sorted by BM25 score with LSP navigation metadata.
func (s *CodeBM25Scorer) Search(query string, limit int) ([]CodeBM25Result, error) {
	if query == "" {
		return []CodeBM25Result{}, nil
	}
	queryTokens := BM25Tokenize(query)
	if len(queryTokens) == 0 {
		return []CodeBM25Result{}, nil
	}
	if limit <= 0 {
		limit = 20
	}

	stats := codeBM25CorpusStats(s.summaries, queryTokens)
	results := make([]CodeBM25Result, 0, len(s.summaries))

	for _, sym := range s.summaries {
		score := codeBM25Score(sym, queryTokens, stats)
		if score <= 0 {
			continue
		}
		results = append(results, CodeBM25Result{
			Name:           sym.Name,
			Kind:           sym.Kind,
			Container:      sym.Container,
			Signature:      sym.Signature,
			Path:           sym.Path,
			Package:        sym.Package,
			StartLine:      sym.StartLine,
			EndLine:        sym.EndLine,
			StartCharacter: sym.StartCharacter,
			SelectionStart: sym.SelectionStart,
			SelectionChar:  sym.SelectionChar,
			Score:          score,
			Snippet:        codeSnippet(sym),
		})
	}

	sort.SliceStable(results, func(i, j int) bool {
		if results[i].Score != results[j].Score {
			return results[i].Score > results[j].Score
		}
		if results[i].Path != results[j].Path {
			return results[i].Path < results[j].Path
		}
		return results[i].Name < results[j].Name
	})

	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

// BuildCodeSummaries builds BM25-indexable summaries from LSP DocumentSymbols.
// It extracts symbol name, kind/owner, signature, path, package, comments, and
// cheap relationship context from the source body.
func BuildCodeSummaries(relPath string, symbols []lsp.DocumentSymbol, source string) []CodeSummary {
	var summaries []CodeSummary
	lines := strings.Split(source, "\n")
	pkg := PackageFromPath(relPath)

	collectSymbols(relPath, pkg, "", symbols, lines, &summaries)
	return summaries
}

func collectSymbols(path, pkg, parent string, symbols []lsp.DocumentSymbol, lines []string, out *[]CodeSummary) {
	for _, sym := range symbols {
		container := parent
		if container == "" {
			container = pkg
		}

		summary := CodeSummary{
			Name:           sym.Name,
			Kind:           codeSymbolKindString(sym.Kind),
			Container:      container,
			Signature:      sym.Detail,
			Path:           path,
			Package:        pkg,
			Comments:       extractComments(lines, sym.Range.Start.Line),
			Relationships:  extractRelationships(lines, sym.Range),
			StartLine:      sym.Range.Start.Line + 1,
			EndLine:        sym.Range.End.Line + 1,
			StartCharacter: sym.Range.Start.Character + 1,
			SelectionStart: sym.SelectionRange.Start.Line + 1,
			SelectionChar:  sym.SelectionRange.Start.Character + 1,
		}
		*out = append(*out, summary)

		childParent := sym.Name
		if parent != "" {
			childParent = parent + "." + sym.Name
		}
		collectSymbols(path, pkg, childParent, sym.Children, lines, out)
	}
}

// extractComments grabs preceding comment lines before a symbol definition.
func extractComments(lines []string, startLine int) string {
	if startLine <= 0 || startLine >= len(lines) {
		return ""
	}
	var comments []string
	for i := startLine - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			break
		}
		if strings.HasPrefix(line, "//") || strings.HasPrefix(line, "/*") || strings.HasPrefix(line, "*") || strings.HasPrefix(line, "#") {
			comments = append([]string{line}, comments...)
		} else {
			break
		}
	}
	return strings.Join(comments, " ")
}

// extractRelationships finds cheap relationship keywords in the symbol body.
func extractRelationships(lines []string, rng lsp.Range) string {
	start := rng.Start.Line
	end := rng.End.Line
	if start < 0 || start >= len(lines) {
		return ""
	}
	if end >= len(lines) {
		end = len(lines) - 1
	}

	body := strings.ToLower(strings.Join(lines[start:end+1], " "))
	var rels []string

	relKeywords := []struct {
		keyword string
		label   string
	}{
		{"func ", "calls"},
		{".", "method_access"},
		{"import ", "imports"},
		{"implements", "implements"},
		{"extends", "extends"},
		{"interface", "interface"},
		{"struct ", "struct"},
		{"type ", "type_def"},
	}

	for _, rk := range relKeywords {
		if strings.Contains(body, rk.keyword) {
			rels = append(rels, rk.label)
		}
	}
	return strings.Join(rels, ",")
}

func PackageFromPath(path string) string {
	if path == "" {
		return ""
	}
	parts := strings.Split(path, "/")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return path
}

func codeSnippet(sym CodeSummary) string {
	if sym.Signature != "" {
		return truncateStr(sym.Signature, 120)
	}
	if sym.Comments != "" {
		return truncateStr(sym.Comments, 120)
	}
	return fmt.Sprintf("%s %s", sym.Kind, sym.Name)
}

// codeBM25CorpusStats computes IDF over code summary fields for BM25 scoring.
func codeBM25CorpusStats(summaries []CodeSummary, queryTokens []string) map[string]float64 {
	idf := make(map[string]float64)
	n := len(summaries)
	if n == 0 {
		return idf
	}

	for _, token := range queryTokens {
		df := 0
		for _, sym := range summaries {
			if codeSummaryContainsToken(sym, token) {
				df++
			}
		}
		if df > 0 {
			idf[token] = bm25IDF(float64(n), float64(df))
		}
	}
	return idf
}

func bm25IDF(n, df float64) float64 {
	return 1.0 + (n-df+0.5)/(df+0.5)
}

func codeSummaryContainsToken(sym CodeSummary, token string) bool {
	text := strings.ToLower(sym.Name + " " + sym.Kind + " " + sym.Container + " " + sym.Signature + " " + sym.Path + " " + sym.Package + " " + sym.Comments + " " + sym.Relationships)
	return strings.Contains(text, token)
}

// codeBM25Score computes a BM25-like score for a code summary against query tokens.
func codeBM25Score(sym CodeSummary, queryTokens []string, idf map[string]float64) float64 {
	score := 0.0

	fields := []struct {
		text   string
		weight float64
	}{
		{sym.Name, 5.0},
		{sym.Container, 3.0},
		{sym.Signature, 2.5},
		{sym.Comments, 2.0},
		{sym.Path, 1.5},
		{sym.Relationships, 1.2},
		{sym.Package, 1.0},
		{sym.Kind, 0.8},
	}

	for _, field := range fields {
		if field.text == "" {
			continue
		}
		fieldTokens := BM25Tokenize(field.text)
		fieldLen := float64(len(fieldTokens))
		if fieldLen == 0 {
			continue
		}

		for _, token := range queryTokens {
			tf := 0.0
			for _, ft := range fieldTokens {
				if ft == token {
					tf++
				}
			}
			if tf == 0 {
				continue
			}
			tokenIDF := idf[token]
			if tokenIDF == 0 {
				continue
			}
			denom := tf + bm25K1*(1-bm25B+bm25B*(fieldLen/float64(len(queryTokens))))
			score += field.weight * tokenIDF * ((tf * (bm25K1 + 1)) / denom)
		}
	}

	// Rerank boosts.
	score += codeBM25RerankBoost(sym, queryTokens)
	return score
}

func codeBM25RerankBoost(sym CodeSummary, queryTokens []string) float64 {
	boost := 0.0
	queryLower := strings.ToLower(strings.Join(queryTokens, " "))
	nameLower := strings.ToLower(sym.Name)

	// Exact name match.
	if nameLower == queryLower {
		boost += 10.0
	} else if strings.HasPrefix(nameLower, queryLower) {
		boost += 6.0
	} else if strings.Contains(nameLower, queryLower) {
		boost += 4.0
	}

	// Container match.
	if strings.ToLower(sym.Container) == queryLower {
		boost += 5.0
	}

	// Path match for auth-related evidence.
	pathLower := strings.ToLower(sym.Path)
	for _, token := range queryTokens {
		if strings.Contains(pathLower, token) {
			boost += 2.0
			break
		}
	}

	// Comment/auth keyword boost.
	commentsLower := strings.ToLower(sym.Comments)
	for _, kw := range []string{"login", "auth", "authenticate", "token", "session", "credential"} {
		if strings.Contains(commentsLower, kw) && containsToken(queryTokens, kw) {
			boost += 3.0
			break
		}
	}

	return boost
}

func containsToken(tokens []string, target string) bool {
	for _, t := range tokens {
		if t == target {
			return true
		}
	}
	return false
}
