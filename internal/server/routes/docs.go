package routes

import (
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

// docResponse transforms a flat Doc model into the nested shape the UI expects:
// { filename, path, folder, metadata: { title, description, tags, ... }, content, isImported, source }
type docMetadataResponse struct {
	Title       string   `json:"title"`
	Description string   `json:"description,omitempty"`
	CreatedAt   string   `json:"createdAt"`
	UpdatedAt   string   `json:"updatedAt"`
	Tags        []string `json:"tags"`
	Order       *int     `json:"order,omitempty"`
}

type docResponse struct {
	Filename   string              `json:"filename"`
	Path       string              `json:"path"`
	Folder     string              `json:"folder"`
	Metadata   docMetadataResponse `json:"metadata"`
	Content    string              `json:"content"`
	IsImported bool                `json:"isImported,omitempty"`
	Source     string              `json:"source,omitempty"`
}

func toDocResponse(d *models.Doc) docResponse {
	tags := d.Tags
	if tags == nil {
		tags = []string{}
	}
	filename := filepath.Base(d.Path) + ".md"
	return docResponse{
		Filename: filename,
		Path:     d.Path,
		Folder:   d.Folder,
		Metadata: docMetadataResponse{
			Title:       d.Title,
			Description: d.Description,
			CreatedAt:   d.CreatedAt.Format(time.RFC3339),
			UpdatedAt:   d.UpdatedAt.Format(time.RFC3339),
			Tags:        tags,
			Order:       d.Order,
		},
		Content:    d.Content,
		IsImported: d.IsImported,
		Source:     d.ImportSource,
	}
}

// DocRoutes handles /api/docs endpoints.
type DocRoutes struct {
	store *storage.Store
	mgr   *storage.Manager
	sse   Broadcaster
}

func (dr *DocRoutes) getStore() *storage.Store {
	if dr.mgr != nil {
		return dr.mgr.GetStore()
	}
	return dr.store
}

// Register wires the doc routes onto r.
func (dr *DocRoutes) Register(r chi.Router) {
	r.Get("/docs", dr.list)
	r.Post("/docs", dr.create)
	// Wildcard routes must come after specific ones.
	r.Get("/docs/*", dr.getOrHistory)
	r.Post("/docs/*", dr.postDocAction)
	r.Put("/docs/*", dr.update)
}

// getOrHistory dispatches to history/diff handlers when the wildcard path uses
// a doc-history action suffix, otherwise it falls through to the regular get handler.
func (dr *DocRoutes) getOrHistory(w http.ResponseWriter, r *http.Request) {
	raw := decodedDocWildcard(r)
	if path, revision, ok := splitDocHistoryDiffPath(raw); ok {
		dr.diff(w, r, path, revision)
		return
	}
	if path, ok := splitDocHistoryPath(raw); ok {
		dr.history(w, r, path)
		return
	}
	dr.get(w, r)
}

// postDocAction dispatches wildcard POST requests such as doc restore.
func (dr *DocRoutes) postDocAction(w http.ResponseWriter, r *http.Request) {
	raw := decodedDocWildcard(r)
	if path, ok := splitDocRestorePath(raw); ok {
		dr.restore(w, r, path)
		return
	}
	respondError(w, http.StatusNotFound, "unknown doc action")
}

// list returns all documents.
//
// GET /api/docs
func (dr *DocRoutes) list(w http.ResponseWriter, r *http.Request) {
	docs, err := dr.getStore().Docs.List()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	result := make([]docResponse, 0, len(docs))
	for _, d := range docs {
		result = append(result, toDocResponse(d))
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"docs": result,
	})
}

// docPathParam extracts the wildcard path parameter and normalises it.
// Handles URL-encoded paths (e.g. ai%2Fplatforms.md → ai/platforms).
func docPathParam(r *http.Request) string {
	return cleanDocPath(decodedDocWildcard(r))
}

