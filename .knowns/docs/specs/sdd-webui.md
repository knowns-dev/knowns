---
title: SDD WebUI
createdAt: '2026-02-03T18:33:49.434Z'
updatedAt: '2026-02-03T18:34:43.440Z'
description: >-
  Specification for SDD WebUI - extend existing UI to support spec-driven
  development
tags:
  - spec
  - webui
status: implemented
---
## Overview

Extend existing WebUI to support Spec-Driven Development (SDD). Reuse Task and Doc components with SDD-specific enhancements.

**Principle:** Minimal new components, maximum reuse of existing UI.

## Requirements

### Functional Requirements

#### FR-1: Spec Document Identification
- Docs in `specs/` folder OR with tag `spec` are treated as spec documents
- Frontmatter can include `type: spec` and `status: draft|approved|implemented`
- UI must visually distinguish specs from regular docs

#### FR-2: Spec Document View (Enhanced Doc View)
- Show "SPEC" badge prominently
- Display status badge (Draft/Approved/Implemented)
- Show AC progress bar (X/Y completed)
- Show linked tasks count
- Action buttons: "Approve", "Create Tasks" (calls `/kn-plan --from`)

#### FR-3: Spec List View
- Filter docs to show only specs (folder: specs/ OR tag: spec)
- Sort by status (draft first, then approved, then implemented)
- Show coverage stats per spec

#### FR-4: Task-Spec Integration
- Task card shows spec link if `spec` field exists
- Task detail shows spec reference with link
- Filter tasks by spec: "Show tasks for spec X"

#### FR-5: SDD Dashboard Widget
- Display on Board or dedicated SDD tab
- Show stats from `validate --sdd`:
  - Specs: total | approved | draft
  - Tasks: total | done | in-progress | todo
  - Coverage: X/Y tasks linked (Z%)
- List warnings (expandable)
- List passed checks

### Non-Functional Requirements

- NFR-1: Reuse existing Doc and Task components
- NFR-2: No new pages, extend existing views
- NFR-3: Real-time updates via existing WebSocket

## Acceptance Criteria

- [x] AC-1: Spec docs show "SPEC" badge in doc view
- [x] AC-2: Spec docs show status (draft/approved/implemented)
- [x] AC-3: Spec docs show AC progress bar
- [x] AC-4: Spec docs show linked tasks count
- [x] AC-5: Doc list can filter to show only specs
- [x] AC-6: Task cards show spec link when present
- [x] AC-7: Tasks can be filtered by spec
- [x] AC-8: SDD Dashboard shows coverage stats
- [x] AC-9: SDD Dashboard shows warnings and passed checks

## Scenarios

### Scenario 1: View Spec Document
**Given** user opens a doc in `specs/` folder
**When** doc view loads
**Then** show SPEC badge, status, AC progress, linked tasks, and action buttons

### Scenario 2: Filter Specs in Doc List
**Given** user is on docs page
**When** user selects "Specs" filter
**Then** show only docs from specs/ folder or with spec tag

### Scenario 3: View Task with Spec
**Given** task has `spec: specs/feature-name` field
**When** user views task card or detail
**Then** show clickable link to spec document

### Scenario 4: SDD Dashboard
**Given** user opens Board or SDD tab
**When** dashboard loads
**Then** show coverage stats, warnings, and passed checks

## Technical Notes

### Spec Detection Logic
```typescript
function isSpec(doc: Doc): boolean {
  return doc.path.startsWith('specs/') || 
         doc.tags?.includes('spec') ||
         doc.frontmatter?.type === 'spec';
}
```

### Spec Status from Frontmatter
```yaml
---
title: Feature Name
type: spec
status: draft  # draft | approved | implemented
tags: [spec]
---
```

### AC Progress Calculation
Parse markdown for `- [ ]` and `- [x]` patterns in "Acceptance Criteria" section.

### API Endpoints (existing, may need extension)
- `GET /api/docs?folder=specs` - filter by folder
- `GET /api/tasks?spec=specs/name` - filter by spec
- `GET /api/validate?scope=sdd` - get SDD stats

## Open Questions

- [ ] Should we add a dedicated "Specs" tab or just filter in Docs?
- [ ] Should "Approve" action update frontmatter or tags?
- [ ] Should we show spec status on task cards?
