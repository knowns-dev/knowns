package search

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

const (
	lexicalBackendBM25      = "bm25"
	lexicalBackendHeuristic = "heuristic"

	bm25K1 = 1.2
	bm25B  = 0.75
)

var bm25TokenPattern = regexp.MustCompile(`[a-z0-9]+`)

type lexicalBackend interface {
	Search(query string, opts SearchOptions) ([]models.SearchResult, error)
}

type bm25LexicalBackend struct {
	store *storage.Store
}

type heuristicLexicalBackend struct {
	engine *Engine
}

type lexicalDoc struct {
	Type        string
	ID          string
	Title       string
	Path        string
	Snippet     string
	Status      string
	Priority    string
	Tags        []string
	MemoryLayer string
	Category    string
	MemoryStore string
	Fields      []lexicalField
}

type lexicalField struct {
	Name   string
	Text   string
	Weight float64
	Tokens []string
}

type lexicalScoreDetails struct {
	BM25Score   float64
	RerankBoost float64
	FinalScore  float64
	Boosts      []string
}

func newBM25LexicalBackend(store *storage.Store) lexicalBackend {
	return &bm25LexicalBackend{store: store}
}

func newHeuristicLexicalBackend(engine *Engine) lexicalBackend {
	return &heuristicLexicalBackend{engine: engine}
}

// SearchWithLexicalBackend is used by benchmark tooling to compare internal
// lexical implementations without adding public search mode strings.
func SearchWithLexicalBackend(store *storage.Store, backendName string, query string, opts SearchOptions) ([]models.SearchResult, error) {
	engine := NewEngine(store, nil, nil)
	switch backendName {
	case lexicalBackendHeuristic:
		engine.lexicalBackend = newHeuristicLexicalBackend(engine)
	case lexicalBackendBM25, string(ModeKeyword), "":
		engine.lexicalBackend = newBM25LexicalBackend(store)
	default:
		return nil, fmt.Errorf("unknown lexical backend: %s", backendName)
	}
	opts.Query = query
	opts.Mode = string(ModeKeyword)
	return engine.Search(opts)
}

func BM25Tokenize(text string) []string {
	text = strings.ToLower(text)
	raw := bm25TokenPattern.FindAllString(text, -1)
	tokens := make([]string, 0, len(raw))
	for _, token := range raw {
		if token == "" {
			continue
		}
		tokens = append(tokens, token)
	}
	return tokens
}

func (b *heuristicLexicalBackend) Search(query string, opts SearchOptions) ([]models.SearchResult, error) {
	return b.engine.heuristicKeywordSearch(query, opts)
}

func (b *bm25LexicalBackend) Search(query string, opts SearchOptions) ([]models.SearchResult, error) {
	if b.store == nil {
		return nil, fmt.Errorf("search store unavailable")
	}
	queryTokens := BM25Tokenize(query)
	if len(queryTokens) == 0 {
		return []models.SearchResult{}, nil
	}

	corpus, err := b.buildCorpus(opts)
	if err != nil {
		return nil, err
	}
	if len(corpus) == 0 {
		return []models.SearchResult{}, nil
	}

	stats := newBM25CorpusStats(corpus)
	results := make([]models.SearchResult, 0, len(corpus))
	for _, doc := range corpus {
		score := b.scoreDocument(doc, query, queryTokens, stats)
		if score.FinalScore <= 0 {
			continue
		}
		results = append(results, doc.toSearchResult(score.FinalScore))
	}

	sort.SliceStable(results, func(i, j int) bool {
		if results[i].Score != results[j].Score {
			return results[i].Score > results[j].Score
		}
		if results[i].Type != results[j].Type {
			return sourcePreference(results[i].Type) < sourcePreference(results[j].Type)
		}
		return results[i].Title < results[j].Title
	})
	return results, nil
}

