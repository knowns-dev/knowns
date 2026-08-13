---
title: Knowledge Graph WebUI Learnings
description: Knowledge graph WebUI implementation learnings, patterns, decisions, and failures.
createdAt: '2026-04-02T10:17:20.355Z'
updatedAt: '2026-08-13T13:41:40.214Z'
tags: []
---

## Patterns

### Cytoscape.js Container Sizing
- **What:** The flex-1 wrapper div must be the direct Cytoscape container. Overlays (legend, detail panel, impact summary) must be sibling divs with `position: absolute`, not children inside the Cytoscape container.
- **Why:** Cytoscape takes ownership of all DOM children inside its container div and will wipe them on re-render. Any overlay rendered inside the container disappears.
- **When to use:** Any Cytoscape.js integration in a React app.

```tsx
// Correct structure
<div className="flex-1 min-h-0 relative">
  <div ref={containerRef} style={{ width: "100%", height: "100%" }} />  {/* Cytoscape renders here */}
  <div className="absolute top-4 right-4 ...">Detail panel</div>        {/* Overlay: sibling */}
  <div className="absolute bottom-4 left-4 ...">Legend</div>            {/* Overlay: sibling */}
</div>
```

### Always-Mounted Container for ResizeObserver
- **What:** Never early-return before mounting the Cytoscape container div. Render the container always; show loading spinners as absolute overlays on top.
- **Why:** If you `return <Spinner />` before the container div mounts, the ResizeObserver never fires and Cytoscape never gets dimensions. The graph renders 0×0.
- **Source:** @doc/specs/graph-intelligence-features

### Client-Side Graph Intelligence via Cytoscape API
- **What:** Search, impact analysis, and cluster detection are all implemented client-side using Cytoscape traversal APIs — no backend changes needed.
- **APIs used:**
  - `cy.$id(nodeId)` + `.closedNeighborhood()` for search neighbor highlighting
  - `cy.elements().bfs()` for 2-hop impact BFS traversal
  - `cy.elements().components()` for cluster detection
- **When to use:** Any graph intelligence feature that operates on already-fetched graph data.

### Graph Backend Shape
- **What:** `/api/graph` returns `{ nodes: [{id, label, type, data}], edges: [{id, source, target, type}] }`. Node IDs are prefixed: `task:`, `doc:`, `memory:`.
- **Why:** Prefixed IDs allow merging nodes from multiple entity types without ID collisions.
- **Mention edges:** Detected server-side by regex matching `@task-([a-z0-9]+)` and `@doc/([^\s\)]+)` in task/doc content. Deduplication via `deduplicateEdges()`.

### Cytoscape CSS Class Mode for Visual State
- **What:** Use `.addClass()` / `.removeClass()` with Cytoscape stylesheet classes for all visual state changes (hover, search highlight, impact, cluster).
- **Why:** Cleaner than per-node style overrides; supports easy `clearGraphMode()` by removing all state classes at once.
- **Key classes:** `.search-match`, `.search-neighbor`, `.impact-root`, `.impact-hop1`, `.impact-hop2`, `.cluster-colored`, `.dimmed`, `.highlighted`

---

## Decisions

### Cytoscape.js over react-force-graph-2d
- **Chose:** Cytoscape.js
- **Over:** react-force-graph-2d (canvas-based, D3 force layout)
- **Tag:** GOOD_CALL
- **Reason:** react-force-graph-2d had persistent container sizing issues (canvas never filled the parent) and limited support for CSS-class-based state management. Cytoscape.js offers imperative DOM control, rich traversal API (bfs, components), and reliable resize handling.

### `cose` layout over `fcose`
- **Chose:** Built-in `cose` layout
- **Over:** `cytoscape-fcose` plugin
- **Tag:** GOOD_CALL
- **Reason:** fcose requires an npm package (`cytoscape-fcose`) and extra registration. Built-in cose works without plugins and produces acceptable layouts. Avoid optional plugins unless the quality gap is significant.

