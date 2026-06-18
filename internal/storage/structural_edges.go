package storage

import (
	"fmt"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/references"
)

// rawEdge is an internal edge representation used during collection and dedup.
type rawEdge struct {
	sourceKind  string
	sourceID    string
	sourceTitle string
	sourceKey   string // "kind:id"
	targetKind  string
	targetID    string
	targetTitle string
	targetKey   string // "kind:id"
	relation    string
	origin      string // "field-backed", "inline", "code-graph"
	resolved    bool
	rawRef      string // original reference string for unresolved edges
}

// dedupKey returns the deduplication key for an edge.
func (e rawEdge) dedupKey() string {
	return e.sourceKey + "|" + e.targetKey + "|" + e.relation
}

// edgeIndex holds all collected edges indexed by source and target for fast lookup.
type edgeIndex struct {
	outbound map[string][]rawEdge // key: "kind:id" of source
	inbound  map[string][]rawEdge // key: "kind:id" of target
}

// collectAllEdges gathers edges from all three sources, deduplicates, and
// returns an indexed structure for traversal.
func (s *Store) collectAllEdges() edgeIndex {
	var all []rawEdge

	// 1. Field-backed edges (highest priority).
	all = append(all, s.collectFieldBackedEdges()...)

	// 2. Inline ref edges.
	all = append(all, s.collectInlineRefEdges()...)

	// Deduplicate: keep highest-priority origin per (source, target, relation).
	deduped := deduplicateRawEdges(all)

	// Build index.
	idx := edgeIndex{
		outbound: make(map[string][]rawEdge, len(deduped)),
		inbound:  make(map[string][]rawEdge, len(deduped)),
	}
	for _, e := range deduped {
		idx.outbound[e.sourceKey] = append(idx.outbound[e.sourceKey], e)
		idx.inbound[e.targetKey] = append(idx.inbound[e.targetKey], e)
	}
	return idx
}

// collectFieldBackedEdges extracts edges from task fields: parent, spec, fulfills.
func (s *Store) collectFieldBackedEdges() []rawEdge {
	tasks, err := s.Tasks.List()
	if err != nil {
		return nil
	}

	// Build doc title lookup.
	docs, _ := s.Docs.List()
	docTitles := make(map[string]string, len(docs))
	for _, d := range docs {
		docTitles[d.Path] = d.Title
	}

	// Build task title lookup.
	taskTitles := make(map[string]string, len(tasks))
	for _, t := range tasks {
		taskTitles[t.ID] = t.Title
	}

	var edges []rawEdge

	for _, t := range tasks {
		srcKey := "task:" + t.ID

		// Parent → child (task → task).
		if t.Parent != "" {
			parentTitle := taskTitles[t.Parent]
			resolved := parentTitle != "" || t.Parent == t.ID // self-ref is resolved but will be filtered
			if _, err := s.Tasks.Get(t.Parent); err == nil {
				resolved = true
			}
			edges = append(edges, rawEdge{
				sourceKind:  "task",
				sourceID:    t.ID,
				sourceTitle: t.Title,
				sourceKey:   srcKey,
				targetKind:  "task",
				targetID:    t.Parent,
				targetTitle: parentTitle,
				targetKey:   "task:" + t.Parent,
				relation:    "parent",
				origin:      models.OriginFieldBacked,
				resolved:    resolved,
			})
		}

		// Spec link (task → doc).
		if t.Spec != "" {
			specTitle := docTitles[t.Spec]
			resolved := specTitle != ""
			if _, err := s.Docs.Get(t.Spec); err == nil {
				resolved = true
			}
			edges = append(edges, rawEdge{
				sourceKind:  "task",
				sourceID:    t.ID,
				sourceTitle: t.Title,
				sourceKey:   srcKey,
				targetKind:  "doc",
				targetID:    t.Spec,
				targetTitle: specTitle,
				targetKey:   "doc:" + t.Spec,
				relation:    "spec",
				origin:      models.OriginFieldBacked,
				resolved:    resolved,
			})

			// Also create an "implements" edge from task to spec doc
			// (field-backed because it's derived from the spec field).
			edges = append(edges, rawEdge{
				sourceKind:  "task",
				sourceID:    t.ID,
				sourceTitle: t.Title,
				sourceKey:   srcKey,
				targetKind:  "doc",
				targetID:    t.Spec,
				targetTitle: specTitle,
				targetKey:   "doc:" + t.Spec,
				relation:    "implements",
				origin:      models.OriginFieldBacked,
				resolved:    resolved,
			})
		}
	}

	// Template → doc (template-for).
	templates, _ := s.Templates.List()
	for _, tmpl := range templates {
		if tmpl.Doc != "" {
			docTitle := docTitles[tmpl.Doc]
			resolved := docTitle != ""
			if _, err := s.Docs.Get(tmpl.Doc); err == nil {
				resolved = true
			}
			edges = append(edges, rawEdge{
				sourceKind:  "template",
				sourceID:    tmpl.Name,
				sourceTitle: tmpl.Name,
				sourceKey:   "template:" + tmpl.Name,
				targetKind:  "doc",
				targetID:    tmpl.Doc,
				targetTitle: docTitle,
				targetKey:   "doc:" + tmpl.Doc,
				relation:    "template-for",
				origin:      models.OriginFieldBacked,
				resolved:    resolved,
			})
		}
	}

	return edges
}

