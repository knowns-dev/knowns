package search

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/references"
	"github.com/howznguyen/knowns/internal/storage"
)

const memoryStoreProject = "project-store"
const memoryStoreGlobal = "global-store"

// SearchPurpose makes Task lifecycle visibility explicit at the shared search
// boundary. Public Search callers use the zero-value human purpose; Retrieve
// always selects the AI purpose.
type SearchPurpose string

const (
	SearchPurposeHuman       SearchPurpose = "human-search"
	SearchPurposeAIRetrieval SearchPurpose = "ai-retrieval"
)

type taskVisibility string

const (
	taskVisibilityHuman      taskVisibility = "active-and-done"
	taskVisibilityActive     taskVisibility = "active-only"
	taskVisibilityHistorical taskVisibility = "active-done-archived"
)

type taskSearchSnapshot struct {
	byID map[string]*models.Task
}

// SearchOptions configures a search query.
type SearchOptions struct {
	Query             string
	Type              string // "all", "task", "doc", "memory", "decision"
	Mode              string // "keyword", "semantic", "hybrid"
	Status            string
	Priority          string
	Assignee          string
	Label             string
	Tag               string
	Limit             int
	IncludeHistorical bool
	Purpose           SearchPurpose
	taskVisibility    taskVisibility
	taskSnapshot      *taskSearchSnapshot
}

// Engine provides keyword, semantic, and hybrid search across tasks and docs.
type Engine struct {
	store          *storage.Store
	embedder       EmbedderProvider // nil if semantic not available
	vecStore       VectorStore      // nil if semantic not available
	lexicalBackend lexicalBackend
}

// NewEngine creates a search engine backed by the given store.
// Pass nil embedder/vecStore for keyword-only mode.
func NewEngine(store *storage.Store, embedder EmbedderProvider, vecStore VectorStore) *Engine {
	e := &Engine{
		store:    store,
		embedder: embedder,
		vecStore: vecStore,
	}
	e.lexicalBackend = newBM25LexicalBackend(store)
	return e
}

// SemanticAvailable returns true if the engine can perform semantic search.
func (e *Engine) SemanticAvailable() bool {
	return e.embedder != nil && e.vecStore != nil && e.vecStore.Count() > 0
}

// Search executes a search and returns scored results.
func (e *Engine) Search(opts SearchOptions) ([]models.SearchResult, error) {
	if opts.Limit <= 0 {
		opts.Limit = 20
	}
	if opts.Type == "" {
		opts.Type = "all"
	}
	if opts.Mode == "" {
		opts.Mode = string(ModeHybrid)
	}
	opts = e.resolveTaskVisibility(opts)

	query := strings.TrimSpace(opts.Query)
	if query == "" {
		return []models.SearchResult{}, nil
	}
	var snapshotErr error
	opts, snapshotErr = e.withTaskSnapshot(opts)
	if snapshotErr != nil {
		return nil, snapshotErr
	}

	mode := SearchMode(opts.Mode)
	semanticAvailable := false
	if mode != ModeKeyword {
		semanticAvailable = e.semanticAvailableForType(opts.Type)
	}

	// Auto-detect mode: if semantic not available, fall back to keyword.
	if mode != ModeKeyword && !semanticAvailable {
		mode = ModeKeyword
	}

	var results []models.SearchResult
	var err error

	switch mode {
	case ModeKeyword:
		results, err = e.keywordSearch(query, opts)
	case ModeSemantic:
		results, err = e.semanticSearch(query, opts)
	case ModeHybrid:
		results, err = e.hybridSearch(query, opts)
	default:
		results, err = e.keywordSearch(query, opts)
	}
	if err != nil {
		return nil, err
	}

	results = filterSearchResultsByType(results, opts.Type)
	results = e.canonicalizeTaskResults(results, opts)

	// Preserve established cross-source score ordering, then lifecycle-group the
	// Task subsequence in the same result slots. This keeps mixed-source ordering
	// deterministic without letting an archived Task outrank an active Task.
	sort.SliceStable(results, func(i, j int) bool {
		return results[i].Score > results[j].Score
	})
	if opts.IncludeHistorical {
		groupHistoricalTaskResults(results)
	}

	if len(results) > opts.Limit {
		results = results[:opts.Limit]
	}

	return results, nil
}

// Retrieve executes mixed-source retrieval and assembles a context pack.
func (e *Engine) Retrieve(opts models.RetrievalOptions) (*models.RetrievalResponse, error) {
	semanticAvailable := false
	if opts.Mode != string(ModeKeyword) {
		semanticAvailable = e.semanticAvailableForType(typeFilterFromSources(opts.SourceTypes))
	}
	searchOpts := SearchOptions{
		Query:             opts.Query,
		Mode:              opts.Mode,
		Limit:             opts.Limit,
		Tag:               opts.Tag,
		Status:            opts.Status,
		Priority:          opts.Priority,
		Assignee:          opts.Assignee,
		Label:             opts.Label,
		Type:              typeFilterFromSources(opts.SourceTypes),
		IncludeHistorical: opts.IncludeHistorical,
		Purpose:           SearchPurposeAIRetrieval,
	}
	searchOpts = e.resolveTaskVisibility(searchOpts)
	searchOpts, err := e.withTaskSnapshot(searchOpts)
	if err != nil {
		return nil, err
	}

	results, err := e.Search(searchOpts)
	if err != nil {
		return nil, err
	}

	filtered := filterBySourceTypes(results, opts.SourceTypes)
	candidates := e.buildCandidates(filtered, searchOpts)
	if opts.ExpandReferences {
		expanded := e.expandCandidateReferences(candidates, opts, searchOpts)
		candidates = mergeCandidates(candidates, expanded, opts.IncludeHistorical)
	}
	candidates = e.canonicalizeRetrievalCandidates(candidates, searchOpts)

	response := &models.RetrievalResponse{
		Query:      strings.TrimSpace(opts.Query),
		Mode:       effectiveMode(searchOpts.Mode, semanticAvailable),
		Candidates: candidates,
		ContextPack: models.ContextPack{
			Items: e.buildContextPack(candidates, searchOpts),
			Mode:  "docs-first",
		},
	}
	if response.Candidates == nil {
		response.Candidates = []models.RetrievalCandidate{}
	}
	if response.ContextPack.Items == nil {
		response.ContextPack.Items = []models.ContextItem{}
	}
	return response, nil
}

func (e *Engine) withTaskSnapshot(opts SearchOptions) (SearchOptions, error) {
	if opts.taskSnapshot != nil {
		return opts, nil
	}
	snapshot := &taskSearchSnapshot{byID: map[string]*models.Task{}}
	opts.taskSnapshot = snapshot
	if e == nil || e.store == nil || e.store.Tasks == nil {
		return opts, nil
	}
	if opts.Type != "" && opts.Type != "all" && opts.Type != "task" {
		return opts, nil
	}
	err := e.store.WithTaskLifecycleTransaction(context.Background(), func(tx *storage.TaskLifecycleTransaction) error {
		active, err := tx.ListActiveTasks()
		if err != nil {
			return fmt.Errorf("snapshot active Tasks: %w", err)
		}
		if opts.taskVisibility == taskVisibilityHistorical {
			archived, err := tx.ListArchivedTasks()
			if err != nil {
				return fmt.Errorf("snapshot archived Tasks: %w", err)
			}
			for _, task := range archived {
				reserved, err := tx.IsIDReserved(task.ID)
				if err != nil {
					return fmt.Errorf("snapshot archived Task %q tombstone: %w", task.ID, err)
				}
				if !reserved {
					snapshot.byID[task.ID] = task
				}
			}
		}
		// Active storage wins over migration artifacts in both locations.
		for _, task := range active {
			reserved, err := tx.IsIDReserved(task.ID)
			if err != nil {
				return fmt.Errorf("snapshot active Task %q tombstone: %w", task.ID, err)
			}
			if !reserved {
				snapshot.byID[task.ID] = task
			}
		}
		return nil
	})
	if err != nil {
		return opts, err
	}
	return opts, nil
}

func taskFromSnapshot(opts SearchOptions, taskID string) (*models.Task, bool) {
	if opts.taskSnapshot == nil {
		return nil, false
	}
	task, ok := opts.taskSnapshot.byID[taskID]
	return task, ok && task != nil
}

