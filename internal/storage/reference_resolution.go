package storage

import (
	"fmt"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/references"
)

// ResolveRawReference parses and resolves a semantic reference expression.
func (s *Store) ResolveRawReference(raw string) (models.SemanticResolution, error) {
	ref, ok := references.Parse(raw)
	if !ok {
		return models.SemanticResolution{}, fmt.Errorf("invalid semantic reference: %q", raw)
	}
	return s.ResolveReference(ref), nil
}

// ResolveReference resolves a parsed semantic reference against the current store.
func (s *Store) ResolveReference(ref models.SemanticReference) models.SemanticResolution {
	result := models.SemanticResolution{Reference: ref}

	switch ref.Type {
	case "task":
		task, err := s.Tasks.Get(ref.Target)
		if err != nil {
			return result
		}
		result.Entity = &models.ResolvedEntity{
			Type:     "task",
			ID:       task.ID,
			Title:    task.Title,
			Status:   task.Status,
			Priority: task.Priority,
			Tags:     task.Labels,
		}
		result.Found = true
	case "doc":
		doc, err := s.Docs.Get(ref.Target)
		if err != nil {
			return result
		}
		result.Entity = &models.ResolvedEntity{
			Type:     "doc",
			ID:       doc.Path,
			Path:     doc.Path,
			Title:    doc.Title,
			Tags:     doc.Tags,
			Imported: doc.IsImported,
			Source:   doc.ImportSource,
		}
		result.Found = true
	case "memory":
		memory, err := s.Memory.ResolveReferenceTarget(ref.Target)
		if err != nil {
			return result
		}
		result.Entity = &models.ResolvedEntity{
			Type:        "memory",
			ID:          memory.ID,
			Title:       memory.Title,
			Tags:        memory.Tags,
			MemoryLayer: memory.Layer,
			Category:    memory.Category,
		}
		result.Found = true
	case "decision":
		decision, err := s.Decisions.Get(ref.Target)
		if err != nil {
			return result
		}
		result.Entity = &models.ResolvedEntity{
			Type:   "decision",
			ID:     decision.ID,
			Title:  decision.Title,
			Status: decision.Status,
			Tags:   decision.Tags,
		}
		result.Found = true
	case "template":
		tmpl, err := s.Templates.Get(ref.Target)
		if err != nil {
			return result
		}
		result.Entity = &models.ResolvedEntity{
			Type:     "template",
			ID:       ref.Target,
			Title:    tmpl.Name,
			Imported: tmpl.IsImported,
			Source:   tmpl.ImportName,
		}
		result.Found = true
	}

	return result
}