// collectInlineRefEdges extracts edges from inline @references in content.
func (s *Store) collectInlineRefEdges() []rawEdge {
	var edges []rawEdge

	// From tasks.
	tasks, _ := s.Tasks.List()
	for _, t := range tasks {
		content := strings.Join([]string{t.Description, t.ImplementationPlan, t.ImplementationNotes}, "\n")
		for _, ref := range references.Extract(content) {
			if !ref.ValidRelation {
				continue
			}
			e := s.refToEdge("task", t.ID, t.Title, ref, models.OriginInline)
			edges = append(edges, e)
		}
	}

	// From docs.
	docs, _ := s.Docs.List()
	for _, d := range docs {
		for _, ref := range references.Extract(d.Content) {
			if !ref.ValidRelation {
				continue
			}
			e := s.refToEdge("doc", d.Path, d.Title, ref, models.OriginInline)
			edges = append(edges, e)
		}
	}

	// From memories.
	memories, _ := s.Memory.List("")
	for _, m := range memories {
		for _, ref := range references.Extract(m.Content) {
			if !ref.ValidRelation {
				continue
			}
			e := s.refToEdge("memory", m.ID, m.Title, ref, models.OriginInline)
			edges = append(edges, e)
		}
	}

	// From decisions.
	decisions, _ := s.Decisions.List()
	for _, d := range decisions {
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
		for _, ref := range references.Extract(content) {
			if !ref.ValidRelation {
				continue
			}
			e := s.refToEdge("decision", d.ID, d.Title, ref, models.OriginInline)
			edges = append(edges, e)
		}
	}

	return edges
}

// refToEdge converts a parsed semantic reference into a rawEdge.
func (s *Store) refToEdge(srcKind, srcID, srcTitle string, ref models.SemanticReference, origin string) rawEdge {
	srcKey := srcKind + ":" + srcID

	targetKind := ref.Type
	targetID := ref.Target
	targetTitle := ""
	resolved := false

	resolution := s.ResolveReference(ref)
	if resolution.Found && resolution.Entity != nil {
		resolved = true
		targetTitle = resolution.Entity.Title
		if resolution.Entity.Path != "" {
			targetID = resolution.Entity.Path
		} else if resolution.Entity.ID != "" {
			targetID = resolution.Entity.ID
		}
	}

	targetKey := targetKind + ":" + targetID

	return rawEdge{
		sourceKind:  srcKind,
		sourceID:    srcID,
		sourceTitle: srcTitle,
		sourceKey:   srcKey,
		targetKind:  targetKind,
		targetID:    targetID,
		targetTitle: targetTitle,
		targetKey:   targetKey,
		relation:    ref.Relation,
		origin:      origin,
		resolved:    resolved,
		rawRef:      ref.Raw,
	}
}

// deduplicateRawEdges keeps the highest-priority origin per (source, target, relation).
func deduplicateRawEdges(edges []rawEdge) []rawEdge {
	best := make(map[string]rawEdge, len(edges))
	for _, e := range edges {
		key := e.dedupKey()
		existing, ok := best[key]
		if !ok || models.OriginPriority(e.origin) < models.OriginPriority(existing.origin) {
			best[key] = e
		}
	}

	result := make([]rawEdge, 0, len(best))
	for _, e := range best {
		result = append(result, e)
	}
	return result
}

// makeSet creates a lookup set from a string slice. Empty slice returns nil.
func makeSet(items []string) map[string]bool {
	if len(items) == 0 {
		return nil
	}
	set := make(map[string]bool, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item != "" {
			set[item] = true
		}
	}
	if len(set) == 0 {
		return nil
	}
	return set
}

// errInvalidRef returns a formatted error for invalid references.
func errInvalidRef(raw string) error {
	return fmt.Errorf("invalid semantic reference: %q", raw)
}