func (e *Engine) resolveTaskVisibility(opts SearchOptions) SearchOptions {
	// A populated snapshot is a complete query boundary: keep the visibility
	// policy resolved when that snapshot was captured, including across a local
	// runtime/daemon handoff.
	if opts.taskSnapshot != nil && opts.taskVisibility != "" {
		return opts
	}
	if opts.IncludeHistorical {
		opts.taskVisibility = taskVisibilityHistorical
		return opts
	}
	if opts.Purpose == "" {
		opts.Purpose = SearchPurposeHuman
	}
	if opts.Purpose != SearchPurposeAIRetrieval {
		opts.taskVisibility = taskVisibilityHuman
		return opts
	}

	// Fail closed when project configuration is unavailable. Existing projects
	// with no lifecycle block resolve through the model's built-in defaults.
	excludeDone := true
	if e != nil && e.store != nil && e.store.Config != nil {
		if project, err := e.store.Config.Load(); err == nil {
			excludeDone = project.Settings.EffectiveTaskLifecycle().ExcludeDoneFromDefaultRetrieval
		}
	}
	if excludeDone {
		opts.taskVisibility = taskVisibilityActive
	} else {
		opts.taskVisibility = taskVisibilityHuman
	}
	return opts
}

func (e *Engine) semanticAvailableForType(searchType string) bool {
	switch searchType {
	case "memory":
		return e.memorySemanticAvailable()
	case "decision":
		return e.SemanticAvailable()
	case "", "all":
		return e.SemanticAvailable() || e.memorySemanticAvailable()
	default:
		return e.SemanticAvailable()
	}
}

func effectiveMode(mode string, semanticAvailable bool) string {
	if mode == "" {
		if semanticAvailable {
			return string(ModeHybrid)
		}
		return string(ModeKeyword)
	}
	if mode != string(ModeKeyword) && !semanticAvailable {
		return string(ModeKeyword)
	}
	return mode
}

func filterSearchResultsByType(results []models.SearchResult, searchType string) []models.SearchResult {
	if searchType == "" || searchType == "all" {
		return results
	}

	filtered := make([]models.SearchResult, 0, len(results))
	for _, result := range results {
		if result.Type == searchType {
			filtered = append(filtered, result)
		}
	}
	return filtered
}

func (e *Engine) canonicalizeTaskResults(results []models.SearchResult, opts SearchOptions) []models.SearchResult {
	if e == nil || e.store == nil || e.store.Tasks == nil {
		return results
	}
	filtered := make([]models.SearchResult, 0, len(results))
	for _, result := range results {
		if result.Type != "task" {
			filtered = append(filtered, result)
			continue
		}
		task, ok := taskFromSnapshot(opts, result.ID)
		if !ok || !taskVisibleForSearch(task, opts) || !taskMatchesSearchFilters(task, opts) {
			continue
		}
		applyTaskLifecycleToSearchResult(&result, task)
		filtered = append(filtered, result)
	}
	return filtered
}

func (e *Engine) canonicalizeRetrievalCandidates(candidates []models.RetrievalCandidate, opts SearchOptions) []models.RetrievalCandidate {
	if e == nil || e.store == nil || e.store.Tasks == nil {
		return candidates
	}
	filtered := make([]models.RetrievalCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.Type != "task" {
			filtered = append(filtered, candidate)
			continue
		}
		task, ok := taskFromSnapshot(opts, candidate.ID)
		if !ok || !taskVisibleForSearch(task, opts) || !taskMatchesSearchFilters(task, opts) {
			continue
		}
		applyTaskLifecycleToCandidate(&candidate, task)
		filtered = append(filtered, candidate)
	}
	sortRetrievalCandidates(filtered, opts.IncludeHistorical)
	return filtered
}

func taskVisibleForSearch(task *models.Task, opts SearchOptions) bool {
	if task == nil {
		return false
	}
	switch opts.taskVisibility {
	case taskVisibilityHistorical:
		return true
	case taskVisibilityActive:
		return task.LifecycleState() == models.TaskLifecycleActive
	case taskVisibilityHuman:
		return task.LifecycleState() != models.TaskLifecycleArchived
	default:
		// Unresolved options are treated as the backward-compatible human Search
		// purpose. Engine.Search and Retrieve resolve this explicitly first.
		return task.LifecycleState() != models.TaskLifecycleArchived
	}
}

func taskMatchesSearchFilters(task *models.Task, opts SearchOptions) bool {
	if opts.Status != "" && task.Status != opts.Status {
		return false
	}
	if opts.Priority != "" && task.Priority != opts.Priority {
		return false
	}
	if opts.Assignee != "" && task.Assignee != opts.Assignee {
		return false
	}
	if opts.Label != "" && !containsStr(task.Labels, opts.Label) {
		return false
	}
	return true
}

func applyTaskLifecycleToSearchResult(result *models.SearchResult, task *models.Task) {
	if result == nil || task == nil {
		return
	}
	result.Title = task.Title
	result.Status = task.Status
	result.Priority = task.Priority
	result.LifecycleState = task.LifecycleState()
	result.CompletedAt = cloneTimePointer(task.CompletedAt)
	result.ArchivedAt = cloneTimePointer(task.ArchivedAt)
}

func applyTaskLifecycleToCandidate(candidate *models.RetrievalCandidate, task *models.Task) {
	if candidate == nil || task == nil {
		return
	}
	candidate.Title = task.Title
	candidate.Status = task.Status
	candidate.Priority = task.Priority
	candidate.LifecycleState = task.LifecycleState()
	candidate.CompletedAt = cloneTimePointer(task.CompletedAt)
	candidate.ArchivedAt = cloneTimePointer(task.ArchivedAt)
	candidate.Metadata.Status = task.Status
	candidate.Metadata.Priority = task.Priority
	candidate.Metadata.LifecycleState = task.LifecycleState()
	candidate.Metadata.CompletedAt = cloneTimePointer(task.CompletedAt)
	candidate.Metadata.ArchivedAt = cloneTimePointer(task.ArchivedAt)
	candidate.Metadata.UpdatedAt = timePtr(task.UpdatedAt)
	candidate.UpdatedAt = timePtr(task.UpdatedAt)
}

func cloneTimePointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func taskLifecycleRank(state models.TaskLifecycleState) int {
	switch state {
	case models.TaskLifecycleActive:
		return 0
	case models.TaskLifecycleDone:
		return 1
	case models.TaskLifecycleArchived:
		return 2
	default:
		return 3
	}
}

func groupHistoricalTaskResults(results []models.SearchResult) {
	tasks := make([]models.SearchResult, 0, len(results))
	for _, result := range results {
		if result.Type == "task" {
			tasks = append(tasks, result)
		}
	}
	sort.SliceStable(tasks, func(i, j int) bool {
		iRank := taskLifecycleRank(tasks[i].LifecycleState)
		jRank := taskLifecycleRank(tasks[j].LifecycleState)
		if iRank != jRank {
			return iRank < jRank
		}
		if tasks[i].Score != tasks[j].Score {
			return tasks[i].Score > tasks[j].Score
		}
		return tasks[i].Title < tasks[j].Title
	})
	nextTask := 0
	for index := range results {
		if results[index].Type != "task" {
			continue
		}
		results[index] = tasks[nextTask]
		nextTask++
	}
}

func typeFilterFromSources(sourceTypes []string) string {
	if len(sourceTypes) == 1 {
		switch sourceTypes[0] {
		case "task", "doc", "memory", "decision":
			return sourceTypes[0]
		}
	}
	return "all"
}

func filterBySourceTypes(results []models.SearchResult, sourceTypes []string) []models.SearchResult {
	allowed := allowedSourceSet(sourceTypes)
	filtered := make([]models.SearchResult, 0, len(results))
	for _, result := range results {
		if allowed[result.Type] {
			filtered = append(filtered, result)
		}
	}
	return filtered
}

