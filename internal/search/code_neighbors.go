package search

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

type CodeNeighborEdge struct {
	From       string `json:"from"`
	To         string `json:"to"`
	Type       string `json:"type"`
	FromPath   string `json:"fromPath,omitempty"`
	ToPath     string `json:"toPath,omitempty"`
	RawTarget  string `json:"rawTarget,omitempty"`
	Status     string `json:"status,omitempty"`
	Confidence string `json:"confidence,omitempty"`
}

type CodeSearchGraphResult struct {
	Matches   []models.SearchResult `json:"matches"`
	Nodes     []Chunk               `json:"nodes"`
	Edges     []CodeNeighborEdge    `json:"edges"`
	Truncated bool                  `json:"truncated,omitempty"`
}

type codeNeighborCandidate struct {
	edge        CodeNeighborEdge
	neighbor    Chunk
	score       int
	bucketKey   string
	bucketLimit int
}

func SearchCodeWithNeighbors(store *storage.Store, embedder EmbedderProvider, vecStore VectorStore, opts models.RetrievalOptions, edgeTypes []string, maxNeighbors int) (*CodeSearchGraphResult, error) {
	db := store.SemanticDB()
	if db == nil {
		return &CodeSearchGraphResult{Matches: []models.SearchResult{}, Nodes: []Chunk{}, Edges: []CodeNeighborEdge{}}, nil
	}
	defer db.Close()

	results, err := keywordSearchCodeChunks(db, opts.Query, opts.Limit)
	if err != nil {
		return nil, err
	}
	if len(results) == 0 {
		return &CodeSearchGraphResult{Matches: []models.SearchResult{}, Nodes: []Chunk{}, Edges: []CodeNeighborEdge{}}, nil
	}

	allowed := make(map[string]bool)
	for _, edgeType := range edgeTypes {
		edgeType = strings.TrimSpace(edgeType)
		if edgeType != "" {
			allowed[edgeType] = true
		}
	}
	useFilter := len(allowed) > 0

	nodeByID := make(map[string]Chunk)
	edges := make([]CodeNeighborEdge, 0)
	truncated := false
	addedEdges := make(map[string]bool)

	for _, match := range results {
		if match.ID == "" {
			continue
		}
		if chunk, ok := loadCodeChunkByID(db, match.ID); ok {
			nodeByID[chunk.ID] = chunk
		}
		rows, err := db.Query(`SELECT from_id, to_id, edge_type, from_path, to_path, raw_target, resolution_status, resolution_confidence FROM code_edges WHERE from_id = ? OR to_id = ? ORDER BY edge_type, from_id, to_id`, match.ID, match.ID)
		if err != nil {
			continue
		}
		candidates := make([]codeNeighborCandidate, 0)
		for rows.Next() {
			var edge CodeNeighborEdge
			if err := rows.Scan(&edge.From, &edge.To, &edge.Type, &edge.FromPath, &edge.ToPath, &edge.RawTarget, &edge.Status, &edge.Confidence); err != nil {
				continue
			}
			if useFilter && !allowed[edge.Type] {
				continue
			}
			neighborID := edge.From
			if neighborID == match.ID {
				neighborID = edge.To
			}
			if neighborID == "" {
				continue
			}
			neighbor, ok := loadCodeChunkByID(db, neighborID)
			if !ok {
				neighbor = Chunk{ID: neighborID, DocPath: firstNonEmpty(edge.FromPath, edge.ToPath)}
			}
			candidates = append(candidates, buildCodeNeighborCandidate(match, edge, neighbor))
		}
		rows.Close()

		selected, wasTruncated := selectRankedNeighborCandidates(candidates, maxNeighbors)
		if wasTruncated {
			truncated = true
		}
		for _, candidate := range selected {
			key := fmt.Sprintf("%s|%s|%s", candidate.edge.From, candidate.edge.Type, candidate.edge.To)
			if addedEdges[key] {
				continue
			}
			addedEdges[key] = true
			edges = append(edges, candidate.edge)
			if candidate.neighbor.ID != "" {
				nodeByID[candidate.neighbor.ID] = candidate.neighbor
			}
		}
	}

	nodes := make([]Chunk, 0, len(nodeByID))
	for _, node := range nodeByID {
		nodes = append(nodes, node)
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].From != edges[j].From {
			return edges[i].From < edges[j].From
		}
		if edges[i].Type != edges[j].Type {
			return edges[i].Type < edges[j].Type
		}
		return edges[i].To < edges[j].To
	})

	return &CodeSearchGraphResult{
		Matches:   results,
		Nodes:     nodes,
		Edges:     edges,
		Truncated: truncated,
	}, nil
}

