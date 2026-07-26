package routes

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/decisionmigration"
	"github.com/howznguyen/knowns/internal/decisionreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

// DecisionRoutes handles decision endpoints.
type DecisionRoutes struct {
	store *storage.Store
	mgr   *storage.Manager
	sse   Broadcaster
}

func (dr *DecisionRoutes) getStore() *storage.Store {
	if dr.mgr != nil {
		return dr.mgr.GetStore()
	}
	return dr.store
}

// Register wires the decision routes onto r.
func (dr *DecisionRoutes) Register(r chi.Router) {
	r.Get("/decisions", dr.list)
	r.Post("/decisions", dr.create)
	r.Get("/decisions/migration/preview", dr.migrationPreview)
	r.Post("/decisions/migration/apply", dr.migrationApply)
	r.Post("/decisions/migration/{memoryID}/rollback", dr.migrationRollback)
	r.Get("/decisions/review/inbox", dr.reviewInbox)
	r.Post("/decisions/review/resolve", dr.resolve)
	r.Get("/decisions/{id}", dr.get)
	r.Post("/decisions/{id}/link", dr.link)
	r.Post("/decisions/{id}/accept", dr.accept)
	r.Post("/decisions/{id}/supersede", dr.supersede)
}

func (dr *DecisionRoutes) migrationPreview(w http.ResponseWriter, r *http.Request) {
	report, err := decisionmigration.New(dr.getStore()).Preview()
	if err != nil {
		respondError(w, http.StatusConflict, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, report)
}

type decisionMigrationApplyRequest struct {
	Selections []decisionmigration.Selection `json:"selections"`
}

func (dr *DecisionRoutes) migrationApply(w http.ResponseWriter, r *http.Request) {
	var req decisionMigrationApplyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Selections) == 0 {
		respondError(w, http.StatusBadRequest, "at least one explicitly reviewed migration selection is required")
		return
	}
	result, err := decisionmigration.New(dr.getStore()).Apply(r.Context(), req.Selections)
	if err != nil {
		respondJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "result": result})
		return
	}
	for _, item := range result.Results {
		if item.DecisionID != "" {
			search.BestEffortIndexDecision(dr.getStore(), item.DecisionID)
		}
	}
	if dr.sse != nil {
		dr.sse.Broadcast(SSEEvent{Type: "decisions:migrated", Data: map[string]any{"result": result}})
	}
	respondJSON(w, http.StatusOK, result)
}

func (dr *DecisionRoutes) migrationRollback(w http.ResponseWriter, r *http.Request) {
	memoryID := chi.URLParam(r, "memoryID")
	result, err := decisionmigration.New(dr.getStore()).Rollback(r.Context(), memoryID)
	if err != nil {
		respondError(w, http.StatusConflict, err.Error())
		return
	}
	if result.DecisionID != "" {
		search.BestEffortIndexDecision(dr.getStore(), result.DecisionID)
	}
	if dr.sse != nil {
		dr.sse.Broadcast(SSEEvent{Type: "decisions:migration-rolled-back", Data: map[string]any{"result": result}})
	}
	respondJSON(w, http.StatusOK, result)
}

func (dr *DecisionRoutes) list(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	tag := r.URL.Query().Get("tag")
	includeAll := r.URL.Query().Get("includeAll") == "true" || r.URL.Query().Get("all") == "true"
	if status != "" && !models.ValidDecisionStatus(status) {
		respondError(w, http.StatusBadRequest, "invalid decision status")
		return
	}
	decisions, err := dr.getStore().Decisions.List()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	filtered := decisions[:0]
	for _, decision := range decisions {
		if status != "" {
			if decision.Status != status {
				continue
			}
		} else if !includeAll && !decision.CurrentForDefaultRetrieval() {
			continue
		}
		if tag != "" && !decisionHasString(decision.Tags, tag) {
			continue
		}
		filtered = append(filtered, decision)
	}
	if filtered == nil {
		filtered = []*models.DecisionEntry{}
	}
	respondJSON(w, http.StatusOK, filtered)
}

func (dr *DecisionRoutes) reviewInbox(w http.ResponseWriter, r *http.Request) {
	candidates, err := decisionreview.New(dr.getStore()).ReviewCandidates()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if candidates == nil {
		candidates = []*models.DecisionEntry{}
	}
	respondJSON(w, http.StatusOK, candidates)
}

func decisionHasString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

type createDecisionRequest struct {
	Title                  string   `json:"title"`
	Status                 string   `json:"status"`
	Tags                   []string `json:"tags"`
	Sources                []string `json:"sources"`
	RelatedDocs            []string `json:"relatedDocs"`
	RelatedTasks           []string `json:"relatedTasks"`
	Body                   string   `json:"body"`
	Context                string   `json:"context"`
	Decision               string   `json:"decision"`
	AlternativesConsidered string   `json:"alternativesConsidered"`
	Consequences           string   `json:"consequences"`
}

func (dr *DecisionRoutes) create(w http.ResponseWriter, r *http.Request) {
	var req createDecisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Title == "" {
		respondError(w, http.StatusBadRequest, "title is required")
		return
	}
	if req.Status != "" && !models.ValidDecisionStatus(req.Status) {
		respondError(w, http.StatusBadRequest, "invalid decision status")
		return
	}
	result, err := decisionreview.New(dr.getStore()).Add(decisionFromCreateRequest(req), decisionreview.AddOptions{})
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if result.Status == decisionreview.ResultReviewRequired {
		if result.Candidate != nil {
			search.BestEffortIndexDecision(dr.getStore(), result.Candidate.ID)
		}
		if dr.sse != nil {
			dr.sse.Broadcast(SSEEvent{Type: "decisions:review-required", Data: map[string]any{"result": result}})
		}
		respondJSON(w, http.StatusConflict, result)
		return
	}
	decision := result.Decision
	search.BestEffortIndexDecision(dr.getStore(), decision.ID)
	if dr.sse != nil {
		dr.sse.Broadcast(SSEEvent{Type: "decisions:created", Data: map[string]any{"decision": decision}})
	}
	respondJSON(w, http.StatusCreated, decision)
}

