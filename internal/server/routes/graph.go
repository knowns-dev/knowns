package routes

import (
	"database/sql"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/references"
	"github.com/howznguyen/knowns/internal/storage"
)

// GraphRoutes handles /api/graph endpoints.
type GraphRoutes struct {
	store *storage.Store
	mgr   *storage.Manager
}

func (gr *GraphRoutes) getStore() *storage.Store {
	if gr.mgr != nil {
		return gr.mgr.GetStore()
	}
	return gr.store
}

// Register wires the graph routes onto r.
func (gr *GraphRoutes) Register(r chi.Router) {
	r.Get("/graph", gr.graph)
}

// GraphNode represents a single entity in the knowledge graph.
type GraphNode struct {
	ID    string                 `json:"id"`
	Type  string                 `json:"type"` // "task", "doc", "template"
	Label string                 `json:"label"`
	Data  map[string]interface{} `json:"data"`
}

// GraphEdge represents a relationship between two nodes.
type GraphEdge struct {
	Source string                 `json:"source"`
	Target string                 `json:"target"`
	Type   string                 `json:"type"` // "parent", "spec", "template-doc", "mention"
	Data   map[string]interface{} `json:"data,omitempty"`
}

// Reference-detection regexes (same as validate package).
var (
	graphCodeRefRE = regexp.MustCompile(`@code/([^\s\)]+)`)
)

// graph returns the knowledge graph of tasks, docs, and memories.
//
// GET /api/graph
func (gr *GraphRoutes) graph(w http.ResponseWriter, r *http.Request) {
	tasks, err := gr.getStore().Tasks.List()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	docs, err := gr.getStore().Docs.List()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Build lookup sets for fixed graph nodes.
	taskIDs := make(map[string]bool, len(tasks))
	docPaths := make(map[string]bool, len(docs))

	// Load memory entries.
	memories, _ := gr.getStore().Memory.List("")
	decisions, _ := gr.getStore().Decisions.List()
	templates, _ := gr.getStore().Templates.List()

	var nodes []GraphNode
	var edges []GraphEdge

	// --- Task nodes ---
	for _, t := range tasks {
		taskIDs[t.ID] = true
		nodes = append(nodes, GraphNode{
			ID:    "task:" + t.ID,
			Type:  "task",
			Label: t.Title,
			Data: map[string]interface{}{
				"status":   t.Status,
				"priority": t.Priority,
				"labels":   t.Labels,
				"assignee": t.Assignee,
			},
		})
	}

	// --- Doc nodes ---
	for _, d := range docs {
		docPaths[d.Path] = true
		nodes = append(nodes, GraphNode{
			ID:    "doc:" + d.Path,
			Type:  "doc",
			Label: d.Title,
			Data: map[string]interface{}{
				"tags":        d.Tags,
				"description": d.Description,
			},
		})
	}

	// --- Memory nodes ---
	for _, m := range memories {
		nodes = append(nodes, GraphNode{
			ID:    "memory:" + m.ID,
			Type:  "memory",
			Label: m.Title,
			Data: map[string]interface{}{
				"layer":    m.Layer,
				"category": m.Category,
				"tags":     m.Tags,
			},
		})
	}

	// --- Decision nodes ---
	for _, d := range decisions {
		nodes = append(nodes, GraphNode{
			ID:    "decision:" + d.ID,
			Type:  "decision",
			Label: d.Title,
			Data: map[string]interface{}{
				"status": d.Status,
				"tags":   d.Tags,
			},
		})
	}

	// --- Template nodes ---
	for _, tmpl := range templates {
		id := tmpl.Name
		if tmpl.IsImported && tmpl.ImportName != "" {
			id = tmpl.ImportName + "/" + tmpl.Name
		}
		nodes = append(nodes, GraphNode{
			ID:    "template:" + id,
			Type:  "template",
			Label: tmpl.Name,
			Data: map[string]interface{}{
				"description": tmpl.Description,
				"imported":    tmpl.IsImported,
				"source":      tmpl.ImportName,
			},
		})
	}

	// --- Edges from task fields ---
	for _, t := range tasks {
		src := "task:" + t.ID

		// Parent-child
		if t.Parent != "" && taskIDs[t.Parent] {
			edges = append(edges, GraphEdge{Source: src, Target: "task:" + t.Parent, Type: "parent"})
		}

		// Spec link
		if t.Spec != "" && docPaths[t.Spec] {
			edges = append(edges, GraphEdge{Source: src, Target: "doc:" + t.Spec, Type: "spec"})
		}

		// Cross-references in content
		content := strings.Join([]string{t.Description, t.ImplementationPlan, t.ImplementationNotes}, "\n")
		edges = append(edges, gr.extractMentions(src, content)...)
	}

	// --- Edges from doc content ---
	for _, d := range docs {
		src := "doc:" + d.Path
		edges = append(edges, gr.extractMentions(src, d.Content)...)
	}

	// --- Edges from memory content ---
	for _, m := range memories {
		src := "memory:" + m.ID
		edges = append(edges, gr.extractMentions(src, m.Content)...)
	}

	// --- Edges from decision content ---
	for _, d := range decisions {
		src := "decision:" + d.ID
		content := strings.Join([]string{
			d.Context,
			d.Decision,
			d.AlternativesConsidered,
			d.Consequences,
			d.Content,
			strings.Join(d.Sources, "\n"),
			strings.Join(d.RelatedDocs, "\n"),
			strings.Join(d.RelatedTasks, "\n"),
		}, "\n")
		edges = append(edges, gr.extractMentions(src, content)...)
	}

	// Ensure non-nil slices for JSON.
	if nodes == nil {
		nodes = []GraphNode{}
	}
	if edges == nil {
		edges = []GraphEdge{}
	}

	// Deduplicate edges.
	edges = deduplicateEdges(edges)

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"nodes": nodes,
		"edges": edges,
	})
}