func buildCodeNeighborCandidate(match models.SearchResult, edge CodeNeighborEdge, neighbor Chunk) codeNeighborCandidate {
	score := codeEdgePriority(edge.Type)
	matchPath := match.Path
	if matchPath != "" && (neighbor.DocPath == matchPath || edge.FromPath == matchPath || edge.ToPath == matchPath) {
		score += 20
	}
	if edge.To == match.ID {
		score += 10
	}
	if edge.From == match.ID {
		score += 8
	}
	bucketAnchor := edge.From
	if edge.To == match.ID {
		bucketAnchor = edge.From
	}
	if edge.From == match.ID {
		bucketAnchor = edge.From
	}
	bucketLimit := 3
	if edge.Type == "calls" || edge.Type == "imports" {
		bucketLimit = 4
	}
	if edge.Type == "contains" {
		bucketLimit = 2
	}
	return codeNeighborCandidate{
		edge:        edge,
		neighbor:    neighbor,
		score:       score,
		bucketKey:   edge.Type + "|" + bucketAnchor,
		bucketLimit: bucketLimit,
	}
}

func selectRankedNeighborCandidates(candidates []codeNeighborCandidate, maxNeighbors int) ([]codeNeighborCandidate, bool) {
	if len(candidates) == 0 {
		return nil, false
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		if candidates[i].edge.Type != candidates[j].edge.Type {
			return candidates[i].edge.Type < candidates[j].edge.Type
		}
		if candidates[i].edge.From != candidates[j].edge.From {
			return candidates[i].edge.From < candidates[j].edge.From
		}
		return candidates[i].edge.To < candidates[j].edge.To
	})

	selected := make([]codeNeighborCandidate, 0, len(candidates))
	bucketCounts := make(map[string]int)
	truncated := false
	for _, candidate := range candidates {
		if candidate.bucketKey != "" && bucketCounts[candidate.bucketKey] >= candidate.bucketLimit {
			truncated = true
			continue
		}
		if maxNeighbors > 0 && len(selected) >= maxNeighbors {
			truncated = true
			break
		}
		selected = append(selected, candidate)
		bucketCounts[candidate.bucketKey]++
	}
	if len(selected) < len(candidates) {
		truncated = true
	}
	return selected, truncated
}

func codeEdgePriority(edgeType string) int {
	switch edgeType {
	case "calls":
		return 100
	case "has_method":
		return 90
	case "extends":
		return 80
	case "implements":
		return 75
	case "imports":
		return 60
	case "contains":
		return 40
	default:
		return 10
	}
}

