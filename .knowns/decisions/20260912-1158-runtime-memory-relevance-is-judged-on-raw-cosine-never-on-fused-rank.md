---
id: 20260912-1158-runtime-memory-relevance-is-judged-on-raw-cosine-never-on-fused-rank
title: Runtime memory relevance is judged on raw cosine, never on fused rank
status: draft
supersedes: []
supersededBy: []
tags:
  - memory
  - retrieval
  - runtime
sources:
  - '@task-MEM-HXPZC0'
  - '@doc/specs/2026-09-09/persistent-memory-usability'
  - 'git:4f076b9 fix(memory): judge relevance by cosine, not rank'
relatedDocs:
  - specs/2026-09-09/persistent-memory-usability
relatedTasks:
  - MEM-HXPZC0
verification: []
reviewState: needs_evidence
reviewBlockers:
  - 'linked task "MEM-HXPZC0" is "in-review"; all linked tasks must be done before accepting decision "20260912-1158-runtime-memory-relevance-is-judged-on-raw-cosine-never-on-fused-rank"'
reviewMatches: []
reviewAllowedResolutions: []
reviewEvaluatedHash: '6c7ce0ff4c02d2defe0d46ca0dafdac0d440c2381a29f8ce1ef58b0fa8c204d0'
reviewEvaluatedAt: '2026-09-13T15:59:47.217Z'
createdAt: '2026-09-12T04:58:35.871Z'
updatedAt: '2026-09-13T15:59:47.217Z'
---

## Context

Hook runtime memory từng chấm độ liên quan bằng ba tín hiệu, cả ba đều sai theo cách đo được (2026-09-12):

- Điểm fused của engine (`SearchResult.Score`) là RRF chia max, rồi chia max lần nữa ở `rerank`. Kết quả đầu LUÔN là 1.00, kể cả "ok cảm ơn" → ipkq69=1.00. Dùng nó làm boost cho mọi prompt vài hit gần tối đa, bất kể có liên quan hay không.
- `0.35 × số từ trùng` không có trần. Cùng một memory: 0.77 cho "em dash", 2.52 cho câu diễn đạt lại dài hơn.
- `tokenRE = [a-z0-9]+` chặt nát từ tiếng Việt có dấu, trong khi từ chức năng ASCII (`khi`, `cho`) sống sót và đi so khớp.

Cosine thô thì tách sạch: prompt liên quan có hit đầu 0.62 đến 0.67, prompt không liên quan ≤ 0.50.

## Decision

Độ liên quan để inject một memory qua đường hybrid là `SemanticScore`: cosine thô của CHUNK TỐT NHẤT, tuyệt đối, không phụ thuộc độ dài prompt. Ngưỡng là một sàn tuyệt đối trên giá trị đó (`semanticRelevanceFloor`).

`SearchResult.Score` là THỨ HẠNG. Không bao giờ được dùng nó làm ngưỡng độ liên quan ở bất kỳ đâu.

So khớp từ khoá dùng TỈ LỆ từ nội dung của prompt tìm thấy trong memory, sau khi gấp dấu và bỏ stopword. Trong đường hybrid nó chỉ phá thế hoà; nó chỉ là tín hiệu chính khi tầng ngữ nghĩa không có.

Khi tầng ngữ nghĩa đã chạy, câu trả lời "không có gì liên quan" của nó là cuối cùng. Chỉ rơi về so khớp từ khoá khi tầng ngữ nghĩa không có hoặc lỗi.

## Alternatives Considered


## Consequences

Sàn 0.55 được hiệu chỉnh trên `qwen3-embedding:0.6b`. Đổi mô hình embedding thì phải hiệu chỉnh lại, vì phân bố cosine đổi theo mô hình.

`knowns search --json` có thêm field `semanticScore`. Chỉ cộng thêm.

Đo trên kho thật sau khi áp dụng: "ok cảm ơn" và "database connection pool" không inject gì (trước đây mỗi prompt có một memory được đẩy lên 1.00); ipkq69 không còn chen vào prompt về hash drift; cùng một yêu cầu diễn đạt ngắn hay dài đều chọn cùng một memory, cùng thứ tự.