func (b *bm25LexicalBackend) buildCorpus(opts SearchOptions) ([]lexicalDoc, error) {
	var corpus []lexicalDoc

	if opts.Type == "" {
		opts.Type = "all"
	}

	if opts.Type == "all" || opts.Type == "task" {
		tasks, err := b.store.Tasks.List()
		if err != nil {
			return nil, err
		}
		for _, task := range tasks {
			if opts.Status != "" && task.Status != opts.Status {
				continue
			}
			if opts.Priority != "" && task.Priority != opts.Priority {
				continue
			}
			if opts.Assignee != "" && task.Assignee != opts.Assignee {
				continue
			}
			if opts.Label != "" && !containsStr(task.Labels, opts.Label) {
				continue
			}
			corpus = append(corpus, lexicalDocFromTask(task))
		}
	}

	if opts.Type == "all" || opts.Type == "doc" {
		docs, err := b.store.Docs.List()
		if err != nil {
			return nil, err
		}
		for _, doc := range docs {
			if opts.Tag != "" && !containsStr(doc.Tags, opts.Tag) {
				continue
			}
			corpus = append(corpus, lexicalDocFromDoc(doc))
		}
	}

	if opts.Type == "all" || opts.Type == "memory" {
		entries, err := b.store.Memory.List("")
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if !memoryVisibleForSearch(entry, opts) {
				continue
			}
			if opts.Tag != "" && !containsStr(entry.Tags, opts.Tag) {
				continue
			}
			corpus = append(corpus, lexicalDocFromMemory(entry))
		}
	}

	if opts.Type == "all" || opts.Type == "decision" {
		decisions, err := b.store.Decisions.List()
		if err != nil {
			return nil, err
		}
		for _, decision := range decisions {
			if !decisionVisibleForSearch(decision, opts) {
				continue
			}
			if opts.Tag != "" && !containsStr(decision.Tags, opts.Tag) {
				continue
			}
			corpus = append(corpus, lexicalDocFromDecision(decision))
		}
	}

	return corpus, nil
}

func (b *bm25LexicalBackend) scoreDocument(doc lexicalDoc, query string, queryTokens []string, stats bm25CorpusStats) lexicalScoreDetails {
	details := lexicalScoreDetails{}
	seenTerms := uniqueTokens(queryTokens)
	for _, term := range seenTerms {
		idf := stats.idf(term)
		for _, field := range doc.Fields {
			tf := termFrequency(field.Tokens, term)
			if tf == 0 {
				continue
			}
			fieldLen := float64(len(field.Tokens))
			denom := tf + bm25K1*(1-bm25B+bm25B*(fieldLen/stats.avgFieldLength(field.Name)))
			details.BM25Score += field.Weight * idf * ((tf * (bm25K1 + 1)) / denom)
		}
	}
	details.RerankBoost, details.Boosts = bm25RerankBoost(doc, query, queryTokens)
	// Only apply source-type tie-breaking boost when there is a real BM25 match.
	// Without this guard, every document would receive a positive FinalScore
	// (0 + 0.20/0.30) for any query, causing gibberish queries to return all results.
	if details.BM25Score > 0 {
		switch doc.Type {
		case "doc":
			details.RerankBoost += 0.20
		case "task":
			details.RerankBoost += 0.30
		case "memory":
			details.RerankBoost += 0.05
		case "decision":
			details.RerankBoost += 0.18
		}
	}
	details.FinalScore = details.BM25Score + details.RerankBoost
	return details
}

func lexicalDocFromTask(task *models.Task) lexicalDoc {
	acTexts := make([]string, 0, len(task.AcceptanceCriteria))
	for _, ac := range task.AcceptanceCriteria {
		acTexts = append(acTexts, ac.Text)
	}
	doc := lexicalDoc{
		Type:     "task",
		ID:       task.ID,
		Title:    task.Title,
		Snippet:  firstNonEmpty(task.Description, task.ImplementationPlan, task.ImplementationNotes),
		Status:   task.Status,
		Priority: task.Priority,
		Tags:     append([]string{}, task.Labels...),
		Fields: []lexicalField{
			newLexicalField("title", task.Title, 4.0),
			newLexicalField("id", task.ID, 5.0),
			newLexicalField("labels", strings.Join(task.Labels, " "), 2.2),
			newLexicalField("description", task.Description, 1.5),
			newLexicalField("plan", task.ImplementationPlan, 1.0),
			newLexicalField("notes", task.ImplementationNotes, 0.8),
			newLexicalField("acceptance", strings.Join(acTexts, " "), 0.8),
			newLexicalField("status_priority", task.Status+" "+task.Priority, 0.4),
		},
	}
	doc.Snippet = snippetForLexicalDoc(doc, doc.Snippet)
	return doc
}

