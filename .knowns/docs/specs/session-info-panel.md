---
id: doc-0d6d851d1bad352e1ffd56fe3cb6d2c0
title: Context Usage Indicator
description: 'Arc indicator showing % context usage in Chat toolbar, hover popover with heatmap grid and token breakdown'
createdAt: '2026-03-12T18:53:43.440Z'
updatedAt: '2026-08-19T10:04:29.215Z'
tags:
  - spec
  - superseded
---

## Overview

Context Usage Indicator is a mini arc/donut icon in the Chat toolbar (next to the model selector) showing % of context window used. Hovering opens a popover with a Claude Code `/context`-style breakdown — a heatmap grid visualizing context allocation plus a legend listing each category's token count and percentage, including free space remaining.

Popover layout on hover:

```
Context Usage
claude-opus-4 • 43k/200k tokens (22%)

┌──────────────────────────┐
│ 🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦 │  <- heatmap grid
│ 🟦🟦🟦🟦🟦🟦🟦🟦🟦🟡 │     each cell ≈ 1% context
│ 🟠🟠⬜⬜⬜⬜⬜⬜⬜⬜ │     colored by category
│ ⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜ │     empty = free space
│ ...                      │
└──────────────────────────┘

🟠 Tool use & results: 29.2k tokens (14.6%)
🔵 Messages:           1.6k tokens (0.8%)
🟣 Reasoning:          0 tokens (0%)
🟢 Cache:              18.9k tokens (9.5%)
⬜ Free space:         156.8k (78.4%)

Cost: $0.12
```

Goal: let users see what's consuming their context window and how much room is left, so they can decide when to compact or start a new session.

## Requirements

### Functional Requirements

- FR-1: Display a small arc indicator (20-24px) in the ChatInput toolbar, next to the model selector
- FR-2: Arc shows % context usage based on total tokens / model context limit
- FR-3: Arc color changes by usage level: green (<50%), yellow (50-80%), red (>80%)
- FR-4: Hover opens a popover with context breakdown layout
- FR-5: Popover header: model name + total tokens / limit + % usage
- FR-6: Popover body part 1 — Heatmap grid: small square cells in a grid (e.g. 10×10), each cell represents ~1% of context window. Cells are colored by category (tool calls, messages, reasoning, cache); empty cells = free space. Visual style inspired by Claude Code `/context`
- FR-7: Popover body part 2 — Legend/breakdown list: categories with colored dot, name, token count, and %
- FR-8: Breakdown categories: Tool use & results, Messages (user + assistant text), Reasoning, Cache, Free space
- FR-9: Each category has a distinct color, consistent between heatmap cells and legend dots
- FR-10: Free space = context limit - total used, shown last in legend
- FR-11: Data sourced from `activeSession.messages` — aggregated from `info.tokens` and tool/text/reasoning parts
- FR-12: Indicator auto-updates when session receives new messages (streaming)
- FR-13: Show total cost if > 0

### Non-Functional Requirements

- NFR-1: No new API calls — aggregate only from messages already in ChatSession state
- NFR-2: Arc rendered with inline SVG, no new dependencies
- NFR-3: Popover uses existing Radix Popover component
- NFR-4: Responsive — hide label text on mobile, show only arc icon
- NFR-5: Performance — memoize aggregation logic, recalculate only when messages change

## Data Source

Token data is aggregated from `activeSession.messages`:

```
Each assistant message has:
  info.tokens.input    — input tokens
  info.tokens.output   — output tokens
  info.tokens.reasoning — reasoning tokens
  info.tokens.cache.read / cache.write — cache tokens
  info.cost            — cost in USD

Each step-finish part has:
  tokens (same structure as above)
  cost
```

Context limit: OpenCode provider API does not currently return model context window size. Approaches:
1. Hardcode known limits for common models (Claude 200k, GPT-4 128k, etc.)
2. Add field to OpenCodeProviderResponse (upstream change)
3. Show absolute token count instead of %, hide arc when limit unknown

## Acceptance Criteria