func (e *Engine) buildCandidates(results []models.SearchResult, opts SearchOptions) []models.RetrievalCandidate {
	candidates := make([]models.RetrievalCandidate, 0, len(results))
	for _, result := range results {
		candidate := models.RetrievalCandidate{
			Type:             result.Type,
			ID:               result.ID,
			Title:            result.Title,
			Path:             result.Path,
			Score:            result.Score,
			MatchedBy:        result.MatchedBy,
			Snippet:          result.Snippet,
			Citation:         citationFromResult(result),
			DirectMatch:      true,
			Status:           result.Status,
			Priority:         result.Priority,
			LifecycleState:   result.LifecycleState,
			CompletedAt:      cloneTimePointer(result.CompletedAt),
			ArchivedAt:       cloneTimePointer(result.ArchivedAt),
			Tags:             result.Tags,
			MemoryLayer:      result.MemoryLayer,
			Category:         result.Category,
			MemoryStore:      result.MemoryStore,
			SourcePreference: sourcePreference(result.Type),
		}
		candidate.Metadata = e.sourceRecord(result, opts)
		candidate.UpdatedAt = candidate.Metadata.UpdatedAt
		candidates = append(candidates, candidate)
	}
	sortRetrievalCandidates(candidates, opts.IncludeHistorical)
	return candidates
}

func sortRetrievalCandidates(candidates []models.RetrievalCandidate, includeHistorical bool) {
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].SourcePreference != candidates[j].SourcePreference {
			return candidates[i].SourcePreference < candidates[j].SourcePreference
		}
		if includeHistorical && candidates[i].Type == "task" && candidates[j].Type == "task" {
			iRank := taskLifecycleRank(candidates[i].LifecycleState)
			jRank := taskLifecycleRank(candidates[j].LifecycleState)
			if iRank != jRank {
				return iRank < jRank
			}
		}
		if candidates[i].Score != candidates[j].Score {
			return candidates[i].Score > candidates[j].Score
		}
		return candidates[i].Title < candidates[j].Title
	})
}

func mergeCandidates(primary []models.RetrievalCandidate, expanded []models.RetrievalCandidate, includeHistorical bool) []models.RetrievalCandidate {
	merged := append([]models.RetrievalCandidate{}, primary...)
	byKey := make(map[string]int, len(primary))
	for i, candidate := range primary {
		byKey[candidate.Type+":"+candidate.ID] = i
	}
	for _, candidate := range expanded {
		key := candidate.Type + ":" + candidate.ID
		if idx, ok := byKey[key]; ok {
			merged[idx].ExpandedFrom = appendUnique(merged[idx].ExpandedFrom, candidate.ExpandedFrom...)
			merged[idx].DirectMatch = merged[idx].DirectMatch || candidate.DirectMatch
			continue
		}
		merged = append(merged, candidate)
		byKey[key] = len(merged) - 1
	}
	sortRetrievalCandidates(merged, includeHistorical)
	return merged
}

func appendUnique(existing []string, values ...string) []string {
	seen := make(map[string]bool, len(existing))
	for _, value := range existing {
		seen[value] = true
	}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		existing = append(existing, value)
		seen[value] = true
	}
	return existing
}

func (e *Engine) buildContextPack(candidates []models.RetrievalCandidate, opts SearchOptions) []models.ContextItem {
	ordered := e.canonicalizeRetrievalCandidates(append([]models.RetrievalCandidate{}, candidates...), opts)
	sortRetrievalCandidates(ordered, opts.IncludeHistorical)

	items := make([]models.ContextItem, 0, len(ordered))
	for _, candidate := range ordered {
		content, visible := e.contextContent(candidate, opts)
		if !visible {
			continue
		}
		item := models.ContextItem{
			Type:           candidate.Type,
			ID:             candidate.ID,
			Title:          candidate.Title,
			Content:        content,
			Snippet:        candidate.Snippet,
			DirectMatch:    candidate.DirectMatch,
			ExpandedFrom:   candidate.ExpandedFrom,
			Citation:       candidate.Citation,
			LifecycleState: candidate.LifecycleState,
			CompletedAt:    cloneTimePointer(candidate.CompletedAt),
			ArchivedAt:     cloneTimePointer(candidate.ArchivedAt),
			Metadata:       candidate.Metadata,
		}
		items = append(items, item)
	}
	return items
}

func (e *Engine) contextContent(candidate models.RetrievalCandidate, opts SearchOptions) (string, bool) {
	switch candidate.Type {
	case "doc":
		doc, err := e.store.Docs.Get(candidate.ID)
		if err != nil {
			return candidate.Snippet, true
		}
		return strings.TrimSpace(strings.Join([]string{doc.Title, doc.Description, doc.Content}, "\n\n")), true
	case "task":
		task, ok := taskFromSnapshot(opts, candidate.ID)
		if !ok || !taskVisibleForSearch(task, opts) || !taskMatchesSearchFilters(task, opts) {
			return "", false
		}
		parts := []string{task.Title, task.Description}
		if task.ImplementationPlan != "" {
			parts = append(parts, task.ImplementationPlan)
		}
		if task.ImplementationNotes != "" {
			parts = append(parts, task.ImplementationNotes)
		}
		return strings.TrimSpace(strings.Join(parts, "\n\n")), true
	case "memory":
		entry, err := e.store.Memory.Get(candidate.ID)
		if err != nil {
			return candidate.Snippet, true
		}
		parts := []string{entry.Title, entry.Content}
		if entry.Category != "" {
			parts = append([]string{entry.Title + " [" + entry.Category + "]"}, entry.Content)
		}
		return strings.TrimSpace(strings.Join(parts, "\n\n")), true
	case "decision":
		decision, err := e.store.Decisions.Get(candidate.ID)
		if err != nil {
			return candidate.Snippet, true
		}
		return decisionText(decision), true
	default:
		return candidate.Snippet, true
	}
}

func citationFromResult(result models.SearchResult) models.Citation {
	citation := models.Citation{Type: result.Type, ID: result.ID}
	if result.Type == "doc" {
		citation.Path = result.Path
		citation.Section = result.Snippet
	}
	return citation
}

func sourcePreference(sourceType string) int {
	switch sourceType {
	case "doc":
		return 0
	case "decision":
		return 1
	case "task":
		return 2
	case "memory":
		return 3
	default:
		return 4
	}
}

func (e *Engine) sourceRecord(result models.SearchResult, opts SearchOptions) models.SourceRecord {
	record := models.SourceRecord{
		Type:           result.Type,
		ID:             result.ID,
		Path:           result.Path,
		Tags:           result.Tags,
		Status:         result.Status,
		Priority:       result.Priority,
		LifecycleState: result.LifecycleState,
		CompletedAt:    cloneTimePointer(result.CompletedAt),
		ArchivedAt:     cloneTimePointer(result.ArchivedAt),
		MemoryLayer:    result.MemoryLayer,
		Category:       result.Category,
		MemoryStore:    result.MemoryStore,
	}
	switch result.Type {
	case "doc":
		if doc, err := e.store.Docs.Get(result.ID); err == nil {
			record.Path = doc.Path
			record.Imported = doc.IsImported
			record.Source = doc.ImportSource
			record.UpdatedAt = timePtr(doc.UpdatedAt)
		}
	case "task":
		if task, ok := taskFromSnapshot(opts, result.ID); ok {
			record.Status = task.Status
			record.Priority = task.Priority
			record.LifecycleState = task.LifecycleState()
			record.CompletedAt = cloneTimePointer(task.CompletedAt)
			record.ArchivedAt = cloneTimePointer(task.ArchivedAt)
			record.UpdatedAt = timePtr(task.UpdatedAt)
		}
	case "memory":
		if entry, err := e.store.Memory.Get(result.ID); err == nil {
			record.UpdatedAt = timePtr(entry.UpdatedAt)
		}
	case "decision":
		if decision, err := e.store.Decisions.Get(result.ID); err == nil {
			record.Status = decision.Status
			record.Tags = decision.Tags
			record.UpdatedAt = timePtr(decision.UpdatedAt)
		}
	}
	return record
}

func timePtr(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	copy := t
	return &copy
}

func (e *Engine) expandCandidateReferences(candidates []models.RetrievalCandidate, opts models.RetrievalOptions, taskOpts SearchOptions) []models.RetrievalCandidate {
	allowed := allowedSourceSet(opts.SourceTypes)
	expanded := []models.RetrievalCandidate{}
	seen := map[string]bool{}
	for _, candidate := range candidates {
		content := e.referenceContent(candidate, taskOpts)
		for _, expandedCandidate := range e.extractReferenceCandidates(content, candidate, allowed, opts, taskOpts) {
			key := expandedCandidate.Type + ":" + expandedCandidate.ID
			if seen[key] {
				continue
			}
			seen[key] = true
			expanded = append(expanded, expandedCandidate)
		}
	}
	return expanded
}

