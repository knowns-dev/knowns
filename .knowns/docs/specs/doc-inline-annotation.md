---
title: Doc Inline Annotation
description: Specification for inline annotation on rendered docs in WebUI — select text, annotate (comment/replace/delete), stack across docs, copy structured markdown for agent feedback.
createdAt: '2026-05-04T19:33:07.814Z'
updatedAt: '2026-05-04T19:40:34.157Z'
tags:
  - spec
  - approved
  - webui
  - annotation
  - ux
---

## Overview

Add inline annotation capability to the doc viewer in Knowns WebUI. Users select text on rendered markdown, annotate it (comment, suggest replacement, or mark for deletion), and copy all annotations as structured markdown to paste into an AI agent (OpenCode, Claude Code, etc.) as feedback.

Inspired by Plannotator's annotation model and Agentation's bubble UX, adapted for Knowns' local-first, doc-centric workflow. No backend changes required — annotations live in LocalStorage and the output is a copy-to-clipboard action.

## Locked Decisions

- D1: Annotate on rendered markdown (prose view), not raw source
- D2: Full annotation set — comment, suggest replacement, mark delete
- D3: Stack annotations from multiple docs, copy all at once
- D4: Structured markdown output grouped by doc path
- D5: LocalStorage persistence — survives reload, no backend needed
- D6: Floating toolbar (Medium/Notion style) appears on text selection
- D7: Annotation panel as bubble/popover (Agentation-style) — floating badge, click to expand annotation list
- D8: UI reference: Agentation's toolbar UX — compact bubble toggle, inline popovers, numbered markers, copy button in toolbar
- D9: Bubble is draggable — user can reposition it anywhere within the doc viewer to avoid blocking content

## Requirements

### Functional Requirements

- FR-1: When user selects text in the rendered doc view, a floating toolbar appears near the selection with three actions: Comment, Replace, Delete
- FR-2: **Comment** — user writes a free-text comment attached to the selected text
- FR-3: **Replace** — user writes suggested replacement text for the selected text
- FR-4: **Delete** — marks the selected text for deletion (no additional input needed, but optional reason field)
- FR-5: Annotations are visually indicated on the rendered doc (highlight color per type: yellow for comment, blue for replace, red/strikethrough for delete)
- FR-6: Clicking an existing annotation opens it for editing or removal
- FR-7: Annotations persist in LocalStorage keyed by doc path — survive page reload
- FR-8: Annotations from multiple docs accumulate in a shared annotation stack
- FR-9: A global "Annotations" indicator (badge with count) is visible when annotations exist
- FR-10: "Copy All Annotations" action serializes all stacked annotations as structured markdown to clipboard
- FR-11: "Clear All" action removes all annotations from all docs (with confirmation)
- FR-12: Individual annotations can be removed without clearing all
- FR-13: Annotation mode can be toggled on/off — when off, text selection behaves normally
- FR-14: Bubble is draggable within the doc viewer area; position persists in LocalStorage

### Non-Functional Requirements

- NFR-1: Floating toolbar appears within 100ms of text selection — no perceptible lag
- NFR-2: Annotation highlights must not break existing markdown rendering or link/badge interactions
- NFR-3: Annotations must gracefully handle doc content changes — if the annotated text no longer exists in the doc, the annotation is marked as orphaned (visually distinct, still included in export with a warning)
- NFR-4: LocalStorage usage should be bounded — max 500 annotations total, oldest auto-pruned if exceeded
- NFR-5: Works on both desktop and tablet viewports (mobile can be deferred)
- NFR-6: Follows existing UI patterns — Radix UI primitives, TailwindCSS, cn() utility, atomic design

## Annotation Data Model

```typescript
interface Annotation {
  id: string;                    // nanoid
  docPath: string;               // e.g. "specs/agent-workspace"
  selectedText: string;          // the text that was selected
  type: "comment" | "replace" | "delete";
  content: string;               // comment text, replacement text, or delete reason
  createdAt: number;             // timestamp
  // Position hint for re-anchoring after doc changes
  contextBefore: string;         // ~30 chars before selection
  contextAfter: string;          // ~30 chars after selection
}
```

## Copy Output Format

```markdown
## Annotations on @doc/specs/agent-workspace

### 💬 Comment
> "Spawn agents using direct process execution"
Should use git worktree isolation instead of direct process execution to avoid conflicts.

### ✏️ Replace
> "WebSocket Protocol"
→ "SSE Protocol" — SSE infrastructure already exists, no need for WebSocket.

### 🗑️ Delete
> ~~"Phase 6: Error Handling — defer to Phase 2"~~
Remove this phase, handle errors inline from the start.

---

## Annotations on @doc/specs/ai-permission-model

### 💬 Comment
> "Session Override"
Clarify: does session override persist across restarts?
```

## UX Flow

### Agentation-Style Bubble

- Floating bubble icon (highlighter pen) positioned in the doc viewer — defaults to bottom-right, Agentation-style
- Badge count displays the current number of annotations
- Click bubble → expands into a compact panel (popover above the bubble):
  - Annotation list grouped by doc (scrollable)
  - Each item: numbered marker, type icon, selected text preview (truncated), content preview
  - Copy All button (📋) — copies structured markdown to clipboard
  - Clear All button (🗑️) — removes all annotations (with confirmation dialog)
  - Click an item → navigates to the doc and scrolls to the annotation position
  - Individual remove action on each item
