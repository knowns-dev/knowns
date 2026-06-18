package storage

import (
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/references"
)

// StructuralResolve performs structural traversal from a semantic reference.
// It resolves the root entity, then collects and traverses typed relation edges
// according to the given params.
func (s *Store) StructuralResolve(raw string, params models.StructuralParams) (models.StructuralResult, error) {
	ref, ok := references.Parse(raw)
	if !ok {
		return models.StructuralResult{}, errInvalidRef(raw)
	}

	params.Normalize()

	// Resolve root entity.
	resolution := s.ResolveReference(ref)
	root := models.StructuralEntity{
		Kind: ref.Type,
		ID:   ref.Target,
	}
	if resolution.Found && resolution.Entity != nil {
		root.Title = resolution.Entity.Title
		if resolution.Entity.Path != "" {
			root.ID = resolution.Entity.Path
		} else if resolution.Entity.ID != "" {
			root.ID = resolution.Entity.ID
		}
	}

	// Build the full edge index once.
	allEdges := s.collectAllEdges()

	// BFS traversal.
	result := models.StructuralResult{
		Root:       root,
		Edges:      []models.StructuralEdge{},
		Unresolved: []models.UnresolvedEdge{},
	}

	// entityKey returns a canonical key for an entity.
	entityKey := func(kind, id string) string { return kind + ":" + id }

	rootKey := entityKey(root.Kind, root.ID)

	// Track visited entities to avoid cycles.
	visited := map[string]bool{rootKey: true}

	// Relation type filter set.
	relFilter := makeSet(params.RelationTypes)
	// Entity type filter set.
	entFilter := makeSet(params.EntityTypes)

	// BFS frontier: entity keys to expand at each depth level.
	frontier := []string{rootKey}

	for depth := 1; depth <= params.Depth && len(frontier) > 0; depth++ {
		var nextFrontier []string

		for _, currentKey := range frontier {
			// Collect edges for this entity.
			var candidates []rawEdge

			switch params.Direction {
			case "outbound":
				candidates = allEdges.outbound[currentKey]
			case "inbound":
				candidates = allEdges.inbound[currentKey]
			case "both":
				candidates = append(candidates, allEdges.outbound[currentKey]...)
				candidates = append(candidates, allEdges.inbound[currentKey]...)
			}

			for _, c := range candidates {
				// Apply relation filter.
				if len(relFilter) > 0 && !relFilter[c.relation] {
					continue
				}

				// Determine the "other" entity (the one we're traversing to).
				otherKey := c.targetKey
				otherKind := c.targetKind
				direction := "outbound"
				if c.sourceKey == currentKey && c.targetKey == currentKey {
					// Self-reference — skip.
					continue
				}
				if c.targetKey == currentKey {
					// This is an inbound edge from the perspective of currentKey.
					otherKey = c.sourceKey
					otherKind = c.sourceKind
					direction = "inbound"
				}

				// Apply entity type filter.
				if len(entFilter) > 0 && !entFilter[otherKind] {
					continue
				}

				// Check if target is resolved.
				if !c.resolved {
					result.Unresolved = append(result.Unresolved, models.UnresolvedEdge{
						Ref:    c.rawRef,
						Reason: "entity not found",
					})
					continue
				}

				// Build structural edge.
				edge := models.StructuralEdge{
					Source: models.StructuralEntity{
						Kind:  c.sourceKind,
						ID:    c.sourceID,
						Title: c.sourceTitle,
					},
					Target: models.StructuralEntity{
						Kind:  c.targetKind,
						ID:    c.targetID,
						Title: c.targetTitle,
					},
					Relation:  c.relation,
					Direction: direction,
					Depth:     depth,
					Origin:    c.origin,
					Resolved:  true,
				}
				result.Edges = append(result.Edges, edge)

				// Add to next frontier if not visited.
				if !visited[otherKey] {
					visited[otherKey] = true
					nextFrontier = append(nextFrontier, otherKey)
				}
			}
		}

		frontier = nextFrontier
	}

	return result, nil
}