func allowedSourceSet(sourceTypes []string) map[string]bool {
	if len(sourceTypes) == 0 {
		return map[string]bool{"doc": true, "task": true, "memory": true, "decision": true}
	}
	allowed := make(map[string]bool, len(sourceTypes))
	for _, sourceType := range sourceTypes {
		allowed[sourceType] = true
	}
	return allowed
}

func (e *Engine) referenceContent(candidate models.RetrievalCandidate, taskOpts SearchOptions) string {
	switch candidate.Type {
	case "doc":
		if doc, err := e.store.Docs.Get(candidate.ID); err == nil {
			return doc.Content
		}
	case "task":
		if task, ok := taskFromSnapshot(taskOpts, candidate.ID); ok {
			return strings.Join([]string{task.Description, task.ImplementationPlan, task.ImplementationNotes}, "\n")
		}
	case "memory":
		if entry, err := e.store.Memory.Get(candidate.ID); err == nil {
			return entry.Content
		}
	case "decision":
		if decision, err := e.store.Decisions.Get(candidate.ID); err == nil {
			return decisionText(decision)
		}
	}
	return ""
}

func (e *Engine) extractReferenceCandidates(content string, source models.RetrievalCandidate, allowed map[string]bool, opts models.RetrievalOptions, taskOpts SearchOptions) []models.RetrievalCandidate {
	var expanded []models.RetrievalCandidate
	for _, ref := range references.Extract(content) {
		if !ref.ValidRelation || !allowed[ref.Type] {
			continue
		}
		switch ref.Type {
		case "task":
			if task, ok := taskFromSnapshot(taskOpts, ref.Target); ok {
				if !taskVisibleForSearch(task, taskOpts) || !taskMatchesSearchFilters(task, taskOpts) {
					continue
				}
				candidate := models.RetrievalCandidate{
					Type:             "task",
					ID:               task.ID,
					Title:            task.Title,
					Score:            source.Score * 0.5,
					Snippet:          truncateStr(task.Description, 150),
					Citation:         models.Citation{Type: "task", ID: task.ID},
					DirectMatch:      false,
					ExpandedFrom:     []string{source.Type + ":" + source.ID},
					Status:           task.Status,
					Priority:         task.Priority,
					LifecycleState:   task.LifecycleState(),
					CompletedAt:      cloneTimePointer(task.CompletedAt),
					ArchivedAt:       cloneTimePointer(task.ArchivedAt),
					SourcePreference: sourcePreference("task"),
					Metadata: models.SourceRecord{
						Type:           "task",
						ID:             task.ID,
						Status:         task.Status,
						Priority:       task.Priority,
						LifecycleState: task.LifecycleState(),
						CompletedAt:    cloneTimePointer(task.CompletedAt),
						ArchivedAt:     cloneTimePointer(task.ArchivedAt),
						UpdatedAt:      timePtr(task.UpdatedAt),
					},
				}
				expanded = append(expanded, candidate)
			}
		case "doc":
			if doc, err := e.store.Docs.Get(ref.Target); err == nil {
				expanded = append(expanded, models.RetrievalCandidate{
					Type:             "doc",
					ID:               doc.Path,
					Title:            doc.Title,
					Path:             doc.Path,
					Score:            source.Score * 0.5,
					Snippet:          truncateStr(doc.Description, 150),
					Citation:         models.Citation{Type: "doc", ID: doc.Path, Path: doc.Path},
					DirectMatch:      false,
					ExpandedFrom:     []string{source.Type + ":" + source.ID},
					Tags:             doc.Tags,
					SourcePreference: sourcePreference("doc"),
					Metadata: models.SourceRecord{
						Type:      "doc",
						ID:        doc.Path,
						Path:      doc.Path,
						Tags:      doc.Tags,
						UpdatedAt: timePtr(doc.UpdatedAt),
						Imported:  doc.IsImported,
						Source:    doc.ImportSource,
					},
				})
			}
		case "memory":
			if entry, err := e.store.Memory.ResolveReferenceTarget(ref.Target); err == nil {
				if !memoryVisibleForSearch(entry, SearchOptions{
					Status:            opts.Status,
					IncludeHistorical: opts.IncludeHistorical,
				}) {
					continue
				}
				expanded = append(expanded, models.RetrievalCandidate{
					Type:             "memory",
					ID:               entry.ID,
					Title:            entry.Title,
					Score:            source.Score * 0.5,
					Snippet:          truncateStr(entry.Content, 150),
					Citation:         models.Citation{Type: "memory", ID: entry.ID},
					DirectMatch:      false,
					ExpandedFrom:     []string{source.Type + ":" + source.ID},
					Status:           entry.Status,
					Tags:             entry.Tags,
					MemoryLayer:      entry.Layer,
					Category:         entry.Category,
					SourcePreference: sourcePreference("memory"),
					Metadata: models.SourceRecord{
						Type:        "memory",
						ID:          entry.ID,
						Status:      entry.Status,
						Tags:        entry.Tags,
						MemoryLayer: entry.Layer,
						Category:    entry.Category,
						UpdatedAt:   timePtr(entry.UpdatedAt),
					},
				})
			}
		case "decision":
			if decision, err := e.store.Decisions.Get(ref.Target); err == nil {
				if !decisionVisibleForSearch(decision, SearchOptions{
					Status:            opts.Status,
					IncludeHistorical: opts.IncludeHistorical,
				}) {
					continue
				}
				expanded = append(expanded, models.RetrievalCandidate{
					Type:             "decision",
					ID:               decision.ID,
					Title:            decision.Title,
					Score:            source.Score * 0.5,
					Snippet:          truncateStr(decisionText(decision), 150),
					Citation:         models.Citation{Type: "decision", ID: decision.ID},
					DirectMatch:      false,
					ExpandedFrom:     []string{source.Type + ":" + source.ID},
					Status:           decision.Status,
					Tags:             decision.Tags,
					SourcePreference: sourcePreference("decision"),
					Metadata: models.SourceRecord{
						Type:      "decision",
						ID:        decision.ID,
						Status:    decision.Status,
						Tags:      decision.Tags,
						UpdatedAt: timePtr(decision.UpdatedAt),
					},
				})
			}
		}
	}
	return expanded
}

// ─── keyword search (existing logic) ─────────────────────────────────

func (e *Engine) keywordSearch(query string, opts SearchOptions) ([]models.SearchResult, error) {
	if e.lexicalBackend == nil {
		e.lexicalBackend = newBM25LexicalBackend(e.store)
	}
	return e.lexicalBackend.Search(query, opts)
}

func (e *Engine) heuristicKeywordSearch(query string, opts SearchOptions) ([]models.SearchResult, error) {
	if opts.Type == "memory" {
		return e.keywordSearchMemories(query, strings.Fields(strings.ToLower(query)), opts)
	}

	var results []models.SearchResult
	queryLower := strings.ToLower(query)
	words := strings.Fields(queryLower)

	if opts.Type == "all" || opts.Type == "task" {
		taskResults, err := e.keywordSearchTasks(queryLower, words, opts)
		if err != nil {
			return nil, err
		}
		results = append(results, taskResults...)
	}

	if opts.Type == "all" || opts.Type == "doc" {
		docResults, err := e.keywordSearchDocs(queryLower, words, opts)
		if err != nil {
			return nil, err
		}
		results = append(results, docResults...)
	}

	if opts.Type == "all" || opts.Type == "memory" {
		memResults, err := e.keywordSearchMemories(queryLower, words, opts)
		if err != nil {
			return nil, err
		}
		results = append(results, memResults...)
	}

	if opts.Type == "all" || opts.Type == "decision" {
		decisionResults, err := e.keywordSearchDecisions(queryLower, words, opts)
		if err != nil {
			return nil, err
		}
		results = append(results, decisionResults...)
	}

	return results, nil
}

func (e *Engine) keywordSearchTasks(query string, words []string, opts SearchOptions) ([]models.SearchResult, error) {
	tasks, err := tasksForSearch(e.store, opts)
	if err != nil {
		return nil, err
	}

	var results []models.SearchResult
	for _, task := range tasks {
		if !taskVisibleForSearch(task, opts) || !taskMatchesSearchFilters(task, opts) {
			continue
		}

		score := scoreTask(task, query, words)
		if score <= 0 {
			continue
		}

		snippet := extractSnippet(task.Description, query, 150)
		if snippet == "" {
			snippet = truncateStr(task.Description, 150)
		}

		result := models.SearchResult{
			Type:      "task",
			ID:        task.ID,
			Title:     task.Title,
			Score:     score,
			Snippet:   snippet,
			Status:    task.Status,
			Priority:  task.Priority,
			MatchedBy: []string{"keyword"},
		}
		applyTaskLifecycleToSearchResult(&result, task)
		results = append(results, result)
	}
	return results, nil
}

