---
id: 20260910-1842-session-opener-ranks-memory-by-category-not-tags
title: Session opener ranks memory by category, not tags
status: accepted
supersedes: []
supersededBy: []
tags:
  - memory
  - runtime
  - retrieval
sources:
  - '@task-MEM-TN1P8A'
  - 'git:d1edcd6 fix(memory): load user commitments at session start'
relatedDocs: []
relatedTasks:
  - MEM-TN1P8A
verification:
  - 'source:@task-MEM-TN1P8A'
  - 'source:git:d1edcd6 fix(memory): load user commitments at session start'
  - 'task:@task-MEM-TN1P8A:done'
verifiedAt: '2026-09-25T05:40:21.703Z'
createdAt: '2026-09-10T11:42:44.794Z'
updatedAt: '2026-09-25T05:40:21.703Z'
---

## Context

Lần inject đầu phiên chưa có câu hỏi nào để so độ liên quan, nên thứ duy nhất đáng trả ngân sách là thứ đúng bất kể người dùng sắp hỏi gì.

`baselineScore` trước đây cộng điểm theo TAG trúng một danh sách cứng. Tag là trường tự do, không ai bảo đảm nội dung. Đo trên kho thật: bốn memory `preference` của người dùng xếp hạng 1, 10, 11, 12 trên 12 ứng viên, tức ba trong bốn nằm dưới mọi memory `failure` của project. Cái duy nhất lên hạng 1 chỉ vì tác giả tình cờ gắn tag `style` và `preference`.

## Decision

Lần inject đầu phiên xếp hạng theo `category`, không theo tag.

`preference` đứng trên `convention`, và cả hai đứng trên mọi category phụ thuộc ngữ cảnh (`pattern`, `failure`). Layer, độ mới và tag chỉ sắp xếp TRONG một bậc, không bao giờ vượt bậc. Trọng số ở `baselineScore` phải giữ khoảng cách đủ rộng để các bậc không chồng lấn.

`category` là trường có thẩm quyền vì đường ghi kiểm nó qua `models.AllowedMemoryCategories`.

Phần thưởng theo tag chỉ được cộng MỘT LẦN. Cộng theo từng tag là cách một entry gắn hai tag vượt mặt một entry quan trọng ngang nhau nhưng gắn một tag.

Quy tắc thứ hai, cùng gốc: một bản cài runtime hoàn chỉnh gồm CẢ hook prompt lẫn hook session. Thiếu hook session thì `runtime status` phải báo `drifted`, không được báo `installed`.

## Alternatives Considered


## Consequences

Sau khi xếp theo category, bốn cam kết chiếm trọn bốn chỗ đầu của lần inject đầu phiên.

Đánh đổi đã chấp nhận: đầu phiên giờ có HAI lần inject, `SessionStart` rồi `UserPromptSubmit` của prompt đầu tiên. Đó là token thật, trả thêm một lần mỗi phiên.

`installClaude` và `installCodex` trước đây đều XOÁ nhóm `SessionStart` trong khi `runtime status` vẫn báo `installed`, nên tầng baseline chưa từng chạy mà không ai biết. Trạng thái nửa vời giờ báo `drifted` kèm lý do đích danh.