- [ ] AC-1: Arc indicator visible in ChatInput toolbar when active session has messages
- [ ] AC-2: Arc fill % corresponds to token usage / context limit
- [ ] AC-3: Arc color changes by threshold: green < 50%, yellow 50-80%, red > 80%
- [ ] AC-4: Hover opens popover with context breakdown layout
- [ ] AC-5: Popover header shows: model name, total tokens / limit, % usage
- [ ] AC-6: Popover displays heatmap grid (10×10 cells), each cell ≈ 1% context, colored by category, empty = free
- [ ] AC-7: Heatmap fills in order: Tool use → Messages → Reasoning → Cache → Free
- [ ] AC-8: Popover displays legend: categories with colored dot + name + token count + %
- [ ] AC-9: Colors consistent between heatmap cells and legend dots
- [ ] AC-10: Free space shown last in legend
- [ ] AC-11: Data aggregated from existing messages state, no new API calls
- [ ] AC-12: Indicator updates in real-time as messages change
- [ ] AC-13: Indicator hidden when no active session or no messages
- [ ] AC-14: When context limit unknown, show absolute token count, hide heatmap grid

## Scenarios

### Scenario 1: Normal Usage
**Given** User is chatting with a session using 22k/200k tokens
**When** User looks at the toolbar
**Then** Green arc indicator shows ~11%

### Scenario 2: High Usage Warning
**Given** Session has used 170k/200k tokens (85%)
**When** User looks at the toolbar
**Then** Red arc indicator, hover popover shows mostly filled heatmap grid

### Scenario 3: View Breakdown
**Given** Session with tool calls consuming most of the context
**When** User hovers over the arc indicator
**Then** Popover shows heatmap grid with colored cells + legend:
```
Context Usage
claude-opus-4 • 43k/200k tokens (22%)

[heatmap: 22 colored cells, 78 empty]

🟠 Tool use & results: 29.2k tokens (14.6%)
🔵 Messages:           1.6k tokens (0.8%)
🟣 Reasoning:          0 tokens (0%)
🟢 Cache:              18.9k tokens (9.5%)
⬜ Free space:         156.8k (78.4%)
```

### Scenario 4: New Session
**Given** Newly created session with no messages
**When** User looks at the toolbar
**Then** Arc indicator hidden or shows empty state

### Scenario 5: Streaming Update
**Given** Session is streaming a response
**When** Assistant message completes with token info
**Then** Arc indicator auto-updates to new %

### Scenario 6: Unknown Context Limit
**Given** Model has no known context limit in hardcode map
**When** User looks at the toolbar
**Then** Shows absolute token count (e.g., "22.8k tokens") instead of arc %, popover hides heatmap grid but still shows breakdown list

## Technical Notes

### Component Structure
- @code/ui/src/components/organisms/ChatPage/ContextUsageIndicator.tsx — main component
- Placed in ChatInput toolbar, between model selector and send button area

### Heatmap Grid
- 10×10 grid of small square divs (or SVG rects), ~6-8px each
- Fill cells left-to-right, top-to-bottom by category order
- Each cell gets a CSS class/color based on which category it belongs to
- Empty cells use a subtle border/muted background for "free space"

### Data Aggregation
- Scan `activeSession.messages` to compute total tokens
- Classify by part type: tool parts → "Tool use & results", text parts → "Messages", reasoning parts → "Reasoning"
- Use `useMemo` to cache aggregation

### Context Limit Lookup
- Hardcode map: `{ "claude-3-5-sonnet": 200000, "claude-3-opus": 200000, "gpt-4o": 128000, ... }`
- Match by `modelID` from session
- Fallback: show absolute token count

### Reusable Components
- Create mini @code/ui/src/components/organisms/ChatPage/ArcIndicator.tsx SVG (single arc segment, simpler than DonutChart)
- Use `Popover` from @code/ui/src/components/ui/popover.tsx

## Open Questions

- [ ] Context limit: hardcode or find a way to get from OpenCode API? (recommend hardcode first, upstream PR later)
- [ ] Token estimation for categories: OpenCode message API only returns total input/output tokens per message, not broken down by "system prompt" vs "tool definitions" vs "messages". Need to decide: estimate via char count (~4 chars/token) on raw content, or only use the aggregate tokens available?


> **Superseded** by @decision/20260819-1703-remove-the-opencode-chat-ui - the OpenCode Chat UI was removed from Knowns.