func lexicalDocFromDoc(doc *models.Doc) lexicalDoc {
	lex := lexicalDoc{
		Type:    "doc",
		ID:      doc.Path,
		Title:   doc.Title,
		Path:    doc.Path,
		Snippet: firstNonEmpty(doc.Description, doc.Content),
		Tags:    append([]string{}, doc.Tags...),
		Fields: []lexicalField{
			newLexicalField("title", doc.Title, 4.0),
			newLexicalField("path", doc.Path, 3.2),
			newLexicalField("tags", strings.Join(doc.Tags, " "), 2.2),
			newLexicalField("description", doc.Description, 1.6),
			newLexicalField("content", doc.Content, 1.0),
		},
	}
	lex.Snippet = snippetForLexicalDoc(lex, lex.Snippet)
	return lex
}

func lexicalDocFromMemory(entry *models.MemoryEntry) lexicalDoc {
	memStore := memoryStoreForLayer(entry.Layer)
	lex := lexicalDoc{
		Type:        "memory",
		ID:          entry.ID,
		Title:       entry.Title,
		Snippet:     firstNonEmpty(entry.Content, entry.Category),
		Status:      entry.Status,
		Tags:        append([]string{}, entry.Tags...),
		MemoryLayer: entry.Layer,
		Category:    entry.Category,
		MemoryStore: memStore,
		Fields: []lexicalField{
			newLexicalField("title", entry.Title, 4.0),
			newLexicalField("category", entry.Category, 2.8),
			newLexicalField("tags", strings.Join(entry.Tags, " "), 2.2),
			newLexicalField("content", entry.Content, 1.2),
			newLexicalField("layer", entry.Layer, 0.4),
		},
	}
	lex.Snippet = snippetForLexicalDoc(lex, lex.Snippet)
	return lex
}

func lexicalDocFromDecision(entry *models.DecisionEntry) lexicalDoc {
	text := decisionText(entry)
	lex := lexicalDoc{
		Type:    "decision",
		ID:      entry.ID,
		Title:   entry.Title,
		Snippet: firstNonEmpty(entry.Decision, entry.Context, entry.Content, text),
		Status:  entry.Status,
		Tags:    append([]string{}, entry.Tags...),
		Fields: []lexicalField{
			newLexicalField("title", entry.Title, 4.0),
			newLexicalField("id", entry.ID, 3.2),
			newLexicalField("status", entry.Status, 0.6),
			newLexicalField("tags", strings.Join(entry.Tags, " "), 2.2),
			newLexicalField("sources", strings.Join(entry.Sources, " "), 1.0),
			newLexicalField("related_docs", strings.Join(entry.RelatedDocs, " "), 1.0),
			newLexicalField("related_tasks", strings.Join(entry.RelatedTasks, " "), 1.0),
			newLexicalField("content", text, 1.2),
		},
	}
	lex.Snippet = snippetForLexicalDoc(lex, lex.Snippet)
	return lex
}

func newLexicalField(name, text string, weight float64) lexicalField {
	return lexicalField{
		Name:   name,
		Text:   text,
		Weight: weight,
		Tokens: BM25Tokenize(text),
	}
}

func (d lexicalDoc) toSearchResult(score float64) models.SearchResult {
	return models.SearchResult{
		Type:        d.Type,
		ID:          d.ID,
		Title:       d.Title,
		Score:       score,
		Snippet:     truncateStr(d.Snippet, 150),
		MatchedBy:   []string{"keyword"},
		Status:      d.Status,
		Priority:    d.Priority,
		Path:        d.Path,
		Tags:        d.Tags,
		MemoryLayer: d.MemoryLayer,
		Category:    d.Category,
		MemoryStore: d.MemoryStore,
	}
}