// extractMentions scans content for semantic refs and returns edges from src to each resolved target.
func (gr *GraphRoutes) extractMentions(src, content string) []GraphEdge {
	var edges []GraphEdge

	for _, ref := range references.Extract(content) {
		if !ref.ValidRelation {
			continue
		}
		resolution := gr.getStore().ResolveReference(ref)
		if !resolution.Found || resolution.Entity == nil {
			continue
		}

		var target string
		switch resolution.Entity.Type {
		case "task":
			target = "task:" + resolution.Entity.ID
		case "doc":
			target = "doc:" + resolution.Entity.Path
		case "memory":
			target = "memory:" + resolution.Entity.ID
		case "decision":
			target = "decision:" + resolution.Entity.ID
		case "template":
			target = "template:" + resolution.Entity.ID
		default:
			continue
		}
		if target == src {
			continue
		}
		edges = append(edges, GraphEdge{
			Source: src,
			Target: target,
			Type:   ref.Relation,
			Data: map[string]interface{}{
				"raw":              ref.Raw,
				"explicitRelation": ref.ExplicitRelation,
			},
		})
	}

	return edges
}

// deduplicateEdges removes duplicate edges (same source+target+type).
func deduplicateEdges(edges []GraphEdge) []GraphEdge {
	type key struct{ s, t, ty string }
	seen := make(map[key]bool, len(edges))
	out := make([]GraphEdge, 0, len(edges))
	for _, e := range edges {
		k := key{e.Source, e.Target, e.Type}
		if !seen[k] {
			seen[k] = true
			out = append(out, e)
		}
	}
	return out
}