func tasksForSearch(store *storage.Store, opts SearchOptions) ([]*models.Task, error) {
	if opts.taskSnapshot != nil {
		tasks := make([]*models.Task, 0, len(opts.taskSnapshot.byID))
		for _, task := range opts.taskSnapshot.byID {
			tasks = append(tasks, task)
		}
		return tasks, nil
	}
	if store == nil || store.Tasks == nil {
		return nil, fmt.Errorf("task search store unavailable")
	}
	active, err := store.Tasks.List()
	if err != nil {
		return nil, err
	}
	if opts.taskVisibility != taskVisibilityHistorical {
		return active, nil
	}
	archived, err := store.Tasks.ListArchived()
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*models.Task, len(active)+len(archived))
	for _, task := range archived {
		byID[task.ID] = task
	}
	// An active copy wins if legacy/migration artifacts left both locations.
	for _, task := range active {
		byID[task.ID] = task
	}
	all := make([]*models.Task, 0, len(byID))
	for _, task := range byID {
		all = append(all, task)
	}
	return all, nil
}

func (e *Engine) keywordSearchDocs(query string, words []string, opts SearchOptions) ([]models.SearchResult, error) {
	docs, err := e.store.Docs.List()
	if err != nil {
		return nil, err
	}

	var results []models.SearchResult
	for _, doc := range docs {
		if opts.Tag != "" && !containsStr(doc.Tags, opts.Tag) {
			continue
		}

		score := scoreDoc(doc, query, words)
		if score <= 0 {
			continue
		}

		snippet := extractSnippet(doc.Description, query, 150)
		if snippet == "" {
			snippet = truncateStr(doc.Description, 150)
		}

		results = append(results, models.SearchResult{
			Type:      "doc",
			ID:        doc.Path,
			Title:     doc.Title,
			Score:     score,
			Snippet:   snippet,
			Path:      doc.Path,
			Tags:      doc.Tags,
			MatchedBy: []string{"keyword"},
		})
	}
	return results, nil
}

func (e *Engine) keywordSearchMemories(query string, words []string, opts SearchOptions) ([]models.SearchResult, error) {
	entries, err := e.store.Memory.List("")
	if err != nil {
		return nil, err
	}

	var results []models.SearchResult
	for _, entry := range entries {
		if !memoryVisibleForSearch(entry, opts) {
			continue
		}
		if opts.Tag != "" && !containsStr(entry.Tags, opts.Tag) {
			continue
		}

		score := scoreMemory(entry, query, words)
		if score <= 0 {
			continue
		}

		snippet := extractSnippet(entry.Content, query, 150)
		if snippet == "" {
			snippet = truncateStr(entry.Content, 150)
		}

		results = append(results, models.SearchResult{
			Type:        "memory",
			ID:          entry.ID,
			Title:       entry.Title,
			Score:       score,
			Snippet:     snippet,
			Status:      entry.Status,
			MemoryLayer: entry.Layer,
			Category:    entry.Category,
			MemoryStore: memoryStoreForLayer(entry.Layer),
			Tags:        entry.Tags,
			MatchedBy:   []string{"keyword"},
		})
	}
	return results, nil
}

func (e *Engine) keywordSearchDecisions(query string, words []string, opts SearchOptions) ([]models.SearchResult, error) {
	decisions, err := e.store.Decisions.List()
	if err != nil {
		return nil, err
	}

	var results []models.SearchResult
	for _, decision := range decisions {
		if !decisionVisibleForSearch(decision, opts) {
			continue
		}
		if opts.Tag != "" && !containsStr(decision.Tags, opts.Tag) {
			continue
		}

		score := scoreDecision(decision, query, words)
		if score <= 0 {
			continue
		}

		snippet := extractSnippet(decisionText(decision), query, 150)
		if snippet == "" {
			snippet = truncateStr(decisionText(decision), 150)
		}

		results = append(results, models.SearchResult{
			Type:      "decision",
			ID:        decision.ID,
			Title:     decision.Title,
			Score:     score,
			Snippet:   snippet,
			Status:    decision.Status,
			Tags:      decision.Tags,
			MatchedBy: []string{"keyword"},
		})
	}
	return results, nil
}

// keywordSearchCode searches code chunks stored in SQLite for keyword matches.
// This is used when type="code" or type="all" in keyword-only mode.
func (e *Engine) keywordSearchCode(queryLower string, words []string, opts SearchOptions) ([]models.SearchResult, error) {
	db := e.store.SemanticDB()
	if db == nil {
		return nil, nil
	}
	defer db.Close()

	// Check if code index exists
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM chunks WHERE type = 'code'").Scan(&count); err != nil || count == 0 {
		return nil, nil
	}

	rows, err := db.Query(`
		SELECT id, doc_path, field, content
		FROM chunks
		WHERE type = 'code'
		LIMIT 500
	`)
	if err != nil {
		return nil, nil
	}
	defer rows.Close()

	var results []models.SearchResult
	for rows.Next() {
		var id, docPath, field, content string
		if err := rows.Scan(&id, &docPath, &field, &content); err != nil {
			continue
		}
		// Keyword match on content
		contentLower := strings.ToLower(content)
		score := float64(0)
		for _, word := range words {
			if strings.Contains(contentLower, word) {
				score += 0.1
			}
		}
		if score <= 0 {
			continue
		}
		snippet := extractSnippet(content, queryLower, 150)
		results = append(results, models.SearchResult{
			Type:      "code",
			ID:        id,
			Title:     field,
			Score:     score,
			Path:      docPath,
			Snippet:   snippet,
			MatchedBy: []string{"keyword"},
		})
	}
	return results, nil
}

// ─── semantic search ─────────────────────────────────────────────────

func (e *Engine) semanticSearch(query string, opts SearchOptions) ([]models.SearchResult, error) {
	if opts.Type == "memory" {
		return e.semanticMemorySearch(query, opts)
	}
	if e.embedder == nil || e.vecStore == nil {
		return nil, fmt.Errorf("semantic search is not available")
	}
	queryVec, err := e.embedder.EmbedQuery(query)
	if err != nil {
		return nil, err
	}

	topK := opts.Limit * 2
	if opts.Type == "" || opts.Type == "all" || opts.Type == "task" {
		// Task lifecycle is canonical-file state, not trusted index metadata. Scan
		// the available vector candidates so stale historical chunks cannot crowd
		// active Tasks out before canonical filtering.
		topK = e.vecStore.Count()
	}
	scored := e.vecStore.Search(queryVec, VectorSearchOpts{
		TopK:      topK,
		Threshold: 0.3,
		ChunkType: chunkTypeForSearchType(opts.Type),
	})

	return e.scoredChunksToResults(scored, opts, "semantic", query)
}

// ─── hybrid search ───────────────────────────────────────────────────

func (e *Engine) hybridSearch(query string, opts SearchOptions) ([]models.SearchResult, error) {
	if opts.Type == "memory" {
		return e.hybridMemorySearch(query, opts)
	}
	// Run both in sequence (could be parallel, but for simplicity).
	kwResults, err := e.keywordSearch(query, opts)
	if err != nil {
		return nil, err
	}

	semResults, err := e.semanticSearch(query, opts)
	if err != nil {
		// Fall back to keyword only.
		return kwResults, nil
	}

	// Merge results.
	merged := mergeResults(kwResults, semResults, 0)
	return e.rerank(merged, query, 0, opts), nil
}

func (e *Engine) memorySemanticAvailable() bool {
	stores, err := initMemorySemanticStores(e.store)
	if err != nil {
		return false
	}
	defer closeMemorySemanticStores(stores)
	for _, store := range stores {
		if store.engine != nil && store.engine.SemanticAvailable() {
			return true
		}
	}
	return false
}