func decisionFromCreateRequest(req createDecisionRequest) *models.DecisionEntry {
	return &models.DecisionEntry{
		Title:                  req.Title,
		Status:                 req.Status,
		Tags:                   req.Tags,
		Sources:                req.Sources,
		RelatedDocs:            req.RelatedDocs,
		RelatedTasks:           req.RelatedTasks,
		Content:                req.Body,
		Context:                req.Context,
		Decision:               req.Decision,
		AlternativesConsidered: req.AlternativesConsidered,
		Consequences:           req.Consequences,
	}
}

func (dr *DecisionRoutes) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	decision, err := dr.getStore().Decisions.Get(id)
	if err != nil {
		respondError(w, http.StatusNotFound, "decision not found")
		return
	}
	respondJSON(w, http.StatusOK, decision)
}

type linkDecisionRequest struct {
	Sources      []string `json:"sources"`
	RelatedDocs  []string `json:"relatedDocs"`
	RelatedTasks []string `json:"relatedTasks"`
}

func (dr *DecisionRoutes) link(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req linkDecisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	decision, err := dr.getStore().Decisions.Link(id, req.RelatedDocs, req.RelatedTasks, req.Sources)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if decision.Status == models.DecisionStatusDraft {
		decision, err = decisionreview.New(dr.getStore()).RefreshCandidate(decision.ID)
		if err != nil {
			respondError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	search.BestEffortIndexDecision(dr.getStore(), decision.ID)
	if dr.sse != nil {
		dr.sse.Broadcast(SSEEvent{Type: "decisions:updated", Data: map[string]any{"decision": decision}})
	}
	respondJSON(w, http.StatusOK, decision)
}

type supersedeDecisionRequest struct {
	NewID string `json:"newId"`
}

func (dr *DecisionRoutes) supersede(w http.ResponseWriter, r *http.Request) {
	oldID := chi.URLParam(r, "id")
	var req supersedeDecisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	oldDecision, newDecision, err := dr.getStore().Decisions.Supersede(oldID, req.NewID)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	search.BestEffortIndexDecision(dr.getStore(), oldDecision.ID)
	search.BestEffortIndexDecision(dr.getStore(), newDecision.ID)
	if dr.sse != nil {
		dr.sse.Broadcast(SSEEvent{Type: "decisions:updated", Data: map[string]any{"superseded": oldDecision, "current": newDecision}})
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"superseded": oldDecision,
		"current":    newDecision,
	})
}

type acceptDecisionRequest struct {
	Supersedes []string `json:"supersedes"`
}

func (dr *DecisionRoutes) accept(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req acceptDecisionRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}
	}
	result, err := decisionreview.New(dr.getStore()).Accept(id, decisionreview.AcceptOptions{Supersedes: req.Supersedes})
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	for _, changedID := range result.ChangedIDs {
		search.BestEffortIndexDecision(dr.getStore(), changedID)
	}
	if dr.sse != nil {
		dr.sse.Broadcast(SSEEvent{Type: "decisions:updated", Data: map[string]any{"result": result}})
	}
	respondJSON(w, http.StatusOK, result)
}

type resolveDecisionReviewRequest struct {
	Resolution             string   `json:"resolution"`
	CandidateID            string   `json:"candidateId"`
	TargetID               string   `json:"targetId"`
	ReplacementID          string   `json:"replacementId"`
	Status                 string   `json:"status"`
	ID                     string   `json:"id"`
	Title                  string   `json:"title"`
	Tags                   []string `json:"tags"`
	Sources                []string `json:"sources"`
	RelatedDocs            []string `json:"relatedDocs"`
	RelatedTasks           []string `json:"relatedTasks"`
	Body                   string   `json:"body"`
	Context                string   `json:"context"`
	Decision               string   `json:"decision"`
	AlternativesConsidered string   `json:"alternativesConsidered"`
	Consequences           string   `json:"consequences"`
}

func (dr *DecisionRoutes) resolve(w http.ResponseWriter, r *http.Request) {
	var req resolveDecisionReviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Resolution == "" {
		respondError(w, http.StatusBadRequest, "resolution is required")
		return
	}
	result, err := decisionreview.New(dr.getStore()).Resolve(decisionFromResolveRequest(req), decisionreview.ResolveOptions{
		CandidateID:   req.CandidateID,
		Resolution:    req.Resolution,
		TargetID:      req.TargetID,
		ReplacementID: req.ReplacementID,
		Status:        req.Status,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	for _, id := range result.ChangedIDs {
		search.BestEffortIndexDecision(dr.getStore(), id)
	}
	if dr.sse != nil && len(result.ChangedIDs) > 0 {
		dr.sse.Broadcast(SSEEvent{Type: "decisions:updated", Data: map[string]any{"result": result}})
	}
	respondJSON(w, http.StatusOK, result)
}

func decisionFromResolveRequest(req resolveDecisionReviewRequest) *models.DecisionEntry {
	return &models.DecisionEntry{
		ID:                     req.ID,
		Title:                  req.Title,
		Status:                 req.Status,
		Tags:                   req.Tags,
		Sources:                req.Sources,
		RelatedDocs:            req.RelatedDocs,
		RelatedTasks:           req.RelatedTasks,
		Content:                req.Body,
		Context:                req.Context,
		Decision:               req.Decision,
		AlternativesConsidered: req.AlternativesConsidered,
		Consequences:           req.Consequences,
	}
}
