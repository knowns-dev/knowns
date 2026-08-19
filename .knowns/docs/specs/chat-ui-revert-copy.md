---
id: doc-4eca091dafaa9e1b235cc4b70683b57a
title: specs/chat-ui-revert-copy
description: Spec for Chat UI revert and copy message features
createdAt: '2026-03-13T18:44:33.530Z'
updatedAt: '2026-08-19T10:04:29.124Z'
tags:
  - spec
  - superseded
---

# Chat UI - Revert & Copy Message Features

## Overview
Add revert message and copy message functionality to Chat UI, plus clear chat on Enter send.

## Acceptance Criteria

### AC-1: Clear Chat on Enter ✅
- [x] When user presses Enter to send a message, all previous messages in the chat view are cleared
- [x] Only the newly sent message and its response remain visible
- [x] User input field is cleared after send (existing behavior)

### AC-2: Copy Message for User Messages ✅
- [x] Add copy button to user message bubbles
- [x] Copy button appears on hover (like assistant messages)
- [x] Icon: Copy (lucide-react), changes to Checkmark for 2s after copy

### AC-3: Revert Any Message ✅
- [x] Add revert button to assistant message bubbles
- [x] Clicking revert calls OpenCode API: `POST /session/{sessionID}/revert` with `{"messageID":"msg_..."}`
- [x] After revert, refresh session messages to reflect changes

### AC-4: Backend API ✅
- [x] Verify `/session/{id}/revert` endpoint exists in OpenCode server (already exists)

## Implementation Notes

### Phase 1: Backend API (OpenCode Server)
- Revert endpoint already exists: `POST /session/{sessionID}/revert`

### Phase 2: Frontend - API Layer
- Added `revertMessage(sessionId, messageId)` to `opencodeApi` in @code/ui/src/api/client.ts

### Phase 3: Frontend - Clear Chat on Enter
- Modified `handleSend` in @code/ui/src/pages/ChatPage.tsx to clear messages after send

### Phase 4: Frontend - MessageBubble Enhancements
- Added copy button to user message bubble
- Added revert button to assistant message bubble
- Wired up revert API call with onRevert callback

## Files Modified
- @code/ui/src/api/client.ts - Added `revertMessage` API method
- @code/ui/src/pages/ChatPage.tsx - Clear messages on send, added `handleRevert`
- @code/ui/src/components/chat/MessageBubble.tsx - Added copy/revert buttons
- @code/ui/src/components/chat/ChatThread.tsx - Added `onRevert` prop
- @code/ui/src/components/organisms/ChatPage/ChatMessages.tsx - Added `onRevert` prop


> **Superseded** by @decision/20260819-1703-remove-the-opencode-chat-ui - the OpenCode Chat UI was removed from Knowns.