type bm25CorpusStats struct {
	docCount       int
	documentFreqs  map[string]int
	fieldLengths   map[string]int
	fieldDocCounts map[string]int
}

func newBM25CorpusStats(corpus []lexicalDoc) bm25CorpusStats {
	stats := bm25CorpusStats{
		docCount:       len(corpus),
		documentFreqs:  map[string]int{},
		fieldLengths:   map[string]int{},
		fieldDocCounts: map[string]int{},
	}
	for _, doc := range corpus {
		docTerms := map[string]bool{}
		for _, field := range doc.Fields {
			stats.fieldLengths[field.Name] += len(field.Tokens)
			stats.fieldDocCounts[field.Name]++
			for _, token := range uniqueTokens(field.Tokens) {
				docTerms[token] = true
			}
		}
		for token := range docTerms {
			stats.documentFreqs[token]++
		}
	}
	return stats
}

func (s bm25CorpusStats) idf(term string) float64 {
	df := s.documentFreqs[term]
	if s.docCount == 0 || df == 0 {
		return 0
	}
	return math.Log(1 + (float64(s.docCount)-float64(df)+0.5)/(float64(df)+0.5))
}

func (s bm25CorpusStats) avgFieldLength(field string) float64 {
	count := s.fieldDocCounts[field]
	if count == 0 {
		return 1
	}
	avg := float64(s.fieldLengths[field]) / float64(count)
	if avg <= 0 {
		return 1
	}
	return avg
}

func bm25RerankBoost(doc lexicalDoc, query string, queryTokens []string) (float64, []string) {
	queryLower := strings.ToLower(strings.TrimSpace(query))
	if queryLower == "" {
		return 0, nil
	}

	boost := 0.0
	var signals []string
	add := func(amount float64, signal string) {
		boost += amount
		signals = append(signals, signal)
	}

	titleLower := strings.ToLower(doc.Title)
	pathLower := strings.ToLower(doc.Path)
	categoryLower := strings.ToLower(doc.Category)

	if titleLower == queryLower {
		add(8.0, "exact_title")
	} else if phraseMatch(doc.Title, queryLower) {
		add(4.0, "title_phrase")
	}
	if doc.Path != "" {
		if pathLower == queryLower {
			add(7.0, "exact_path")
		} else if strings.Contains(pathLower, queryLower) {
			add(3.0, "path_phrase")
		}
	}
	if categoryLower == queryLower {
		add(4.0, "exact_category")
	} else if categoryLower != "" && strings.Contains(categoryLower, queryLower) {
		add(2.0, "category_phrase")
	}
	for _, tag := range doc.Tags {
		tagLower := strings.ToLower(tag)
		if tagLower == queryLower {
			add(3.0, "exact_tag")
			break
		}
	}

	matchedTitleTerms := 0
	for _, token := range uniqueTokens(queryTokens) {
		if wordBoundaryCount(doc.Title, token) > 0 {
			matchedTitleTerms++
		}
	}
	if matchedTitleTerms > 0 && len(queryTokens) > 1 {
		add(float64(matchedTitleTerms)/float64(len(uniqueTokens(queryTokens)))*6.0, "title_terms")
	}

	return boost, signals
}

func termFrequency(tokens []string, term string) float64 {
	count := 0
	for _, token := range tokens {
		if token == term {
			count++
		}
	}
	return float64(count)
}

func uniqueTokens(tokens []string) []string {
	seen := make(map[string]bool, len(tokens))
	unique := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if token == "" || seen[token] {
			continue
		}
		seen[token] = true
		unique = append(unique, token)
	}
	return unique
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func snippetForLexicalDoc(doc lexicalDoc, fallback string) string {
	for _, field := range doc.Fields {
		if field.Name == "title" || field.Name == "path" || field.Name == "tags" || field.Name == "category" {
			continue
		}
		if strings.TrimSpace(field.Text) != "" {
			return field.Text
		}
	}
	return fallback
}