func BuildCodeGraph(store *storage.Store) ([]GraphNode, []GraphEdge) {
	var codeNodes []GraphNode
	var codeEdges []GraphEdge

	db := store.SemanticDB()
	if db == nil {
		return nil, nil
	}
	defer db.Close()

	// Check if code chunks exist (edges are optional)
	var codeChunkCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM chunks WHERE type = 'code'").Scan(&codeChunkCount); err != nil || codeChunkCount == 0 {
		return nil, nil
	}

	// Collect code chunk IDs and their info
	codeChunkIDs := make(map[string]bool)
	rows, err := db.Query("SELECT id FROM chunks WHERE type = 'code' ORDER BY id")
	if err != nil {
		return nil, nil
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			codeChunkIDs[id] = true
			kind, content := loadCodeChunkDetails(db, id)
			codeNodes = append(codeNodes, GraphNode{
				ID:    id,
				Type:  "code",
				Label: extractSymbolName(id),
				Data: map[string]interface{}{
					"docPath": extractDocPath(id),
					"kind":    kind,
					"content": content,
				},
			})
		}
	}
	rows.Close()

	if codeNodes == nil {
		return nil, nil
	}

	// Code edges from code_edges table
	edgeRows, err := db.Query(`SELECT
		from_id, to_id, edge_type,
		raw_target, target_name, target_qualifier, target_module_hint,
		receiver_type_hint, resolution_status, resolution_confidence, resolved_to
	FROM code_edges`)
	if err == nil {
		for edgeRows.Next() {
			var fromID, toID, edgeType string
			var rawTarget, targetName, targetQualifier, targetModuleHint string
			var receiverTypeHint, resolutionStatus, resolutionConfidence, resolvedTo string
			if err := edgeRows.Scan(
				&fromID, &toID, &edgeType,
				&rawTarget, &targetName, &targetQualifier, &targetModuleHint,
				&receiverTypeHint, &resolutionStatus, &resolutionConfidence, &resolvedTo,
			); err == nil {
				if !codeChunkIDs[fromID] {
					continue
				}
				edgeData := map[string]interface{}{
					"raw_target":            rawTarget,
					"target_name":           targetName,
					"target_qualifier":      targetQualifier,
					"target_module_hint":    targetModuleHint,
					"receiver_type_hint":    receiverTypeHint,
					"resolution_status":     resolutionStatus,
					"resolution_confidence": resolutionConfidence,
					"resolved_to":           resolvedTo,
					"display_target":        firstNonEmpty(resolvedTo, rawTarget, targetModuleHint, targetName, toID),
				}
				if codeChunkIDs[toID] && (edgeType == "contains" || edgeType == "calls" || edgeType == "implements" || edgeType == "imports" || edgeType == "instantiates" || edgeType == "has_method" || edgeType == "extends") {
					codeEdges = append(codeEdges, GraphEdge{
						Source: fromID,
						Target: toID,
						Type:   edgeType,
						Data:   edgeData,
					})
					continue
				}
				if resolutionStatus != "" {
					codeEdges = append(codeEdges, GraphEdge{
						Source: fromID,
						Target: toID,
						Type:   edgeType,
						Data:   edgeData,
					})
				}
			}
		}
		edgeRows.Close()
	}

	// code-ref edges: from docs/tasks to code nodes
	// We need to scan doc and task content for @code/ refs
	docs, _ := store.Docs.List()
	for _, d := range docs {
		fullDoc, err := store.Docs.Get(d.Path)
		if err != nil {
			continue
		}
		src := "doc:" + d.Path
		codeEdges = append(codeEdges, extractCodeMentions(src, fullDoc.Content, codeChunkIDs)...)
	}

	tasks, _ := store.Tasks.List()
	for _, t := range tasks {
		src := "task:" + t.ID
		content := t.Description + " " + t.ImplementationPlan + " " + t.ImplementationNotes
		codeEdges = append(codeEdges, extractCodeMentions(src, content, codeChunkIDs)...)
	}

	return codeNodes, codeEdges
}

// extractCodeMentions scans content for @code/ refs and returns edges to code nodes.
func extractCodeMentions(src, content string, codeChunkIDs map[string]bool) []GraphEdge {
	var edges []GraphEdge
	for _, m := range graphCodeRefRE.FindAllStringSubmatch(content, -1) {
		ref := m[1]
		var id string
		if idx := strings.Index(ref, "::"); idx >= 0 {
			docPath := ref[:idx]
			symbol := ref[idx+2:]
			id = fmt.Sprintf("code::%s::%s", docPath, symbol)
		} else {
			id = fmt.Sprintf("code::%s::__file__", ref)
		}
		if codeChunkIDs[id] {
			edges = append(edges, GraphEdge{Source: src, Target: id, Type: "code-ref"})
		}
	}
	return edges
}

// extractSymbolName extracts symbol name from a code chunk ID like "code::path/file.go::funcName".
func extractSymbolName(id string) string {
	parts := strings.SplitN(id, "::", 3)
	if len(parts) != 3 {
		return id
	}
	if parts[2] == "__file__" {
		return filepath.Base(parts[1])
	}
	return parts[2]
}

// extractDocPath extracts the doc path from a code chunk ID.
func extractDocPath(id string) string {
	parts := strings.SplitN(id, "::", 3)
	if len(parts) >= 2 {
		return parts[1]
	}
	return id
}

func loadCodeChunkDetails(db *sql.DB, id string) (kind, content string) {
	if db == nil {
		return "", ""
	}
	_ = db.QueryRow("SELECT field, content FROM chunks WHERE id = ?", id).Scan(&kind, &content)
	return kind, content
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