- Click bubble again or click outside → collapses back to bubble
- Bubble is draggable — user can reposition it anywhere within the doc viewer to avoid blocking content; position persists in LocalStorage

### Annotation Mode Toggle

- Bubble has two states: **inactive** (shows count only) and **active** (annotation mode enabled)
- Click-and-hold or double-click bubble → toggles annotation mode
- When active: bubble shows an accent color ring (subtle pulse animation), doc content gets a faint overlay hint
- When inactive: text selection works normally (copy/paste)

### Creating an Annotation

1. User activates annotation mode (via bubble)
2. User selects text in the rendered doc
3. Floating toolbar appears above/below the selection (auto-positioned to stay within viewport)
4. Toolbar shows three compact buttons: 💬 Comment | ✏️ Replace | 🗑️ Delete
5. Click Comment/Replace → inline popover with textarea (auto-focused, Cmd+Enter to save, Esc to cancel)
6. Click Delete → annotation created immediately, toast notification "Marked for deletion"
7. Selected text receives a colored highlight + numbered marker (Agentation-style markers)
8. Annotation saved to LocalStorage, bubble count updates

### Viewing/Editing Annotations

- Highlighted text is clickable → opens a compact popover showing the annotation
- Popover contains: type icon, content, Edit button, Remove button
- Numbered markers on the doc correspond to items in the bubble panel list
- Multiple annotations on overlapping text: stacked numbered markers

### Copy Output

- Copy button in the bubble panel → copies all annotations as structured markdown
- Toast confirmation "Copied N annotations to clipboard"
- Output format grouped by `@doc/` path (see Copy Output Format section)

## Scenarios

### Scenario 1: Happy Path — Single Doc Annotation

**Given** user is viewing a doc in the WebUI with annotation mode enabled
**When** user selects "WebSocket Protocol" and clicks Replace, types "SSE Protocol"
**Then** the text "WebSocket Protocol" is highlighted in blue, annotation is saved to LocalStorage, and the annotation count badge shows 1

### Scenario 2: Multi-Doc Stack and Copy

**Given** user has 2 annotations on doc A and 1 annotation on doc B
**When** user clicks "Copy All Annotations"
**Then** clipboard contains structured markdown with both docs' annotations grouped under their respective `@doc/` headings

### Scenario 3: Orphaned Annotation

**Given** user annotated text "old paragraph" in a doc
**When** the doc content is updated and "old paragraph" no longer exists
**Then** the annotation is shown with a warning indicator (e.g. ⚠️ "Text not found in current doc"), and the export includes it with an "[orphaned]" note

### Scenario 4: Annotation Mode Off

**Given** annotation mode is toggled off
**When** user selects text in the doc
**Then** no floating toolbar appears, normal browser selection behavior applies

### Scenario 5: Delete All Annotations

**Given** user has 5 annotations across 3 docs
**When** user clicks "Clear All" in the annotation panel
**Then** a confirmation dialog appears; on confirm, all annotations are removed from LocalStorage and all highlights disappear

### Scenario 6: Drag Bubble to Reposition

**Given** the annotation bubble is in its default bottom-right position
**When** user drags the bubble to the top-left area of the doc viewer
**Then** the bubble stays at the new position, and the position persists across page reloads

## Acceptance Criteria

- [ ] AC-1: Floating toolbar appears on text selection in annotation mode with Comment, Replace, Delete actions
- [ ] AC-2: Comment annotation saves free-text attached to selected text
- [ ] AC-3: Replace annotation saves suggested replacement text
- [ ] AC-4: Delete annotation marks text for deletion with optional reason
- [ ] AC-5: Annotations are visually highlighted on rendered doc (color-coded by type)
- [ ] AC-6: Annotations persist in LocalStorage and survive page reload
- [ ] AC-7: Annotations from multiple docs accumulate in shared stack
- [ ] AC-8: "Copy All" produces structured markdown grouped by doc path
- [ ] AC-9: Annotation mode toggle via bubble with visual active/inactive states
- [ ] AC-10: Individual annotations can be edited and removed
- [ ] AC-11: Orphaned annotations (text no longer in doc) are handled gracefully
- [ ] AC-12: Annotation bubble panel shows all annotations with Copy All and Clear All actions
- [ ] AC-13: Bubble is draggable and remembers its position across reloads

## Technical Notes

- Floating toolbar positioning: use `window.getSelection().getRangeAt(0).getBoundingClientRect()` for position
- Text re-anchoring: store `contextBefore` + `selectedText` + `contextAfter` and use fuzzy text search to re-locate after doc changes
- Highlight rendering: use CSS `::highlight` API (modern browsers) or fall back to wrapping matched text nodes in `<mark>` elements via DOM manipulation after React render
- LocalStorage keys: `knowns-annotations-v1` for annotation data, `knowns-annotation-bubble-pos` for bubble position
- Bubble drag: use pointer events (pointerdown/pointermove/pointerup) for smooth cross-device dragging
- Radix Popover for annotation edit/view and bubble panel, Radix Tooltip for toolbar buttons
- No new dependencies needed — existing Radix UI + TailwindCSS + Lucide icons sufficient

## Open Questions

- [ ] Should there be keyboard shortcuts for annotation actions (e.g. Ctrl+Shift+C for comment)?"
