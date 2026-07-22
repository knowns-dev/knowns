package search

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

type RuntimeMetadata struct {
	Degraded bool   `json:"degraded,omitempty"`
	Mode     string `json:"mode,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Message  string `json:"message,omitempty"`
}

type RuntimeSearchResponse struct {
	Results []models.SearchResult `json:"results"`
	Runtime *RuntimeMetadata      `json:"_runtime,omitempty"`
}

type semanticSearchRuntimeRequest struct {
	Options         SearchOptions  `json:"options"`
	TaskSnapshot    []*models.Task `json:"taskSnapshot,omitempty"`
	HasTaskSnapshot bool           `json:"hasTaskSnapshot,omitempty"`
	TaskVisibility  string         `json:"taskVisibility,omitempty"`
}

func SearchWithRuntime(store *storage.Store, opts SearchOptions) (*RuntimeSearchResponse, error) {
	mode := SearchMode(opts.Mode)
	if mode == "" {
		mode = ModeHybrid
		opts.Mode = string(mode)
	}
	if mode == ModeKeyword {
		results, err := NewEngine(store, nil, nil).Search(opts)
		return &RuntimeSearchResponse{Results: results}, err
	}
	if runtimequeue.ShouldBypassDaemon() {
		return searchWithLocalRuntime(store, opts)
	}
	if !SemanticRuntimeEnabled() {
		return searchWithLocalRuntime(store, opts)
	}
	available, err := semanticIndexAvailableForRuntime(store, opts.Type)
	if err != nil {
		return semanticUnavailableResponse(store, opts, mode, err)
	}
	if !available {
		return semanticUnavailableResponse(store, opts, mode, fmt.Errorf("semantic index is empty or unavailable"))
	}
	return searchWithDaemonRuntime(store, opts)
}

func searchWithDaemonRuntime(store *storage.Store, opts SearchOptions) (*RuntimeSearchResponse, error) {
	if store == nil {
		return nil, semanticRuntimeSearchError(ErrSemanticNotConfigured)
	}
	requestID, err := writeSemanticSearchRuntimeRequest(semanticSearchRuntimeRequest{
		Options:         opts,
		TaskSnapshot:    taskSnapshotValues(opts.taskSnapshot),
		HasTaskSnapshot: opts.taskSnapshot != nil,
		TaskVisibility:  string(opts.taskVisibility),
	})
	if err != nil {
		return nil, err
	}
	defer os.Remove(semanticSearchRuntimeRequestPath(requestID))

	job, err := runtimequeue.Enqueue(store.Root, runtimequeue.JobSemanticSearch, requestID)
	if err != nil {
		return nil, err
	}
	result, err := runtimequeue.WaitForJob(store.Root, job.ID, 2*time.Minute)
	if err != nil {
		return nil, err
	}
	if result.Details == nil || len(result.Details.Result) == 0 {
		return nil, fmt.Errorf("semantic runtime returned empty result")
	}
	var response RuntimeSearchResponse
	if err := json.Unmarshal(result.Details.Result, &response); err != nil {
		return nil, fmt.Errorf("decode semantic runtime result: %w", err)
	}
	if response.Results == nil {
		response.Results = []models.SearchResult{}
	}
	return &response, nil
}

func searchWithLocalRuntime(store *storage.Store, opts SearchOptions) (*RuntimeSearchResponse, error) {
	mode := SearchMode(opts.Mode)
	if mode == "" {
		mode = ModeHybrid
		opts.Mode = string(mode)
	}
	if mode == ModeKeyword {
		results, err := NewEngine(store, nil, nil).Search(opts)
		return &RuntimeSearchResponse{Results: results}, err
	}
	if SemanticRuntimeEnabled() {
		available, err := semanticIndexAvailableForRuntime(store, opts.Type)
		if err != nil {
			return semanticUnavailableResponse(store, opts, mode, err)
		}
		if !available {
			return semanticUnavailableResponse(store, opts, mode, fmt.Errorf("semantic index is empty or unavailable"))
		}
	}

	session, err := InitSemanticRuntimeSession(store)
	if err != nil {
		return semanticUnavailableResponse(store, opts, mode, err)
	}
	defer session.Close()

	engine := session.Engine(store)
	if mode == ModeSemantic && !engine.semanticAvailableForType(opts.Type) {
		return nil, semanticRuntimeSearchError(fmt.Errorf("semantic index is empty or unavailable"))
	}
	if mode == ModeHybrid && !engine.semanticAvailableForType(opts.Type) {
		results, err := keywordFallback(store, opts)
		if err != nil {
			return nil, err
		}
		meta := degradedRuntimeMetadata(mode, fmt.Errorf("semantic index is empty or unavailable"))
		return &RuntimeSearchResponse{
			Results: attachRuntimeWarning(results, meta),
			Runtime: meta,
		}, nil
	}
	results, err := engine.Search(opts)
	return &RuntimeSearchResponse{Results: results}, err
}

func semanticUnavailableResponse(store *storage.Store, opts SearchOptions, mode SearchMode, err error) (*RuntimeSearchResponse, error) {
	if mode == ModeSemantic {
		return nil, semanticRuntimeSearchError(err)
	}
	results, kwErr := keywordFallback(store, opts)
	if kwErr != nil {
		return nil, kwErr
	}
	meta := degradedRuntimeMetadata(mode, err)
	return &RuntimeSearchResponse{
		Results: attachRuntimeWarning(results, meta),
		Runtime: meta,
	}, nil
}

func attachRuntimeWarning(results []models.SearchResult, meta *RuntimeMetadata) []models.SearchResult {
	if meta == nil {
		return results
	}
	warning := &models.RuntimeWarning{
		Degraded: meta.Degraded,
		Mode:     meta.Mode,
		Reason:   meta.Reason,
		Message:  meta.Message,
	}
	for i := range results {
		results[i].Runtime = warning
	}
	return results
}

func semanticIndexAvailableForRuntime(store *storage.Store, searchType string) (bool, error) {
	cfg, err := loadSemanticRuntimeConfig(store)
	if err != nil {
		return false, err
	}
	if searchType != "memory" {
		available, err := semanticIndexMetadataAvailable(store, cfg, chunkTypesForRuntimePreflight(searchType))
		if err != nil {
			return false, err
		}
		if available {
			return true, nil
		}
	}
	if searchType == "memory" || searchType == "" || searchType == "all" {
		if memorySemanticIndexAvailable(store) {
			return true, nil
		}
		if memorySemanticIndexAvailable(storage.NewGlobalSemanticStore()) {
			return true, nil
		}
	}
	return false, nil
}

func memorySemanticIndexAvailable(store *storage.Store) bool {
	if store == nil {
		return false
	}
	cfg, err := loadSemanticRuntimeConfig(store)
	if err != nil {
		return false
	}
	available, err := semanticIndexMetadataAvailable(store, cfg, []ChunkType{ChunkTypeMemory})
	if err != nil {
		return false
	}
	return available
}

func semanticIndexMetadataAvailable(store *storage.Store, cfg semanticRuntimeConfig, chunkTypes []ChunkType) (bool, error) {
	if store == nil {
		return false, nil
	}
	dbPath := filepath.Join(store.Root, ".search", "index.db")
	if _, err := os.Stat(dbPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	// Runtime searches can preflight while the daemon is opening or migrating
	// the same SQLite index. Wait briefly for that writer instead of degrading a
	// valid concurrent semantic request with SQLITE_BUSY.
	db, err := sql.Open("sqlite", dbPath+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return false, err
	}
	defer db.Close()
	ready, err := semanticIndexMetadataReady(db, cfg)
	if err != nil || !ready {
		return false, err
	}
	count, err := semanticIndexChunkCount(db, chunkTypes)
	if err != nil {
		if strings.Contains(err.Error(), "no such table") {
			return false, nil
		}
		return false, err
	}
	return count > 0, nil
}

func semanticIndexMetadataReady(db *sql.DB, cfg semanticRuntimeConfig) (bool, error) {
	rows, err := db.Query("SELECT key, value FROM metadata WHERE key IN ('model', 'dimensions', 'chunkVersion')")
	if err != nil {
		if strings.Contains(err.Error(), "no such table") {
			return false, nil
		}
		return false, err
	}
	defer rows.Close()
	values := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return false, err
		}
		values[key] = value
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return values["model"] == cfg.modelID &&
		values["dimensions"] == fmt.Sprintf("%d", cfg.dimensions) &&
		values["chunkVersion"] == fmt.Sprintf("%d", ChunkVersion), nil
}

func semanticIndexChunkCount(db *sql.DB, chunkTypes []ChunkType) (int, error) {
	query := "SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL"
	args := make([]any, 0, len(chunkTypes))
	if len(chunkTypes) > 0 {
		placeholders := make([]string, 0, len(chunkTypes))
		for _, chunkType := range chunkTypes {
			placeholders = append(placeholders, "?")
			args = append(args, string(chunkType))
		}
		query += " AND type IN (" + strings.Join(placeholders, ",") + ")"
	}
	var count int
	if err := db.QueryRow(query, args...).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func chunkTypesForRuntimePreflight(searchType string) []ChunkType {
	switch searchType {
	case "doc":
		return []ChunkType{ChunkTypeDoc}
	case "task":
		return []ChunkType{ChunkTypeTask}
	case "decision":
		return []ChunkType{ChunkTypeDecision}
	case "code":
		return []ChunkType{ChunkTypeCode}
	default:
		return nil
	}
}

func writeSemanticSearchRuntimeRequest(req semanticSearchRuntimeRequest) (string, error) {
	requestID, err := newSemanticRuntimeRequestID()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(semanticSearchRuntimeRequestDir(), 0755); err != nil {
		return "", err
	}
	data, err := json.Marshal(req)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(semanticSearchRuntimeRequestPath(requestID), data, 0600); err != nil {
		return "", err
	}
	return requestID, nil
}

func readSemanticSearchRuntimeRequest(requestID string) (semanticSearchRuntimeRequest, error) {
	if requestID == "" || filepath.Base(requestID) != requestID {
		return semanticSearchRuntimeRequest{}, fmt.Errorf("invalid semantic runtime request id")
	}
	data, err := os.ReadFile(semanticSearchRuntimeRequestPath(requestID))
	if err != nil {
		return semanticSearchRuntimeRequest{}, err
	}
	var req semanticSearchRuntimeRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return semanticSearchRuntimeRequest{}, err
	}
	return req, nil
}

func semanticSearchRuntimeRequestDir() string {
	return filepath.Join(runtimequeue.RuntimeRoot(), "semantic-requests")
}

func semanticSearchRuntimeRequestPath(requestID string) string {
	return filepath.Join(semanticSearchRuntimeRequestDir(), requestID+".json")
}

func newSemanticRuntimeRequestID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func RetrieveWithRuntime(store *storage.Store, opts models.RetrievalOptions) (*models.RetrievalResponse, *RuntimeMetadata, error) {
	return retrieveWithRuntime(store, opts, nil)
}

func retrieveWithRuntime(store *storage.Store, opts models.RetrievalOptions, afterSearch func()) (*models.RetrievalResponse, *RuntimeMetadata, error) {
	searchType := typeFilterFromSources(opts.SourceTypes)
	engine := NewEngine(store, nil, nil)
	searchOpts := engine.resolveTaskVisibility(SearchOptions{
		Query:             opts.Query,
		Type:              searchType,
		Mode:              opts.Mode,
		Status:            opts.Status,
		Priority:          opts.Priority,
		Assignee:          opts.Assignee,
		Label:             opts.Label,
		Tag:               opts.Tag,
		Limit:             opts.Limit,
		IncludeHistorical: opts.IncludeHistorical,
		Purpose:           SearchPurposeAIRetrieval,
	})
	searchOpts, err := engine.withTaskSnapshot(searchOpts)
	if err != nil {
		return nil, nil, err
	}
	searchResp, err := SearchWithRuntime(store, searchOpts)
	if err != nil {
		return nil, nil, err
	}
	if afterSearch != nil {
		afterSearch()
	}
	filtered := filterBySourceTypes(searchResp.Results, opts.SourceTypes)
	candidates := engine.buildCandidates(filtered, searchOpts)
	if opts.ExpandReferences {
		expanded := engine.expandCandidateReferences(candidates, opts, searchOpts)
		candidates = mergeCandidates(candidates, expanded, opts.IncludeHistorical)
	}
	candidates = engine.canonicalizeRetrievalCandidates(candidates, searchOpts)
	if opts.Limit <= 0 {
		opts.Limit = 20
	}
	if len(candidates) > opts.Limit {
		candidates = candidates[:opts.Limit]
	}
	response := &models.RetrievalResponse{
		Query:      opts.Query,
		Mode:       effectiveMode(opts.Mode, searchResp.Runtime == nil || !searchResp.Runtime.Degraded),
		Candidates: candidates,
		ContextPack: models.ContextPack{
			Items: engine.buildContextPack(candidates, searchOpts),
			Mode:  "docs-first",
		},
	}
	if response.Candidates == nil {
		response.Candidates = []models.RetrievalCandidate{}
	}
	if response.ContextPack.Items == nil {
		response.ContextPack.Items = []models.ContextItem{}
	}
	return response, searchResp.Runtime, nil
}

func taskSnapshotValues(snapshot *taskSearchSnapshot) []*models.Task {
	if snapshot == nil {
		return nil
	}
	tasks := make([]*models.Task, 0, len(snapshot.byID))
	for _, task := range snapshot.byID {
		tasks = append(tasks, task)
	}
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].ID < tasks[j].ID })
	return tasks
}

func taskSnapshotFromValues(tasks []*models.Task) *taskSearchSnapshot {
	snapshot := &taskSearchSnapshot{byID: make(map[string]*models.Task, len(tasks))}
	for _, task := range tasks {
		if task != nil {
			snapshot.byID[task.ID] = task
		}
	}
	return snapshot
}

func keywordFallback(store *storage.Store, opts SearchOptions) ([]models.SearchResult, error) {
	opts.Mode = string(ModeKeyword)
	return NewEngine(store, nil, nil).Search(opts)
}

func degradedRuntimeMetadata(mode SearchMode, err error) *RuntimeMetadata {
	message := "semantic runtime unavailable; returned keyword results only"
	if err != nil {
		message += ": " + err.Error()
	}
	return &RuntimeMetadata{
		Degraded: true,
		Mode:     string(mode),
		Reason:   runtimeReason(err),
		Message:  message,
	}
}

func semanticRuntimeSearchError(err error) error {
	return fmt.Errorf("semantic runtime unavailable: %w", err)
}

func runtimeReason(err error) string {
	switch {
	case errors.Is(err, ErrSemanticRuntimeDisabled):
		return "disabled"
	case errors.Is(err, ErrSemanticNotConfigured):
		return "not_configured"
	default:
		return "unavailable"
	}
}
