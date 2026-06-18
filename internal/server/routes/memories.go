package routes

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/memoryreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/references"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

// MemoryRoutes handles persistent memory endpoints.
type MemoryRoutes struct {
	store *storage.Store
	mgr   *storage.Manager
	sse   Broadcaster
}

func (mr *MemoryRoutes) getStore() *storage.Store {
	if mr.mgr != nil {
		return mr.mgr.GetStore()
	}
	return mr.store
}

// Register wires the memory routes onto r.
func (mr *MemoryRoutes) Register(r chi.Router) {
	r.Get("/memories", mr.list)
	r.Post("/memories", mr.create)
	r.Get("/memories/review", mr.reviewInbox)
	r.Post("/memories/review/resolve", mr.resolveReview)
	r.Post("/memories/bulk", mr.bulkAction)
	r.Get("/memories/{id}", mr.get)
	r.Put("/memories/{id}", mr.update)
	r.Delete("/memories/{id}", mr.delete)
	r.Post("/memories/{id}/action", mr.action)
	r.Post("/memories/{id}/promote", mr.promote)
	r.Post("/memories/{id}/demote", mr.demote)
}

func (mr *MemoryRoutes) list(w http.ResponseWriter, r *http.Request) {
	layer := r.URL.Query().Get("layer")
	category := r.URL.Query().Get("category")
	tag := r.URL.Query().Get("tag")

	if layer != "" && !models.ValidPersistentMemoryLayer(layer) {
		respondError(w, http.StatusBadRequest, "invalid layer: must be project or global")
		return
	}

	entries, err := mr.getStore().Memory.ListPersistent(layer)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if category != "" {
		filtered := entries[:0]
		for _, e := range entries {
			if e.Category == category {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
	}
	if tag != "" {
		filtered := entries[:0]
		for _, e := range entries {
			for _, t := range e.Tags {
				if t == tag {
					filtered = append(filtered, e)
					break
				}
			}
		}
		entries = filtered
	}

	if entries == nil {
		entries = []*models.MemoryEntry{}
	}

	respondJSON(w, http.StatusOK, entries)
}

func (mr *MemoryRoutes) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	entry, err := mr.getStore().Memory.Get(id)
	if err != nil || !models.ValidPersistentMemoryLayer(entry.Layer) {
		respondError(w, http.StatusNotFound, "memory not found")
		return
	}
	respondJSON(w, http.StatusOK, entry)
}

type createMemoryRequest struct {
	Title      string            `json:"title"`
	Content    string            `json:"content"`
	Layer      string            `json:"layer"`
	Category   string            `json:"category"`
	Status     string            `json:"status"`
	Confidence string            `json:"confidence"`
	TTLDays    int               `json:"ttlDays"`
	Sources    []string          `json:"sources"`
	Tags       []string          `json:"tags"`
	Metadata   map[string]string `json:"metadata"`
	SkipReview bool              `json:"skipReview"`
}

func (mr *MemoryRoutes) create(w http.ResponseWriter, r *http.Request) {
	var req createMemoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Layer == "" {
		req.Layer = models.MemoryLayerProject
	}
	if !models.ValidPersistentMemoryLayer(req.Layer) {
		respondError(w, http.StatusBadRequest, "invalid layer: must be project or global")
		return
	}

	now := time.Now().UTC()
	entry := &models.MemoryEntry{
		Title:      req.Title,
		Content:    req.Content,
		Layer:      req.Layer,
		Category:   req.Category,
		Status:     req.Status,
		Confidence: req.Confidence,
		TTLDays:    req.TTLDays,
		Sources:    req.Sources,
		Tags:       req.Tags,
		Metadata:   req.Metadata,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if entry.Tags == nil {
		entry.Tags = []string{}
	}
	if entry.Sources == nil {
		entry.Sources = []string{}
	}
	if req.SkipReview {
		if entry.Metadata == nil {
			entry.Metadata = map[string]string{}
		}
		entry.Metadata["reviewOverride"] = "create_anyway"
	}

	result, err := memoryreview.New(mr.getStore()).Add(entry, memoryreview.AddOptions{
		SkipReview: req.SkipReview,
		Status:     req.Status,
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if result.Status == memoryreview.ResultReviewRequired {
		respondJSON(w, http.StatusConflict, result)
		return
	}

	indexMemoryChanges(mr.getStore(), result.ChangedIDs)
	mr.broadcast("memories:created", map[string]any{"memory": result.Memory})
	respondJSON(w, http.StatusCreated, result.Memory)
}

type updateMemoryRequest struct {
	Title      *string  `json:"title"`
	Content    *string  `json:"content"`
	Category   *string  `json:"category"`
	Status     *string  `json:"status"`
	Confidence *string  `json:"confidence"`
	TTLDays    *int     `json:"ttlDays"`
	Sources    []string `json:"sources"`
	Tags       []string `json:"tags"`
}

func (mr *MemoryRoutes) update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	entry, err := mr.getStore().Memory.Get(id)
	if err != nil || !models.ValidPersistentMemoryLayer(entry.Layer) {
		respondError(w, http.StatusNotFound, "memory not found")
		return
	}

	var req updateMemoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Title != nil {
		entry.Title = *req.Title
	}
	if req.Content != nil {
		entry.Content = *req.Content
	}
	if req.Category != nil {
		entry.Category = *req.Category
	}
	if req.Status != nil {
		if !models.ValidMemoryStatus(*req.Status) {
			respondError(w, http.StatusBadRequest, "invalid memory status")
			return
		}
		entry.Status = *req.Status
	}
	if req.Confidence != nil {
		if *req.Confidence != "" && !models.ValidMemoryConfidence(*req.Confidence) {
			respondError(w, http.StatusBadRequest, "invalid memory confidence")
			return
		}
		entry.Confidence = *req.Confidence
	}
	if req.TTLDays != nil {
		if *req.TTLDays < 0 {
			respondError(w, http.StatusBadRequest, "ttlDays must be non-negative")
			return
		}
		entry.TTLDays = *req.TTLDays
	}
	if req.Sources != nil {
		entry.Sources = req.Sources
	}
	if req.Tags != nil {
		entry.Tags = req.Tags
	}

	entry.UpdatedAt = time.Now().UTC()

	if err := mr.getStore().Memory.Update(entry); err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	search.BestEffortIndexMemory(mr.getStore(), entry.ID)
	mr.broadcast("memories:updated", map[string]any{"memory": entry})
	respondJSON(w, http.StatusOK, entry)
}

type resolveMemoryReviewRequest struct {
	Resolution     string   `json:"resolution"`
	TargetID       string   `json:"targetId"`
	Status         string   `json:"status"`
	ID             string   `json:"id"`
	Title          string   `json:"title"`
	Content        string   `json:"content"`
	Layer          string   `json:"layer"`
	Category       string   `json:"category"`
	Tags           []string `json:"tags"`
	Sources        []string `json:"sources"`
	Confidence     string   `json:"confidence"`
	TTLDays        int      `json:"ttlDays"`
	RejectedReason string   `json:"rejectedReason"`
}

func (mr *MemoryRoutes) resolveReview(w http.ResponseWriter, r *http.Request) {
	var req resolveMemoryReviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Resolution == "" {
		respondError(w, http.StatusBadRequest, "resolution is required")
		return
	}
	result, err := memoryreview.New(mr.getStore()).Resolve(memoryFromResolveRequest(req), memoryreview.ResolveOptions{
		Resolution:     req.Resolution,
		TargetID:       req.TargetID,
		Status:         req.Status,
		RejectedReason: req.RejectedReason,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	indexMemoryChanges(mr.getStore(), result.ChangedIDs)
	mr.broadcast("memories:updated", map[string]any{"result": result})
	respondJSON(w, http.StatusOK, result)
}

func memoryFromResolveRequest(req resolveMemoryReviewRequest) *models.MemoryEntry {
	return &models.MemoryEntry{
		ID:         req.ID,
		Title:      req.Title,
		Content:    req.Content,
		Layer:      req.Layer,
		Category:   req.Category,
		Tags:       req.Tags,
		Sources:    req.Sources,
		Confidence: req.Confidence,
		TTLDays:    req.TTLDays,
	}
}

type memoryActionRequest struct {
	Action         string   `json:"action"`
	Sources        []string `json:"sources"`
	Source         string   `json:"source"`
	Replacement    string   `json:"replacement"`
	RejectedReason string   `json:"rejectedReason"`
}

func (mr *MemoryRoutes) action(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	entry, err := mr.getStore().Memory.Get(id)
	if err != nil || !models.ValidPersistentMemoryLayer(entry.Layer) {
		respondError(w, http.StatusNotFound, "memory not found")
		return
	}

	var req memoryActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	now := time.Now().UTC()
	switch req.Action {
	case "verify":
		entry.Status = models.MemoryStatusActive
		entry.LastVerified = now
		if req.Sources != nil {
			entry.Sources = req.Sources
		}
	case "archive":
		entry.Status = models.MemoryStatusArchived
	case "reject":
		entry.Status = models.MemoryStatusRejected
		entry.RejectedReason = firstNonEmptyString(req.RejectedReason, "rejected_by_review")
	case "link_source":
		entry.Sources = appendUniqueStrings(entry.Sources, req.Sources...)
		entry.LastVerified = now
	case "repair_source":
		if req.Source == "" || req.Replacement == "" {
			respondError(w, http.StatusBadRequest, "source and replacement are required")
			return
		}
		entry.Sources = replaceSource(entry.Sources, req.Source, req.Replacement)
		entry.LastVerified = now
	default:
		respondError(w, http.StatusBadRequest, "unsupported memory action")
		return
	}

	entry.UpdatedAt = now
	if err := mr.getStore().Memory.Update(entry); err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	search.BestEffortIndexMemory(mr.getStore(), entry.ID)
	mr.broadcast("memories:updated", map[string]any{"memory": entry})
	respondJSON(w, http.StatusOK, entry)
}

type bulkMemoryActionRequest struct {
	Action         string   `json:"action"`
	IDs            []string `json:"ids"`
	RejectedReason string   `json:"rejectedReason"`
}

func (mr *MemoryRoutes) bulkAction(w http.ResponseWriter, r *http.Request) {
	var req bulkMemoryActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.IDs) == 0 {
		respondError(w, http.StatusBadRequest, "ids are required")
		return
	}
	switch req.Action {
	case "verify", "archive", "reject_proposed":
	default:
		respondError(w, http.StatusBadRequest, "unsupported bulk memory action")
		return
	}
	entries := make([]*models.MemoryEntry, 0, len(req.IDs))
	for _, id := range req.IDs {
		entry, err := mr.getStore().Memory.Get(id)
		if err != nil || !models.ValidPersistentMemoryLayer(entry.Layer) {
			respondError(w, http.StatusNotFound, "memory not found: "+id)
			return
		}
		if req.Action == "reject_proposed" && entry.Status != models.MemoryStatusProposed {
			respondError(w, http.StatusBadRequest, "reject_proposed can only target proposed memories")
			return
		}
		entries = append(entries, entry)
	}

	now := time.Now().UTC()
	updated := make([]*models.MemoryEntry, 0, len(entries))
	for _, entry := range entries {
		switch req.Action {
		case "verify":
			entry.Status = models.MemoryStatusActive
			entry.LastVerified = now
		case "archive":
			entry.Status = models.MemoryStatusArchived
		case "reject_proposed":
			entry.Status = models.MemoryStatusRejected
			entry.RejectedReason = firstNonEmptyString(req.RejectedReason, "rejected_by_review")
		}
		entry.UpdatedAt = now
		if err := mr.getStore().Memory.Update(entry); err != nil {
			respondError(w, http.StatusInternalServerError, err.Error())
			return
		}
		search.BestEffortIndexMemory(mr.getStore(), entry.ID)
		updated = append(updated, entry)
	}
	mr.broadcast("memories:updated", map[string]any{"bulk": true, "count": len(updated)})
	respondJSON(w, http.StatusOK, map[string]any{"updated": updated, "count": len(updated)})
}

const (
	memoryReviewReasonProposed                 = "proposed"
	memoryReviewReasonDuplicateReview          = "duplicate_review"
	memoryReviewReasonStaleTTL                 = "stale_ttl"
	memoryReviewReasonMissingSource            = "missing_source"
	memoryReviewReasonSourceMissing            = "source_missing"
	memoryReviewReasonSourceDecisionSuperseded = "source_decision_superseded"
)

type memoryReviewInboxResponse struct {
	Memories []*models.MemoryEntry `json:"memories"`
	Items    []memoryReviewItem    `json:"items"`
	Counts   map[string]int        `json:"counts"`
}

type memoryReviewItem struct {
	Memory        *models.MemoryEntry  `json:"memory"`
	Reasons       []string             `json:"reasons"`
	Issues        []memoryReviewIssue  `json:"issues,omitempty"`
	Matches       []memoryreview.Match `json:"matches,omitempty"`
	RepairSources []memorySourceRepair `json:"repairSources,omitempty"`
}

type memoryReviewIssue struct {
	Code          string `json:"code"`
	Message       string `json:"message"`
	Source        string `json:"source,omitempty"`
	TargetID      string `json:"targetId,omitempty"`
	ReplacementID string `json:"replacementId,omitempty"`
}

type memorySourceRepair struct {
	Source                string `json:"source"`
	Replacement           string `json:"replacement"`
	DecisionID            string `json:"decisionId"`
	ReplacementDecisionID string `json:"replacementDecisionId"`
}

func (mr *MemoryRoutes) reviewInbox(w http.ResponseWriter, r *http.Request) {
	store := mr.getStore()
	entries, err := store.Memory.ListPersistent("")
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return memorySortTime(entries[i]).After(memorySortTime(entries[j]))
	})

	ctx := newMemoryReviewContext(store, entries)
	items := make([]memoryReviewItem, 0)
	counts := map[string]int{
		memoryReviewReasonProposed:                 0,
		memoryReviewReasonDuplicateReview:          0,
		memoryReviewReasonStaleTTL:                 0,
		memoryReviewReasonMissingSource:            0,
		memoryReviewReasonSourceMissing:            0,
		memoryReviewReasonSourceDecisionSuperseded: 0,
	}
	for _, entry := range entries {
		item := buildMemoryReviewItem(store, ctx, entry, time.Now().UTC())
		if len(item.Reasons) == 0 {
			continue
		}
		for _, reason := range item.Reasons {
			counts[reason]++
		}
		items = append(items, item)
	}
	if entries == nil {
		entries = []*models.MemoryEntry{}
	}
	respondJSON(w, http.StatusOK, memoryReviewInboxResponse{
		Memories: entries,
		Items:    items,
		Counts:   counts,
	})
}

type memoryReviewContext struct {
	taskIDs   map[string]bool
	docPaths  map[string]bool
	memoryIDs map[string]bool
}

func newMemoryReviewContext(store *storage.Store, entries []*models.MemoryEntry) memoryReviewContext {
	ctx := memoryReviewContext{
		taskIDs:   map[string]bool{},
		docPaths:  map[string]bool{},
		memoryIDs: map[string]bool{},
	}
	if tasks, err := store.Tasks.List(); err == nil {
		for _, task := range tasks {
			ctx.taskIDs[task.ID] = true
		}
	}
	if docs, err := store.Docs.List(); err == nil {
		for _, doc := range docs {
			ctx.docPaths[doc.Path] = true
		}
	}
	for _, entry := range entries {
		ctx.memoryIDs[entry.ID] = true
	}
	return ctx
}

func buildMemoryReviewItem(store *storage.Store, ctx memoryReviewContext, entry *models.MemoryEntry, now time.Time) memoryReviewItem {
	item := memoryReviewItem{Memory: entry}
	reasons := map[string]bool{}
	addReason := func(reason string) {
		if !reasons[reason] {
			item.Reasons = append(item.Reasons, reason)
			reasons[reason] = true
		}
	}

	if entry.Status == models.MemoryStatusProposed {
		addReason(memoryReviewReasonProposed)
		if review, err := memoryreview.New(store).Review(entry); err == nil && review != nil && len(review.Matches) > 0 {
			item.Matches = review.Matches
			addReason(memoryReviewReasonDuplicateReview)
		}
	}
	if entry.Status == models.MemoryStatusStale || memoryTTLExpired(entry, now) {
		addReason(memoryReviewReasonStaleTTL)
		item.Issues = append(item.Issues, memoryReviewIssue{Code: "MEMORY_TTL_EXPIRED", Message: "Memory TTL is expired or marked stale"})
	}
	if len(entry.Sources) == 0 {
		addReason(memoryReviewReasonMissingSource)
		item.Issues = append(item.Issues, memoryReviewIssue{Code: "MEMORY_MISSING_SOURCE", Message: "Memory has no source references"})
	} else {
		for _, source := range entry.Sources {
			issues, repairs := memorySourceIssues(store, ctx, source)
			for _, issue := range issues {
				item.Issues = append(item.Issues, issue)
				if issue.Code == "MEMORY_SOURCE_DECISION_SUPERSEDED" {
					addReason(memoryReviewReasonSourceDecisionSuperseded)
				} else {
					addReason(memoryReviewReasonSourceMissing)
				}
			}
			item.RepairSources = append(item.RepairSources, repairs...)
		}
	}
	return item
}

func memorySourceIssues(store *storage.Store, ctx memoryReviewContext, source string) ([]memoryReviewIssue, []memorySourceRepair) {
	ref, ok := references.Parse(source)
	if !ok {
		return nil, nil
	}
	switch ref.Type {
	case "task":
		if !ctx.taskIDs[ref.Target] {
			return []memoryReviewIssue{brokenSourceReviewIssue(source, ref.Target)}, nil
		}
	case "doc":
		if !ctx.docPaths[ref.Target] {
			return []memoryReviewIssue{brokenSourceReviewIssue(source, ref.Target)}, nil
		}
	case "memory":
		if !ctx.memoryIDs[ref.Target] {
			return []memoryReviewIssue{brokenSourceReviewIssue(source, ref.Target)}, nil
		}
	case "decision":
		decision, err := store.Decisions.Get(ref.Target)
		if err != nil {
			return []memoryReviewIssue{brokenSourceReviewIssue(source, ref.Target)}, nil
		}
		if decision.Status == models.DecisionStatusSuperseded || len(decision.SupersededBy) > 0 {
			replacementID := ""
			if len(decision.SupersededBy) > 0 {
				replacementID = decision.SupersededBy[0]
			}
			issue := memoryReviewIssue{
				Code:          "MEMORY_SOURCE_DECISION_SUPERSEDED",
				Message:       "Memory source decision is superseded",
				Source:        source,
				TargetID:      ref.Target,
				ReplacementID: replacementID,
			}
			if replacementID == "" {
				return []memoryReviewIssue{issue}, nil
			}
			repair := memorySourceRepair{
				Source:                source,
				Replacement:           models.DecisionRef(replacementID),
				DecisionID:            ref.Target,
				ReplacementDecisionID: replacementID,
			}
			return []memoryReviewIssue{issue}, []memorySourceRepair{repair}
		}
	}
	return nil, nil
}

func brokenSourceReviewIssue(source, target string) memoryReviewIssue {
	return memoryReviewIssue{
		Code:     "MEMORY_BROKEN_SOURCE_REF",
		Message:  "Memory source reference is broken",
		Source:   strings.TrimSpace(source),
		TargetID: target,
	}
}

func memoryTTLExpired(entry *models.MemoryEntry, now time.Time) bool {
	if entry.TTLDays <= 0 || entry.LastVerified.IsZero() {
		return false
	}
	return now.After(entry.LastVerified.Add(time.Duration(entry.TTLDays) * 24 * time.Hour))
}

func memorySortTime(entry *models.MemoryEntry) time.Time {
	if entry.UpdatedAt.IsZero() {
		return entry.CreatedAt
	}
	return entry.UpdatedAt
}

func indexMemoryChanges(store *storage.Store, ids []string) {
	for _, id := range ids {
		if id == "" {
			continue
		}
		search.BestEffortIndexMemory(store, id)
	}
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func appendUniqueStrings(existing []string, values ...string) []string {
	seen := make(map[string]bool, len(existing)+len(values))
	out := make([]string, 0, len(existing)+len(values))
	for _, value := range existing {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func replaceSource(sources []string, source, replacement string) []string {
	if len(sources) == 0 {
		return []string{replacement}
	}
	out := make([]string, 0, len(sources))
	replaced := false
	for _, existing := range sources {
		if existing == source {
			out = append(out, replacement)
			replaced = true
			continue
		}
		out = append(out, existing)
	}
	if !replaced {
		out = append(out, replacement)
	}
	return appendUniqueStrings(nil, out...)
}

func (mr *MemoryRoutes) broadcast(eventType string, data any) {
	if mr.sse != nil {
		mr.sse.Broadcast(SSEEvent{Type: eventType, Data: data})
	}
}

func (mr *MemoryRoutes) delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	entry, err := mr.getStore().Memory.Get(id)
	if err != nil || !models.ValidPersistentMemoryLayer(entry.Layer) {
		respondError(w, http.StatusNotFound, "memory not found")
		return
	}

	if err := mr.getStore().Memory.Delete(id); err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	search.BestEffortRemoveMemory(mr.getStore(), id)
	respondJSON(w, http.StatusOK, map[string]any{"deleted": true, "id": id})
}

func (mr *MemoryRoutes) promote(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	entry, err := mr.getStore().Memory.PromotePersistent(id)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	search.BestEffortIndexMemory(mr.getStore(), entry.ID)
	respondJSON(w, http.StatusOK, entry)
}

func (mr *MemoryRoutes) demote(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	entry, err := mr.getStore().Memory.DemotePersistent(id)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	search.BestEffortIndexMemory(mr.getStore(), entry.ID)
	respondJSON(w, http.StatusOK, entry)
}