func (e *Engine) semanticMemorySearch(query string, opts SearchOptions) ([]models.SearchResult, error) {
	stores, err := initMemorySemanticStores(e.store)
	if err != nil {
		return nil, err
	}
	defer closeMemorySemanticStores(stores)

	var merged []models.SearchResult
	for _, semStore := range stores {
		if semStore.engine == nil || !semStore.engine.SemanticAvailable() {
			continue
		}
		results, err := semStore.engine.semanticSearchSingleStore(query, opts, semStore.memoryLayer, semStore.storeName)
		if err != nil {
			continue
		}
		merged = append(merged, results...)
	}
	return mergeStoreMemoryResults(merged, opts.Limit), nil
}

func (e *Engine) hybridMemorySearch(query string, opts SearchOptions) ([]models.SearchResult, error) {
	kwResults, err := e.keywordSearch(query, opts)
	if err != nil {
		return nil, err
	}
	semResults, err := e.semanticMemorySearch(query, opts)
	if err != nil {
		return kwResults, nil
	}
	merged := mergeResults(kwResults, semResults, opts.Limit*2)
	return e.rerank(merged, query, opts.Limit, opts), nil
}

func (e *Engine) semanticSearchSingleStore(query string, opts SearchOptions, memoryLayer string, memoryStore string) ([]models.SearchResult, error) {
	if e.embedder == nil || e.vecStore == nil {
		return nil, fmt.Errorf("semantic search is not available")
	}
	queryVec, err := e.embedder.EmbedQuery(query)
	if err != nil {
		return nil, err
	}
	scored := e.vecStore.Search(queryVec, VectorSearchOpts{
		TopK:      opts.Limit * 2,
		Threshold: 0.3,
		ChunkType: ChunkTypeMemory,
	})
	results, err := e.scoredChunksToResults(scored, opts, "semantic", query)
	if err != nil {
		return nil, err
	}
	for i := range results {
		results[i].MemoryLayer = memoryLayer
		results[i].MemoryStore = memoryStore
	}
	return results, nil
}

type memorySemanticStore struct {
	engine      *Engine
	store       *storage.Store
	session     *SemanticSession
	memoryLayer string
	storeName   string
}

func initMemorySemanticStores(projectStore *storage.Store) ([]memorySemanticStore, error) {
	stores := make([]memorySemanticStore, 0, 2)
	if projectStore == nil {
		return stores, nil
	}
	if session, err := InitSemanticRuntimeSession(projectStore); err == nil && session != nil && session.Embedder != nil && session.VecStore != nil {
		stores = append(stores, memorySemanticStore{
			engine:      session.Engine(projectStore),
			store:       projectStore,
			session:     session,
			memoryLayer: models.MemoryLayerProject,
			storeName:   memoryStoreProject,
		})
	}
	globalStore := storage.NewGlobalSemanticStore()
	if session, err := InitSemanticRuntimeSession(globalStore); err == nil && session != nil && session.Embedder != nil && session.VecStore != nil {
		stores = append(stores, memorySemanticStore{
			engine:      session.Engine(globalStore),
			store:       globalStore,
			session:     session,
			memoryLayer: models.MemoryLayerGlobal,
			storeName:   memoryStoreGlobal,
		})
	}
	return stores, nil
}

func closeMemorySemanticStores(stores []memorySemanticStore) {
	for _, semStore := range stores {
		if semStore.session != nil {
			_ = semStore.session.Close()
		}
	}
}

func mergeStoreMemoryResults(results []models.SearchResult, limit int) []models.SearchResult {
	if len(results) == 0 {
		return nil
	}
	byKey := make(map[string]models.SearchResult, len(results))
	for _, result := range results {
		key := result.Type + ":" + result.ID + ":" + result.MemoryStore
		if existing, ok := byKey[key]; ok && existing.Score >= result.Score {
			continue
		}
		byKey[key] = result
	}
	merged := make([]models.SearchResult, 0, len(byKey))
	for _, result := range byKey {
		merged = append(merged, result)
	}
	sort.Slice(merged, func(i, j int) bool {
		if merged[i].Score != merged[j].Score {
			return merged[i].Score > merged[j].Score
		}
		return merged[i].Title < merged[j].Title
	})
	if limit > 0 && len(merged) > limit {
		merged = merged[:limit]
	}
	return merged
}

func memoryStoreForLayer(layer string) string {
	if layer == models.MemoryLayerGlobal {
		return memoryStoreGlobal
	}
	return memoryStoreProject
}

func resultMergeKey(result models.SearchResult) string {
	if result.Type == "memory" && result.MemoryStore != "" {
		return result.Type + ":" + result.ID + ":" + result.MemoryStore
	}
	return result.Type + ":" + result.ID
}

func chunkTypeForSearchType(searchType string) ChunkType {
	switch searchType {
	case "memory":
		return ChunkTypeMemory
	case "task":
		return ChunkTypeTask
	case "doc":
		return ChunkTypeDoc
	case "decision":
		return ChunkTypeDecision
	default:
		return ""
	}
}

// mergeResults combines keyword and semantic results using Reciprocal Rank Fusion (RRF).
func mergeResults(kwResults, semResults []models.SearchResult, limit int) []models.SearchResult {
	const k = 60.0 // RRF constant — standard value from literature

	// Sort each list by score descending to establish ranks.
	sort.Slice(kwResults, func(i, j int) bool { return kwResults[i].Score > kwResults[j].Score })
	sort.Slice(semResults, func(i, j int) bool { return semResults[i].Score > semResults[j].Score })

	type mergedItem struct {
		result    models.SearchResult
		rrfScore  float64
		matchedBy []string
	}

	merged := make(map[string]*mergedItem)

	// Add keyword results with RRF scores.
	for rank, r := range kwResults {
		key := resultMergeKey(r)
		merged[key] = &mergedItem{
			result:    r,
			rrfScore:  1.0 / (k + float64(rank+1)),
			matchedBy: []string{"keyword"},
		}
	}

	// Add semantic results with RRF scores.
	for rank, r := range semResults {
		key := resultMergeKey(r)
		rrfScore := 1.0 / (k + float64(rank+1))
		if item, ok := merged[key]; ok {
			item.rrfScore += rrfScore
			item.matchedBy = []string{"semantic", "keyword"}
		} else {
			merged[key] = &mergedItem{
				result:    r,
				rrfScore:  rrfScore,
				matchedBy: []string{"semantic"},
			}
		}
	}

	// Compute final scores normalized to 0-1.
	maxRRF := 0.0
	for _, item := range merged {
		if item.rrfScore > maxRRF {
			maxRRF = item.rrfScore
		}
	}

	var results []models.SearchResult
	for _, item := range merged {
		if maxRRF > 0 {
			item.result.Score = item.rrfScore / maxRRF
		}
		item.result.MatchedBy = item.matchedBy
		results = append(results, item.result)
	}

	sort.Slice(results, func(i, j int) bool {
		return results[i].Score > results[j].Score
	})

	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}

	return results
}

