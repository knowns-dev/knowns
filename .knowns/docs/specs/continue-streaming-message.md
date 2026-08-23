---
id: doc-c9ad42c33cc820351832fabe04f2e57a
title: Continue Streaming Message
description: Specification for continue streaming message feature
createdAt: '2026-03-13T13:57:40.053Z'
updatedAt: '2026-08-19T10:04:29.380Z'
tags:
  - spec
  - superseded
---

# Continue Streaming Message

## Overview

Cho phép người dùng gửi tin nhắn mới trong khi session đang streaming, thay vì bị disabled như hiện tại.

## Requirements

### Functional Requirements
- FR-1: UI input không bị disabled khi đang streaming
- FR-2: Tin nhắn gửi trong khi streaming được queue ở backend
- FR-3: Khi streaming hiện tại hoàn thành, hệ thống tự động xử lý tin nhắn queued
- FR-4: Hiển thị indicator cho user biết có tin nhắn đang chờ

### Non-Functional Requirements
- NFR-1: Queue xử lý theo thứ tự FIFO (First In First Out)
- NFR-2: Maximum queue size: 10 messages (reject với error nếu exceed)

## Acceptance Criteria

- [x] AC-1: User có thể type và gửi tin nhắn khi session status = "streaming"
- [x] AC-2: Backend accept message và trả về 202 với queued status
- [x] AC-3: UI hiển thị "1 message queued" indicator
- [x] AC-4: Sau khi streaming complete, queued message được xử lý tự động
- [x] AC-5: Nhiều messages có thể được queue liên tiếp (up to 10)
## Scenarios

### Scenario 1: Gửi message khi streaming
**Given** Session đang streaming (status = "streaming")  
**When** User gõ và gửi tin nhắn mới  
**Then** 
- Tin nhắn được queue ở backend
- UI hiển thị "1 message queued" badge
- Input không bị clear, user có thể tiếp tục type

### Scenario 2: Streaming complete, xử lý queued
**Given** Có message trong queue, streaming hiện tại complete  
**When** Session chuyển từ "streaming" → "idle"  
**Then** 
- Queued message được gửi cho OpenCode
- Session chuyển sang "streaming" 
- Queue badge update hoặc clear

### Scenario 3: Queue exceeded
**Given** Queue đã có 10 messages  
**When** User gửi thêm message thứ 11  
**Then** Backend trả về lỗi 429 (Too Many Requests)

### Scenario 4: User stop streaming
**Given** Có message trong queue, user click Stop  
**When** Session chuyển về "idle"  
**Then** Queued messages vẫn được giữ nguyên và xử lý khi user gửi message mới hoặc reload

## Technical Notes

### Backend Changes
- Thêm field `messageQueue []string` vào ChatSession model
- Sửa `/api/chats/{id}/send` endpoint:
  - Nếu status = "streaming": append vào queue thay vì reject
  - Nếu queue full: return 429
- Thêm `/api/chats/{id}/queue` endpoint để query queue status (optional)
- Khi streaming complete (process exit), check queue và trigger next message

### Frontend Changes
- Bỏ `activeSession.status === "streaming"` từ disabled logic của ChatInput
- Thêm state `messageQueueCount` để hiển thị badge
- Gọi API với flag `queue: true` khi đang streaming

### API Changes
```
POST /api/chats/{id}/send
Request: { "content": "...", "queue": true }  // queue param optional
Response 202: { "queued": true, "position": 1 }
Response 429: { "error": "Queue full, max 10 messages" }
```

## Open Questions

- [ ] Question 1: Nếu user reload page, queue có persist không?
- [ ] Question 2: Có cần clear queue button không?


> **Superseded** by @decision/20260819-1703-remove-the-opencode-chat-ui - the OpenCode Chat UI was removed from Knowns.
