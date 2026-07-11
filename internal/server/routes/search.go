package routes

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

// SearchRoutes handles /api/search endpoints.
type SearchRoutes struct {
	store *storage.Store
	mgr   *storage.Manager
}

func (sr *SearchRoutes) getStore() *storage.Store {
	if sr.mgr != nil {
		return sr.mgr.GetStore()
	}
	return sr.store
}

// Register wires the search routes onto r.
func (sr *SearchRoutes) Register(r chi.Router) {
	r.Get("/search", sr.searchHandler)
	r.Get("/retrieve", sr.retrieveHandler)
	r.Get("/resolve", sr.resolveHandler)
}

// searchHandler executes a search across tasks and docs.
//
// GET /api/search?q={query}&type={all|task|doc}&mode={keyword|semantic|hybrid}&limit={n}&status={s}&priority={p}&assignee={a}&label={l}&tag={t}
func (sr *SearchRoutes) searchHandler(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	limit := 20
	if l := q.Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	opts := search.SearchOptions{
		Query:    q.Get("q"),
		Type:     q.Get("type"),
		Mode:     q.Get("mode"),
		Status:   q.Get("status"),
		Priority: q.Get("priority"),
		Assignee: q.Get("assignee"),
		Label:    q.Get("label"),
		Tag:      q.Get("tag"),
		Limit:    limit,
	}

	response, err := search.SearchWithRuntime(sr.getStore(), opts)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	results := response.Results

	// Group results by type into {tasks: [...], docs: [...]} shape expected by UI.
	taskResults := []models.SearchResult{}
	docResults := []models.SearchResult{}
	for _, r := range results {
		switch r.Type {
		case "task":
			taskResults = append(taskResults, r)
		case "doc":
			docResults = append(docResults, r)
		default:
			taskResults = append(taskResults, r)
		}
	}

	payload := map[string]interface{}{
		"tasks": taskResults,
		"docs":  docResults,
	}
	if response.Runtime != nil {
		payload["_runtime"] = response.Runtime
	}
	respondJSON(w, http.StatusOK, payload)
}

// retrieveHandler executes mixed-source retrieval and returns ranked candidates
// plus an assembled context pack for agents and internal APIs.
//
// GET /api/retrieve?q={query}&mode={keyword|semantic|hybrid}&sourceType={doc|task|memory}&expandReferences={true|false}
func (sr *SearchRoutes) resolveHandler(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("ref")
	if strings.TrimSpace(raw) == "" {
		respondError(w, http.StatusBadRequest, "missing ref query parameter")
		return
	}

	resolution, err := sr.getStore().ResolveRawReference(raw)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, resolution)
}

func (sr *SearchRoutes) retrieveHandler(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	limit := 20
	if l := q.Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	expandRefs := false
	if raw := q.Get("expandReferences"); raw != "" {
		expandRefs = strings.EqualFold(raw, "true") || raw == "1"
	}

	response, runtimeMeta, err := search.RetrieveWithRuntime(sr.getStore(), models.RetrievalOptions{
		Query:            q.Get("q"),
		Mode:             q.Get("mode"),
		Limit:            limit,
		SourceTypes:      q["sourceType"],
		ExpandReferences: expandRefs,
		Status:           q.Get("status"),
		Priority:         q.Get("priority"),
		Assignee:         q.Get("assignee"),
		Label:            q.Get("label"),
		Tag:              q.Get("tag"),
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if runtimeMeta != nil {
		respondJSON(w, http.StatusOK, map[string]any{
			"query":       response.Query,
			"mode":        response.Mode,
			"candidates":  response.Candidates,
			"contextPack": response.ContextPack,
			"_runtime":    runtimeMeta,
		})
		return
	}
	respondJSON(w, http.StatusOK, response)
}