// scoredChunksToResults converts vector search results back to SearchResults.
// Uses multi-chunk scoring: aggregates top-3 chunk scores per source for better ranking.
func (e *Engine) scoredChunksToResults(scored []ScoredChunk, opts SearchOptions, method string, query string) ([]models.SearchResult, error) {
	type sourceResult struct {
		result models.SearchResult
		scores []float64 // all chunk scores for this source
	}
	seen := make(map[string]*sourceResult)

	for _, sc := range scored {
		var key string
		var result models.SearchResult

		// Tree-aware scoring: boost doc chunks whose HeaderPath matches query words.
		chunkScore := sc.Score
		if sc.Type == ChunkTypeDoc && sc.HeaderPath != "" {
			headerLower := strings.ToLower(sc.HeaderPath)
			queryWords := strings.Fields(strings.ToLower(query))
			matchCount := 0
			for _, w := range queryWords {
				if strings.Contains(headerLower, w) {
					matchCount++
				}
			}
			if matchCount > 0 {
				// Boost proportional to how many query words match the heading path.
				ratio := float64(matchCount) / float64(len(queryWords))
				chunkScore += ratio * 0.15 // up to 15% boost for full path match
			}
		}

		switch sc.Type {
		case ChunkTypeTask:
			key = "task:" + sc.TaskID
			if opts.Type != "" && opts.Type != "all" && opts.Type != "task" {
				continue
			}
			task, ok := taskFromSnapshot(opts, sc.TaskID)
			if !ok || !taskVisibleForSearch(task, opts) || !taskMatchesSearchFilters(task, opts) {
				continue
			}

			result = models.SearchResult{
				Type:      "task",
				ID:        sc.TaskID,
				Title:     task.Title,
				Score:     chunkScore,
				Status:    task.Status,
				Priority:  task.Priority,
				MatchedBy: []string{method},
			}
			applyTaskLifecycleToSearchResult(&result, task)

		case ChunkTypeDoc:
			key = "doc:" + sc.DocPath

			if opts.Tag != "" {
				if doc, err := e.store.Docs.Get(sc.DocPath); err != nil || !containsStr(doc.Tags, opts.Tag) {
					continue
				}
			}
			if opts.Type != "" && opts.Type != "all" && opts.Type != "doc" {
				continue
			}

			title := sc.DocPath
			var tags []string
			if doc, err := e.store.Docs.Get(sc.DocPath); err == nil {
				title = doc.Title
				tags = doc.Tags
			}

			result = models.SearchResult{
				Type:      "doc",
				ID:        sc.DocPath,
				Title:     title,
				Score:     chunkScore,
				Path:      sc.DocPath,
				Tags:      tags,
				Snippet:   sc.Section,
				MatchedBy: []string{method},
			}

		case ChunkTypeMemory:
			key = "memory:" + sc.MemoryID + ":" + sc.MemoryStore

			if opts.Type != "" && opts.Type != "all" && opts.Type != "memory" {
				continue
			}

			title := sc.MemoryID
			memLayer := sc.MemoryLayer
			memStore := sc.MemoryStore
			memStatus := ""
			var category string
			var tags []string
			if entry, err := e.memoryEntryForChunk(sc); err == nil {
				if !memoryVisibleForSearch(entry, opts) {
					continue
				}
				title = entry.Title
				memLayer = entry.Layer
				memStatus = entry.Status
				category = entry.Category
				tags = entry.Tags
			}
			if memStore == "" {
				memStore = memoryStoreForLayer(memLayer)
			}

			result = models.SearchResult{
				Type:        "memory",
				ID:          sc.MemoryID,
				Title:       title,
				Score:       chunkScore,
				Status:      memStatus,
				MemoryLayer: memLayer,
				Category:    category,
				MemoryStore: memStore,
				Tags:        tags,
				MatchedBy:   []string{method},
			}

		case ChunkTypeDecision:
			key = "decision:" + sc.DecisionID

			if opts.Type != "" && opts.Type != "all" && opts.Type != "decision" {
				continue
			}

			title := sc.DecisionID
			decisionStatus := sc.Status
			var tags []string
			if decision, err := e.store.Decisions.Get(sc.DecisionID); err == nil {
				if !decisionVisibleForSearch(decision, opts) {
					continue
				}
				title = decision.Title
				decisionStatus = decision.Status
				tags = decision.Tags
			}

			result = models.SearchResult{
				Type:      "decision",
				ID:        sc.DecisionID,
				Title:     title,
				Score:     chunkScore,
				Status:    decisionStatus,
				Tags:      tags,
				MatchedBy: []string{method},
			}

		case ChunkTypeCode:
			continue

		default:
			continue
		}

		if existing, ok := seen[key]; ok {
			existing.scores = append(existing.scores, chunkScore)
			// Keep the result with the best snippet.
			if chunkScore > existing.result.Score {
				existing.result = result
			}
		} else {
			seen[key] = &sourceResult{result: result, scores: []float64{chunkScore}}
		}
	}

	// Aggregate scores: best + decay bonus from additional chunks.
	results := make([]models.SearchResult, 0, len(seen))
	for _, sr := range seen {
		sort.Float64s(sr.scores)
		// Reverse to descending.
		for i, j := 0, len(sr.scores)-1; i < j; i, j = i+1, j-1 {
			sr.scores[i], sr.scores[j] = sr.scores[j], sr.scores[i]
		}

		finalScore := sr.scores[0] // best chunk
		// Add decayed bonus from top-3 additional chunks.
		for i := 1; i < len(sr.scores) && i < 3; i++ {
			finalScore += sr.scores[i] * 0.1 // 10% bonus per additional relevant chunk
		}

		sr.result.Score = finalScore
		results = append(results, sr.result)
	}
	return results, nil
}

func (e *Engine) memoryEntryForChunk(sc ScoredChunk) (*models.MemoryEntry, error) {
	if e.store == nil || e.store.Memory == nil {
		return nil, fmt.Errorf("memory store unavailable")
	}
	if sc.MemoryLayer != "" {
		if entry, err := e.store.Memory.GetInLayer(sc.MemoryID, sc.MemoryLayer); err == nil {
			return entry, nil
		}
	}
	if sc.MemoryStore == memoryStoreGlobal {
		return e.store.Memory.GetInLayer(sc.MemoryID, models.MemoryLayerGlobal)
	}
	return e.store.Memory.Get(sc.MemoryID)
}

func memoryVisibleForSearch(entry *models.MemoryEntry, opts SearchOptions) bool {
	if entry == nil {
		return false
	}
	if opts.Status != "" && models.ValidMemoryStatus(opts.Status) {
		return entry.Status == opts.Status
	}
	if opts.IncludeHistorical {
		return true
	}
	return entry.CurrentForDefaultRetrieval()
}

func decisionVisibleForSearch(decision *models.DecisionEntry, opts SearchOptions) bool {
	if decision == nil {
		return false
	}
	if opts.Status != "" && models.ValidDecisionStatus(opts.Status) {
		return decision.Status == opts.Status
	}
	if opts.IncludeHistorical {
		return true
	}
	return decision.CurrentForDefaultRetrieval()
}

// ─── scoring helpers ──────────────────────────────────────────────────

// wordBoundaryCount counts whole-word matches of query in text (case-insensitive).
func wordBoundaryCount(text, word string) int {
	re, err := regexp.Compile(`(?i)\b` + regexp.QuoteMeta(word) + `\b`)
	if err != nil {
		return 0
	}
	return len(re.FindAllStringIndex(text, -1))
}

// phraseMatch checks if the exact phrase appears in text (case-insensitive).
func phraseMatch(text, phrase string) bool {
	re, err := regexp.Compile(`(?i)\b` + regexp.QuoteMeta(phrase) + `\b`)
	if err != nil {
		return strings.Contains(strings.ToLower(text), strings.ToLower(phrase))
	}
	return re.MatchString(text)
}

func scoreTask(task *models.Task, query string, words []string) float64 {
	score := 0.0
	titleLower := strings.ToLower(task.Title)
	idLower := strings.ToLower(task.ID)
	descLower := strings.ToLower(task.Description)
	planLower := strings.ToLower(task.ImplementationPlan)
	notesLower := strings.ToLower(task.ImplementationNotes)

	// Exact phrase match (word-boundary aware).
	if phraseMatch(task.Title, query) {
		if titleLower == query {
			score += 100
		} else {
			score += 60
		}
	} else if strings.Contains(titleLower, query) {
		score += 30 // substring only
	}

	if strings.Contains(idLower, query) {
		score += 30
	}

	if phraseMatch(task.Description, query) {
		score += 25
	} else if strings.Contains(descLower, query) {
		score += 15
	}

	if strings.Contains(planLower, query) {
		score += 15
	}
	if strings.Contains(notesLower, query) {
		score += 15
	}
	for _, label := range task.Labels {
		if strings.Contains(strings.ToLower(label), query) {
			score += 10
		}
	}
	for _, ac := range task.AcceptanceCriteria {
		if strings.Contains(strings.ToLower(ac.Text), query) {
			score += 5
		}
	}

	// Per-word scoring with word-boundary boost.
	if len(words) > 1 {
		wordScore := 0.0
		for _, w := range words {
			if wordBoundaryCount(task.Title, w) > 0 {
				wordScore += 2.0
			} else if strings.Contains(titleLower, w) {
				wordScore += 0.5
			}
			if wordBoundaryCount(task.Description, w) > 0 {
				wordScore += 1.0
			} else if strings.Contains(descLower, w) {
				wordScore += 0.3
			}
		}
		score += wordScore / float64(len(words)) * 20
	}
	return score
}