func decodedDocWildcard(r *http.Request) string {
	raw := chi.URLParam(r, "*")
	if decoded, err := url.PathUnescape(raw); err == nil {
		raw = decoded
	}
	return strings.TrimPrefix(raw, "/")
}

func cleanDocPath(raw string) string {
	raw = strings.TrimPrefix(raw, "/")
	raw = strings.TrimSuffix(raw, ".md")
	return strings.Trim(raw, "/")
}

func splitDocHistoryPath(raw string) (string, bool) {
	if !strings.HasSuffix(raw, "/history") {
		return "", false
	}
	path := cleanDocPath(strings.TrimSuffix(raw, "/history"))
	return path, path != ""
}

func splitDocHistoryDiffPath(raw string) (string, string, bool) {
	if !strings.HasSuffix(raw, "/diff") {
		return "", "", false
	}
	withoutDiff := strings.TrimSuffix(raw, "/diff")
	marker := "/history/"
	idx := strings.LastIndex(withoutDiff, marker)
	if idx < 0 {
		return "", "", false
	}
	path := cleanDocPath(withoutDiff[:idx])
	revision := strings.Trim(withoutDiff[idx+len(marker):], "/")
	return path, revision, path != "" && revision != ""
}

func splitDocRestorePath(raw string) (string, bool) {
	if !strings.HasSuffix(raw, "/restore") {
		return "", false
	}
	path := cleanDocPath(strings.TrimSuffix(raw, "/restore"))
	return path, path != ""
}

// get retrieves a single doc by path.
//
// GET /api/docs/*
func (dr *DocRoutes) get(w http.ResponseWriter, r *http.Request) {
	path := docPathParam(r)
	doc, err := dr.getStore().Docs.Get(path)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, toDocResponse(doc))
}

// create persists a new doc.
//
// POST /api/docs
func (dr *DocRoutes) create(w http.ResponseWriter, r *http.Request) {
	var doc models.Doc
	if err := decodeJSON(r, &doc); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	// Auto-generate path from title + folder when not provided.
	if doc.Path == "" && doc.Title != "" {
		slug := slugifyTitle(doc.Title)
		if doc.Folder != "" {
			doc.Path = doc.Folder + "/" + slug
		} else {
			doc.Path = slug
		}
	}
	if doc.Path == "" {
		respondError(w, http.StatusBadRequest, "path or title is required")
		return
	}

	now := time.Now().UTC()
	if doc.CreatedAt.IsZero() {
		doc.CreatedAt = now
	}
	doc.UpdatedAt = now

	if doc.Tags == nil {
		doc.Tags = []string{}
	}

	if err := dr.getStore().Docs.Create(&doc); err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	search.BestEffortIndexDoc(dr.getStore(), doc.Path)

	if err := dr.getStore().Versions.SaveDocRevisionWithOptions(nil, &doc, storage.DocRevisionOptions{
		Actor:  "webui",
		Source: "webui",
	}); err != nil {
		respondError(w, http.StatusInternalServerError, "save doc history: "+err.Error())
		return
	}

	dr.sse.Broadcast(SSEEvent{Type: "docs:updated", Data: map[string]string{"path": doc.Path}})
	respondJSON(w, http.StatusCreated, toDocResponse(&doc))
}

