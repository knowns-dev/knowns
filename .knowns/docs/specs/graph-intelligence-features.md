---
id: doc-4d381a6792bb4be0a332e7e7f9c3d84d
title: Graph Intelligence Features
description: Specification for graph-enhanced search, impact analysis, and cluster detection
createdAt: '2026-04-02T09:42:57.532Z'
updatedAt: '2026-04-06T07:01:35.127Z'
tags:
  - spec
  - approved
---

## Overview

Three intelligence features for the Knowledge Graph WebUI that transform the graph from a passive visualization into an active analysis tool. These features leverage the existing graph structure (160 nodes, 142 edges) to help users discover relationships, assess change impact, and understand project structure.

## Locked Decisions

- D1: Graph search is graph-page only — search input on toolbar, highlights nodes directly on canvas
- D2: Impact analysis shows 2 hops (fixed) — direct connections + their connections
- D3: Cluster detection is view-only — color-code clusters, show count + sizes, no label suggestions

## Requirements

### Functional Requirements

#### Graph-Enhanced Search
- FR-1: Search input in graph toolbar accepts text queries
- FR-2: Search calls existing /api/search endpoint to find matching tasks/docs
- FR-3: Matched nodes are highlighted with bright style on the graph canvas
- FR-4: Nodes connected to matches (1-2 hops) are highlighted with softer style
- FR-5: Non-matching, non-connected nodes are dimmed
- FR-6: Search input is debounced (300ms)
- FR-7: Clearing search restores all nodes to normal state
- FR-8: Match count displayed next to search input

#### Impact Analysis
- FR-9: "Show Impact" button in node detail panel
- FR-10: Clicking "Show Impact" highlights all nodes within 2 hops of selected node
- FR-11: Hop 1 nodes highlighted with strong opacity, hop 2 with softer opacity
- FR-12: Edges in impact path are also highlighted
- FR-13: Impact summary overlay shows "Affects X tasks, Y docs" count
- FR-14: Clicking background or "Clear Impact" dismisses the impact view
- FR-15: Impact mode and hover mode are mutually exclusive — impact takes priority

#### Cluster Detection
- FR-16: "Clusters" toggle button in toolbar
- FR-17: When enabled, detect connected components using graph algorithm
- FR-18: Each cluster assigned a distinct color from a palette
- FR-19: Node colors temporarily overridden by cluster color
- FR-20: Cluster info overlay shows: number of clusters, size of each cluster
- FR-21: Toggling off restores original node colors
- FR-22: Isolated nodes (no edges) form their own single-node clusters or are grouped as "Isolated"

### Non-Functional Requirements
- NFR-1: Search highlighting must respond within 100ms for 200 nodes
- NFR-2: Impact BFS must complete within 50ms for 200 nodes
- NFR-3: Cluster detection must complete within 100ms for 200 nodes
- NFR-4: All features work in both light and dark mode

## Acceptance Criteria

- [ ] AC-1: Typing "auth" in graph search highlights matching nodes and their neighbors, dimming the rest
- [ ] AC-2: Clearing search input restores all nodes to normal appearance
- [ ] AC-3: Clicking "Show Impact" on a spec doc node highlights all linked tasks within 2 hops
- [ ] AC-4: Impact summary shows correct count of affected tasks and docs
- [ ] AC-5: Toggling "Clusters" on colors nodes by connected component
- [ ] AC-6: Cluster info overlay shows correct number of clusters and their sizes
- [ ] AC-7: All three features work correctly in dark mode

## Scenarios

### Scenario 1: Search for related entities
**Given** the graph is loaded with 89 connected nodes
**When** user types "auth" in the search input
**Then** nodes matching "auth" are highlighted bright, their 1-hop neighbors are highlighted softer, and all other nodes are dimmed. Match count shows "N matches".

### Scenario 2: Search with no results
**Given** the graph is loaded
**When** user types "xyznonexistent" in the search input
**Then** all nodes remain normal, match count shows "0 matches"

### Scenario 3: Impact of a spec document
**Given** a spec doc node is connected to 5 task nodes (hop 1), and 2 of those tasks connect to other docs (hop 2)
**When** user clicks the spec doc, then clicks "Show Impact"
**Then** the spec doc + 5 tasks are highlighted at hop 1 opacity, 2 additional docs at hop 2 opacity. Summary shows "Affects 5 tasks, 2 docs".

### Scenario 4: Impact on isolated node
**Given** a node with no connections
**When** user clicks it and clicks "Show Impact"
**Then** only that node is highlighted. Summary shows "Affects 0 tasks, 0 docs".

### Scenario 5: Cluster detection
**Given** the graph has 3 connected components of sizes 15, 8, 4 and 71 isolated nodes
**When** user toggles "Clusters" on
**Then** each component gets a distinct color. Cluster overlay shows "3 clusters + 71 isolated". Isolated nodes are grouped under "Isolated" label.

### Scenario 6: Cluster toggle off
**Given** clusters are active
**When** user toggles "Clusters" off
**Then** original node colors (task blue, doc blue, memory green) are restored

## Technical Notes

- All three features are client-side only — no backend changes needed for the first pass.
- Primary implementation surface is @code/ui/src/pages/GraphPage.tsx.
- Node detail interactions live in @code/ui/src/pages/GraphDetailPanel.tsx.
- Graph data typing and fetch shape live in @code/ui/src/api/client.ts.
- Search uses existing graph data plus client-side traversal for neighbors.
- Impact uses Cytoscape traversal over the rendered graph.
- Clusters use Cytoscape connected-components detection on the rendered graph.
- Features are mutually exclusive modes: search, impact, clusters, or normal view.
- Cytoscape CSS classes should drive visual states instead of direct style mutation.
## Open Questions

- [ ] Should search also match on node metadata (status, labels, tags) or just title/content?