func keywordSearchCodeChunks(db *sql.DB, query string, limit int) ([]models.SearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []models.SearchResult{}, nil
	}
	if limit <= 0 {
		limit = 10
	}
	queryLower := strings.ToLower(query)
	words := strings.Fields(queryLower)
	rows, err := db.Query(`SELECT id, COALESCE(doc_path, ''), COALESCE(field, ''), COALESCE(name, ''), COALESCE(signature, ''), COALESCE(content, '') FROM chunks WHERE type = 'code' LIMIT 1000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make([]models.SearchResult, 0)
	for rows.Next() {
		var id, docPath, field, name, signature, content string
		if err := rows.Scan(&id, &docPath, &field, &name, &signature, &content); err != nil {
			continue
		}
		score, matchedBy := scoreCodeChunkMatch(queryLower, words, docPath, field, name, signature, content)
		if score <= 0 {
			continue
		}
		snippet := extractSnippet(content, queryLower, 150)
		if snippet == "" {
			snippet = truncateCodeSnippet(content, 150)
		}
		results = append(results, models.SearchResult{
			Type:      "code",
			ID:        id,
			Title:     firstNonEmpty(name, field, id),
			Name:      name,
			Signature: signature,
			Path:      docPath,
			Score:     score,
			Snippet:   snippet,
			MatchedBy: matchedBy,
		})
	}
	sort.Slice(results, func(i, j int) bool { return results[i].Score > results[j].Score })
	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

func scoreCodeChunkMatch(queryLower string, words []string, docPath, field, name, signature, content string) (float64, []string) {
	nameLower := strings.ToLower(name)
	signatureLower := strings.ToLower(signature)
	pathLower := strings.ToLower(docPath)
	contentLower := strings.ToLower(content)
	strongHaystack := strings.Join([]string{nameLower, signatureLower, pathLower}, "\n")
	weakHaystack := strings.Join([]string{nameLower, signatureLower, pathLower, contentLower}, "\n")
	matchedBy := make([]string, 0, 4)
	score := 0.0
	anchors, intents := splitQueryTerms(words)

	if nameLower == queryLower {
		score += 8
		matchedBy = append(matchedBy, "exact-name")
	}
	if nameLower != "" && strings.Contains(nameLower, queryLower) {
		score += 4
		matchedBy = append(matchedBy, "name")
	}
	if signatureLower != "" && strings.Contains(signatureLower, queryLower) {
		score += 2.5
		matchedBy = append(matchedBy, "signature")
	}
	if pathLower != "" && strings.Contains(pathLower, queryLower) {
		score += 3
		matchedBy = append(matchedBy, "path")
	}
	strongMatchedWords := 0
	for _, word := range words {
		if word == "" {
			continue
		}
		if strings.Contains(strongHaystack, word) {
			strongMatchedWords++
			score += 0.35
		}
	}
	if strongMatchedWords == 0 {
		return 0, nil
	}
	if strongMatchedWords == len(words) {
		score += 1.5
		matchedBy = append(matchedBy, "all-terms")
	}

	anchorMatchCount, strongAnchorMatch := scoreAnchorTerms(anchors, nameLower, signatureLower, pathLower, contentLower, &score)
	if len(anchors) > 0 {
		if anchorMatchCount == 0 {
			return 0, nil
		}
		matchedBy = append(matchedBy, "anchor")
	}

	if len(intents) > 0 && strongAnchorMatch {
		if isPathIntentPositive(pathLower, nameLower, field) {
			score += 1.5
			matchedBy = append(matchedBy, "path-intent")
		}
		if isBoilerplateCodePath(pathLower, nameLower, field, signatureLower, contentLower) {
			score -= 2.5
			matchedBy = append(matchedBy, "boilerplate-penalty")
		}
	}

	if isBoilerplateCodePath(pathLower, nameLower, field, signatureLower, contentLower) {
		score -= 0.75
	}

	weakMatchedWords := 0
	for _, word := range words {
		if word == "" {
			continue
		}
		if strings.Contains(weakHaystack, word) {
			weakMatchedWords++
		}
	}
	if weakMatchedWords > strongMatchedWords {
		score += float64(weakMatchedWords-strongMatchedWords) * 0.1
		matchedBy = append(matchedBy, "content")
	}

	return score, dedupeStrings(matchedBy)
}

func looksLikeAPIIntent(words []string) bool {
	for _, word := range words {
		switch word {
		case "api", "page", "endpoint", "route", "handler", "booking", "auth", "admin":
			return true
		}
	}
	return false
}

func splitQueryTerms(words []string) (anchors []string, intents []string) {
	for _, word := range words {
		word = strings.TrimSpace(word)
		if word == "" {
			continue
		}
		if isIntentWord(word) {
			intents = append(intents, word)
			continue
		}
		anchors = append(anchors, word)
	}
	return dedupeStrings(anchors), dedupeStrings(intents)
}

func isIntentWord(word string) bool {
	switch word {
	case "api", "page", "endpoint", "route", "handler", "controller", "service":
		return true
	default:
		return false
	}
}

func scoreAnchorTerms(anchors []string, nameLower, signatureLower, pathLower, contentLower string, score *float64) (int, bool) {
	matchedCount := 0
	strongMatch := false
	for _, anchor := range anchors {
		matched := false
		strongMatchedThisAnchor := false
		if strings.Contains(nameLower, anchor) {
			*score += 3.5
			matched = true
			strongMatch = true
			strongMatchedThisAnchor = true
		}
		if strings.Contains(pathLower, anchor) {
			*score += 3
			matched = true
			strongMatch = true
			strongMatchedThisAnchor = true
		}
		if strings.Contains(signatureLower, anchor) {
			*score += 2
			matched = true
			strongMatch = true
			strongMatchedThisAnchor = true
		}
		if strongMatchedThisAnchor && strings.Contains(contentLower, anchor) {
			*score += 0.6
			matched = true
		}
		if matched {
			matchedCount++
		}
	}
	if len(anchors) > 0 && matchedCount == len(anchors) {
		*score += 1
	}
	return matchedCount, strongMatch
}

func isPathIntentPositive(pathLower, nameLower, field string) bool {
	positives := []string{"controller", "service", "use-case", "usecase", "handler", "route"}
	for _, token := range positives {
		if strings.Contains(pathLower, token) || strings.Contains(nameLower, token) {
			return true
		}
	}
	return field == "method" || field == "function"
}

func isBoilerplateCodePath(pathLower, nameLower, field, signatureLower, contentLower string) bool {
	negatives := []string{"/dto/", ".dto.", "response", "request", "decorator", "standard-response", "swagger"}
	for _, token := range negatives {
		if strings.Contains(pathLower, token) || strings.Contains(nameLower, token) || strings.Contains(signatureLower, token) {
			return true
		}
	}
	if field == "class" && strings.Contains(contentLower, "@apiproperty") {
		return true
	}
	return false
}

func dedupeStrings(items []string) []string {
	seen := make(map[string]bool, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func truncateCodeSnippet(content string, max int) string {
	content = strings.TrimSpace(content)
	if len(content) <= max {
		return content
	}
	return strings.TrimSpace(content[:max]) + "..."
}

func loadCodeChunkByID(db *sql.DB, id string) (Chunk, bool) {
	var chunk Chunk
	var name, signature string
	if err := db.QueryRow(`SELECT id, type, COALESCE(content, ''), COALESCE(doc_path, ''), COALESCE(field, ''), COALESCE(name, ''), COALESCE(signature, '') FROM chunks WHERE id = ? AND type = 'code'`, id).Scan(&chunk.ID, &chunk.Type, &chunk.Content, &chunk.DocPath, &chunk.Field, &name, &signature); err != nil {
		return Chunk{}, false
	}
	chunk.Name = name
	chunk.Signature = signature
	return chunk, true
}
