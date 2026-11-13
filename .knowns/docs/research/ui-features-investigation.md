---
id: doc-52d96e6581db0f54ffd9abbe62e3af02
title: "Research: UI Features Investigation"
description: Research results for UI features
createdAt: "2026-03-16T18:17:54.254Z"
updatedAt: "2026-03-16T18:17:54.254Z"
tags: []
---

# Research: UI Features Investigation

## Project: knowns

## Current State

### 1. Model Variants Selection

- **Status**: Already implemented in ChatInput.tsx (lines 500-558)
- **Implementation**:
  - Model selector popover (lines 396-499)
  - Variant selector popover (lines 500-558)
  - Props: `currentVariant`, `onModelChange`, `onSetDefaultVariant`
  - Shows variant dropdown when model has variants: `hasVariants = modelVariants.length > 0`
- **Missing**: No example tests for variant selection

### 2. Mentions (@task-xxx, @doc/xxx) in Prompt Input

- **Status**: Implemented in ChatInput.tsx (normalizeKnownsTaskReferences)
- **Reference file**: ui/src/lib/knownsReferences.ts
- **Regex**: `KNOWNS_TASK_REFERENCE_REGEX` for @task-xxx pattern
- **Current behavior**:
  - Parses @task-xxx and @doc/xxx references in text input
  - Sends normalized references to backend
- **Missing**:
  - UI autocomplete/popup for mentions while typing (like Notion)
  - Button to insert references easily (notion-like)

### 3. Notion-like Prompt Input

- **Current implementation**:
  - ChatInput.tsx (581 lines)
  - Has file attachment, model selector, variant selector
  - Skill commands (/skill-name)
- **Missing compared to Notion**:
  - No @ mention autocomplete popup in input
  - No slash commands menu (already has / for skills but not shown as menu)
  - No formatting toolbar
  - Notion-style block-based input not present

## Existing Test Files

- ui/e2e/mentions.spec.ts - Tests task→task, task→doc, doc→task, doc→doc mentions (display only, not input)
- ui/e2e/chat.spec.ts - Basic chat functionality
- ui/e2e/chat-huggingface.spec.ts - Chat with specific providers

## Feature Gaps

1. **Variant selection**: Need E2E test example for selecting variants
2. **Input mentions**: Need to add @mention autocomplete in ChatInput
3. **Notion-like UI**: Need to enhance prompt input with better UX