### Isolated nodes hidden by default
- **Chose:** Toggle to show/hide isolated nodes (no edges)
- **Over:** Always showing them
- **Tag:** GOOD_CALL
- **Reason:** Large graphs become unreadable when flooded with isolated nodes. A toggle keeps the default view clean while letting users see everything when needed.

### Graph as read-only view
- **Chose:** Graph page is view-only (no editing from graph)
- **Over:** Inline editing from node click
- **Tag:** GOOD_CALL
- **Reason:** Editing via graph introduces complex UX. Clicking a node opens a detail panel with a link to navigate to the entity's full edit page.

---

## Failures

### Spread overwriting computed color
- **What:** `{ color: computedColor, ...n.data }` — data fields overwrote computed color.
- **Fix:** Move spread to beginning: `{ ...n.data, color: computedColor }`.
- **Lesson:** When building objects with both computed fields and spread data, always put the spread first so explicit fields win.

### Font size disappearing on zoom-in
- **What:** Label visibility check `fontSize >= 2.5` checked graph-coordinate size, not screen pixels. Zooming in made the threshold meaningless.
- **Fix:** `screenFontSize = fontSize * globalScale >= 8` — multiply by Cytoscape's `globalScale` to get screen pixels.
- **Lesson:** Any size threshold in Cytoscape canvas rendering must account for zoom level via `globalScale`.

### `fcose` layout error after package removal
- **What:** Removed `cytoscape-fcose` package but missed one `name: "fcose"` occurrence in the layout config, causing runtime error.
- **Fix:** Use `replace_all: true` when renaming config values across a file.
- **Lesson:** When removing a library, grep for all string references (not just imports) before finishing.

### Re-layout spreading nodes apart
- **What:** Calling `d3ReheatSimulation()` repeatedly added energy without resetting force strengths, spreading nodes further each time.
- **Fix:** Reset `charge.strength(-100)` and `link.distance(30)` before reheat, then `zoomToFit` after 1 second.
- **Lesson:** When re-simulating a graph layout, reset force parameters first to prevent energy accumulation.


---

## Session 2026-04-08: Code Context Retrieval + Large Graph Tuning

### Patterns

#### Code Context Retrieval Order
- **What:** For code context retrieval, the most reliable flow is:
  1. `code_search` / `knowns code search` for entry-point discovery
  2. `code_symbols` / `knowns code symbols` to verify indexed symbols in a file or scope
  3. `code_deps` / `knowns code deps` to inspect raw relationships
- **Why:** Search is best for discovery, symbols are best for verifying parser/index results, and deps are best for confirming relationships. Using raw graph output first creates more noise than signal.
- **When to use:** Any agent or user workflow that needs code context for reasoning, debugging ingest, or exploring an unfamiliar codebase.
- **Source:** @task-ckvvph @task-ogh5sx @task-r2mekv

#### Keep Code Search and Generic Search Separate
- **What:** Keep code retrieval on dedicated commands/tools (`knowns code search`, MCP `code_search`) instead of pushing `type=code` into generic docs/tasks/memory search.
- **Why:** Code search has different ranking rules, neighborhood expansion, and output shape. Mixing it into generic search would blur semantics and make both paths harder to reason about.
- **When to use:** CLI/MCP feature design for code intelligence.
- **Source:** @task-ckvvph @task-r2mekv

#### Tree Rendering Works Better Than Flat Edge Lists for Code Search CLI
- **What:** In CLI output, render each code search match as a root with grouped relationship children instead of printing one flat list of nearby edges.
- **Why:** Grouping by match keeps local context readable and avoids mixing multiple symbols' neighborhoods together.
- **When to use:** Terminal output for neighborhood exploration or dependency inspection.
- **Source:** @task-ckvvph @task-ogh5sx

#### Large Graphs Need a Separate Performance Layout Mode
- **What:** For large Cytoscape graphs, use a dedicated performance mode with lighter layout settings and fewer expensive post-layout operations instead of reusing the same high-quality layout config for every graph size.
- **Why:** Full-quality layout on 2k+ nodes / 6k+ edges can become too slow; the graph must still load quickly enough to remain usable.
- **Trade-off:** Performance mode should still preserve some structure; ultra-fast fallbacks like raw grid layout are too ugly for real graph inspection.
- **Source:** Graph UI tuning work in this session