func scoreDoc(doc *models.Doc, query string, words []string) float64 {
	score := 0.0
	titleLower := strings.ToLower(doc.Title)
	descLower := strings.ToLower(doc.Description)
	contentLower := strings.ToLower(doc.Content)
	pathLower := strings.ToLower(doc.Path)

	// Exact phrase match (word-boundary aware).
	if phraseMatch(doc.Title, query) {
		if titleLower == query {
			score += 100
		} else {
			score += 60
		}
	} else if strings.Contains(titleLower, query) {
		score += 30
	}

	if strings.Contains(pathLower, query) {
		score += 25
	}

	if phraseMatch(doc.Description, query) {
		score += 25
	} else if strings.Contains(descLower, query) {
		score += 15
	}

	// Search in doc content.
	if phraseMatch(doc.Content, query) {
		score += 20
	} else if strings.Contains(contentLower, query) {
		score += 10
	}

	for _, tag := range doc.Tags {
		if strings.Contains(strings.ToLower(tag), query) {
			score += 10
		}
	}

	// Per-word scoring with word-boundary boost.
	if len(words) > 1 {
		wordScore := 0.0
		for _, w := range words {
			if wordBoundaryCount(doc.Title, w) > 0 {
				wordScore += 2.0
			} else if strings.Contains(titleLower, w) {
				wordScore += 0.5
			}
			if wordBoundaryCount(doc.Content, w) > 0 {
				wordScore += 1.0
			} else if strings.Contains(contentLower, w) {
				wordScore += 0.3
			}
		}
		score += wordScore / float64(len(words)) * 20
	}
	return score
}

func extractSnippet(text, query string, maxLen int) string {
	if text == "" || query == "" {
		return ""
	}
	lower := strings.ToLower(text)
	idx := strings.Index(lower, query)
	if idx < 0 {
		return ""
	}
	start := int(math.Max(0, float64(idx-40)))
	end := int(math.Min(float64(len(text)), float64(idx+len(query)+maxLen-40)))
	snippet := text[start:end]
	if start > 0 {
		snippet = "..." + snippet
	}
	if end < len(text) {
		snippet = snippet + "..."
	}
	return snippet
}

func truncateStr(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	if maxLen <= 3 {
		return s[:maxLen]
	}
	return s[:maxLen-3] + "..."
}

func containsStr(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

func scoreMemory(entry *models.MemoryEntry, query string, words []string) float64 {
	score := 0.0
	titleLower := strings.ToLower(entry.Title)
	contentLower := strings.ToLower(entry.Content)
	categoryLower := strings.ToLower(entry.Category)

	if phraseMatch(entry.Title, query) {
		if titleLower == query {
			score += 100
		} else {
			score += 60
		}
	} else if strings.Contains(titleLower, query) {
		score += 30
	}

	if strings.Contains(categoryLower, query) {
		score += 20
	}

	if phraseMatch(entry.Content, query) {
		score += 20
	} else if strings.Contains(contentLower, query) {
		score += 10
	}

	for _, tag := range entry.Tags {
		if strings.Contains(strings.ToLower(tag), query) {
			score += 10
		}
	}

	if len(words) > 1 {
		wordScore := 0.0
		for _, w := range words {
			if wordBoundaryCount(entry.Title, w) > 0 {
				wordScore += 2.0
			} else if strings.Contains(titleLower, w) {
				wordScore += 0.5
			}
			if wordBoundaryCount(entry.Content, w) > 0 {
				wordScore += 1.0
			} else if strings.Contains(contentLower, w) {
				wordScore += 0.3
			}
		}
		score += wordScore / float64(len(words)) * 20
	}
	return score
}

func scoreDecision(entry *models.DecisionEntry, query string, words []string) float64 {
	text := decisionText(entry)
	score := 0.0
	titleLower := strings.ToLower(entry.Title)
	textLower := strings.ToLower(text)

	if phraseMatch(entry.Title, query) {
		if titleLower == query {
			score += 100
		} else {
			score += 60
		}
	} else if strings.Contains(titleLower, query) {
		score += 30
	}

	if phraseMatch(text, query) {
		score += 20
	} else if strings.Contains(textLower, query) {
		score += 10
	}

	for _, tag := range entry.Tags {
		if strings.Contains(strings.ToLower(tag), query) {
			score += 10
		}
	}

	if len(words) > 1 {
		wordScore := 0.0
		for _, w := range words {
			if wordBoundaryCount(entry.Title, w) > 0 {
				wordScore += 2.0
			} else if strings.Contains(titleLower, w) {
				wordScore += 0.5
			}
			if wordBoundaryCount(text, w) > 0 {
				wordScore += 1.0
			} else if strings.Contains(textLower, w) {
				wordScore += 0.3
			}
		}
		score += wordScore / float64(len(words)) * 20
	}
	return score
}

// ─── heuristic reranker ─────────────────────────────────────────────

// rerank applies heuristic signals on top of RRF scores to improve ranking.
func (e *Engine) rerank(results []models.SearchResult, query string, limit int, opts SearchOptions) []models.SearchResult {
	if len(results) == 0 {
		return results
	}

	queryLower := strings.ToLower(query)
	words := strings.Fields(queryLower)
	now := time.Now()

	type scored struct {
		result   models.SearchResult
		rrfScore float64
		bonus    float64
	}

	items := make([]scored, len(results))
	for i, r := range results {
		items[i] = scored{result: r, rrfScore: r.Score}
	}

	for i := range items {
		r := items[i].result
		bonus := 0.0

		switch r.Type {
		case "task":
			task, ok := taskFromSnapshot(opts, r.ID)
			if !ok {
				break
			}

			// Keyword density in title.
			titleLower := strings.ToLower(task.Title)
			for _, w := range words {
				bonus += float64(wordBoundaryCount(task.Title, w)) * 0.03
			}

			// Exact title match.
			if phraseMatch(task.Title, query) {
				bonus += 0.15
			} else if strings.Contains(titleLower, queryLower) {
				bonus += 0.05
			}

			// Label overlap with query words.
			for _, label := range task.Labels {
				labelLower := strings.ToLower(label)
				for _, w := range words {
					if labelLower == w {
						bonus += 0.05
					}
				}
			}

			// Recency: tasks updated within 7 days get a boost.
			age := now.Sub(task.UpdatedAt).Hours() / 24
			if age < 7 {
				bonus += 0.05 * (1 - age/7)
			}

		case "doc":
			doc, err := e.store.Docs.Get(r.ID)
			if err != nil {
				break
			}

			// Keyword density in title.
			titleLower := strings.ToLower(doc.Title)
			for _, w := range words {
				bonus += float64(wordBoundaryCount(doc.Title, w)) * 0.03
			}

			// Exact title match.
			if phraseMatch(doc.Title, query) {
				bonus += 0.15
			} else if strings.Contains(titleLower, queryLower) {
				bonus += 0.05
			}

			// Tag overlap with query words.
			for _, tag := range doc.Tags {
				tagLower := strings.ToLower(tag)
				for _, w := range words {
					if tagLower == w {
						bonus += 0.08
					}
				}
			}

			// Keyword density in content (capped).
			for _, w := range words {
				count := wordBoundaryCount(doc.Content, w)
				if count > 10 {
					count = 10
				}
				bonus += float64(count) * 0.005
			}

			// Recency.
			age := now.Sub(doc.UpdatedAt).Hours() / 24
			if age < 7 {
				bonus += 0.05 * (1 - age/7)
			}
		}

		items[i].bonus = bonus
	}

	// Combine: reranked score = rrfScore + bonus (capped at 0.3 to not overwhelm RRF).
	for i := range items {
		b := items[i].bonus
		if b > 0.3 {
			b = 0.3
		}
		items[i].result.Score = items[i].rrfScore + b
	}

	// Re-normalize to 0-1.
	maxScore := 0.0
	for _, it := range items {
		if it.result.Score > maxScore {
			maxScore = it.result.Score
		}
	}

	out := make([]models.SearchResult, len(items))
	for i, it := range items {
		if maxScore > 0 {
			it.result.Score = it.result.Score / maxScore
		}
		out[i] = it.result
	}

	sort.Slice(out, func(i, j int) bool {
		return out[i].Score > out[j].Score
	})

	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}

	return out
}

// Reindex rebuilds the search index using the index service.
// Returns an error if semantic search is not available.
func (e *Engine) Reindex(progress ReindexProgress) error {
	if e.embedder == nil || e.vecStore == nil {
		return fmt.Errorf("semantic search is not available (no ONNX Runtime)")
	}
	svc := NewIndexService(e.store, e.embedder, e.vecStore)
	return svc.Reindex(progress)
}