// update saves changes to an existing doc.
//
// PUT /api/docs/*
func (dr *DocRoutes) update(w http.ResponseWriter, r *http.Request) {
	path := docPathParam(r)

	existing, err := dr.getStore().Docs.Get(path)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}
	oldDoc := *existing

	var payload struct {
		Title       *string   `json:"title"`
		Description *string   `json:"description"`
		Content     *string   `json:"content"`
		Tags        *[]string `json:"tags"`
		Path        *string   `json:"path"`
		Section     *string   `json:"section"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	doc := oldDoc
	doc.Path = path
	doc.UpdatedAt = time.Now().UTC()
	oldPath := path

	if payload.Title != nil {
		doc.Title = *payload.Title
	}
	if payload.Description != nil {
		doc.Description = *payload.Description
	}
	if payload.Content != nil {
		doc.Content = *payload.Content
	}
	if payload.Tags != nil {
		doc.Tags = *payload.Tags
	}
	if payload.Path != nil {
		doc.Path = strings.Trim(strings.TrimSuffix(*payload.Path, ".md"), "/")
	}

	if doc.Tags == nil {
		doc.Tags = []string{}
	}

	if oldPath != doc.Path {
		if err := dr.getStore().Docs.Rename(oldPath, &doc); err != nil {
			respondError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := dr.getStore().Docs.RewriteDocReferences(oldPath, doc.Path, dr.getStore().Tasks, dr.getStore().Memory); err != nil {
			respondError(w, http.StatusInternalServerError, err.Error())
			return
		}
		search.BestEffortRemoveDoc(dr.getStore(), oldPath)
	} else if err := dr.getStore().Docs.Update(&doc); err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	search.BestEffortIndexDoc(dr.getStore(), doc.Path)

	section := ""
	if payload.Section != nil {
		section = *payload.Section
	}
	if err := dr.getStore().Versions.SaveDocRevisionWithOptions(&oldDoc, &doc, storage.DocRevisionOptions{
		Section: section,
		Actor:   "webui",
		Source:  "webui",
	}); err != nil {
		respondError(w, http.StatusInternalServerError, "save doc history: "+err.Error())
		return
	}

	if oldPath != doc.Path {
		dr.sse.Broadcast(SSEEvent{Type: "docs:updated", Data: map[string]string{"path": doc.Path, "oldPath": oldPath}})
	} else {
		dr.sse.Broadcast(SSEEvent{Type: "docs:updated", Data: map[string]string{"path": path}})
	}
	respondJSON(w, http.StatusOK, toDocResponse(&doc))
}

// history returns the version history for a document.
//
// GET /api/docs/*/history
func (dr *DocRoutes) history(w http.ResponseWriter, r *http.Request, path string) {
	h, err := dr.getStore().Versions.GetDocHistory(path)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, h)
}

// diff returns the structured change set for a retained document revision.
//
// GET /api/docs/*/history/{revision}/diff
func (dr *DocRoutes) diff(w http.ResponseWriter, r *http.Request, path, revision string) {
	diff, err := dr.getStore().Versions.GetDocRevisionDiff(path, revision)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, diff)
}

// restore restores a document or section from a retained revision.
//
// POST /api/docs/*/restore
func (dr *DocRoutes) restore(w http.ResponseWriter, r *http.Request, path string) {
	var payload struct {
		Revision   string `json:"revision"`
		RevisionID string `json:"revisionId"`
		Section    string `json:"section"`
		Mode       string `json:"mode"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	revision := firstNonEmptyString(payload.RevisionID, payload.Revision)
	if revision == "" {
		respondError(w, http.StatusBadRequest, "revision is required")
		return
	}
	mode := strings.ToLower(strings.TrimSpace(payload.Mode))
	opts := storage.DocRevisionOptions{Actor: "webui", Source: "webui"}

	var (
		doc *models.Doc
		err error
	)
	if payload.Section != "" || mode == "section" {
		doc, err = dr.getStore().RestoreDocSection(path, revision, payload.Section, opts)
	} else if mode == "" || mode == "document" || mode == "whole_doc" || mode == "whole-doc" {
		doc, err = dr.getStore().RestoreDoc(path, revision, opts)
	} else {
		respondError(w, http.StatusBadRequest, "unknown restore mode: "+mode)
		return
	}
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	search.BestEffortIndexDoc(dr.getStore(), doc.Path)
	dr.sse.Broadcast(SSEEvent{Type: "docs:updated", Data: map[string]string{"path": doc.Path}})

	history, _ := dr.getStore().Versions.GetDocHistory(doc.Path)
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"restored": true,
		"doc":      toDocResponse(doc),
		"history":  history,
	})
}