### Decisions

#### Separate MCP and CLI Roles for Code Retrieval
- **Chose:** Prefer MCP code tools for agent workflows and treat CLI code commands as fallback for manual inspection/debugging.
- **Over:** Treating CLI and MCP as equivalent primary interfaces.
- **Tag:** GOOD_CALL
- **Outcome:** The tool stack became easier to reason about: MCP for structured machine-readable retrieval, CLI for human inspection.
- **Recommendation:** Keep this distinction explicit in generated shim guidance and CLI help text.

#### Drop `knowns code graph` from CLI Command Tree
- **Chose:** Remove raw `code graph` from CLI while keeping more useful `search`, `symbols`, and `deps` commands.
- **Over:** Keeping a full-graph CLI command alongside higher-signal tools.
- **Tag:** GOOD_CALL
- **Outcome:** The CLI surface became smaller and more focused on commands that help users actually understand context.
- **Recommendation:** Keep raw graph access in Web UI or advanced/internal tooling rather than making it a primary CLI path.

#### Use Domain Anchor First, Intent Boost Second for Code Search Ranking
- **Chose:** Require strong anchor matches in `name`, `path`, or `signature` before allowing intent words like `api`, `page`, `controller`, or `service` to boost results.
- **Over:** Letting intent words or generic content matches pull results up on their own.
- **Tag:** GOOD_CALL
- **Outcome:** Fewer false positives from DTOs, Swagger boilerplate, and generic API text.
- **Recommendation:** Keep strong-vs-weak retrieval lanes distinct. Content-only matches should be fallback, not the main result path.

#### Do Not Force `Function` Count Inflation for TypeScript
- **Chose:** Stop short of indexing anonymous closures and local callback-style wrappers as top-level `Function` symbols.
- **Over:** Promoting every function-like closure just to increase parity counts.
- **Tag:** GOOD_CALL
- **Outcome:** The code model stayed cleaner and closer to what users actually want to inspect, even if raw parity numbers remained lower.
- **Recommendation:** Only add new symbol kinds when they improve retrieval quality, not just benchmark totals.

### Failures

#### Filtering After LIMIT Produces Unstable CLI/MCP Results
- **What went wrong:** `code symbols` and `code deps` originally applied `LIMIT` first and then filtered rows in Go. Valid filters like `--path` could return zero or misleading samples.
- **Root cause:** SQL query shape was wrong for filtered inspection commands.
- **Prevention:** For inspection commands, put filters in `WHERE` first, then `ORDER BY ... LIMIT`.
- **Source:** @task-r2mekv

#### Editing Generated Shim Files Directly Is the Wrong Fix Point
- **What went wrong:** Guidance was briefly added directly to generated shim markdown files instead of the generator source.
- **Root cause:** Fix was applied at the output layer instead of the generation layer.
- **Prevention:** When a file is generated or synced, update the generator/source-of-generation first, then regenerate or re-sync.

#### Ultra-Fast Grid Fallback Makes Large Graphs Unusable
- **What went wrong:** Switching very large graphs to a raw grid layout improved speed but made the visualization collapse into an ugly, low-signal arrangement.
- **Root cause:** Performance was optimized without preserving enough structural meaning in the layout.
- **Prevention:** Use a lighter force layout mode for large graphs, not a purely geometric fallback, unless the graph is only being used as a raw overview.

#### Query Intent Without a Real Domain Anchor Should Fail Closed
- **What went wrong:** Queries like `Booking Page API` originally returned convincing-but-wrong DTO/API boilerplate because generic words in content were enough to rank results.
- **Root cause:** Content matches and intent words were allowed to rescue weak candidates.
- **Prevention:** Require a strong anchor in symbol/path/signature before applying intent boosts. If no strong anchor exists, return no strong results rather than hallucinated relevance.
