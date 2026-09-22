---
id: doc-b8ef6350c3474347b9778c6b79a100f1
title: Persistent Memory Usability
description: 'Làm cho Persistent Memory thực sự dùng được: bỏ auto-capture theo keyword, mở đường ghi MCP, ghi được provenance, thêm confirm/contradict, anchor check cho memory loại 1'
createdAt: '2026-09-09T07:09:15.590Z'
updatedAt: '2026-09-09T09:26:19.326Z'
tags:
  - spec
  - approved
  - memory
  - provenance
---

## Overview

Persistent Memory của Knowns hiện có 107 entry trong kho tham chiếu nhưng chỉ 8 entry `active`. **83 trên 107 là rác do máy sinh.** Toàn bộ phần còn lại không bao giờ được retrieve.

Có hai nguyên nhân, và chúng khác nhau về bản chất.

### Nguyên nhân 1: auto-capture theo keyword, bật mặc định ở mọi bản cài

`inferWorkingContextCandidate` và `inferGlobalPreferenceCandidate` (`internal/runtimememory/runtimememory.go`) suy ra memory từ cụm từ trong prompt. Đây là defect, không phải cấu hình sai của một người dùng:

- `NormalizeMode("")` trả `ModeAuto`
- `NormalizeCaptureMode("")` trả `CaptureHighConfidence`
- `minHighConfidenceCapture = 0.80`, trong khi hai ứng viên viết cứng `Confidence: 0.84` và `0.92`

Cả hai mode bật khi không cấu hình, và bộ lọc "high confidence" không lọc gì vì hai nguồn duy nhất đi qua nó đều tự đặt điểm vượt ngưỡng.

`inferGlobalPreferenceCandidate` còn ghi đè `content` bằng câu viết cứng, tức tạo ra một phát biểu người dùng chưa từng nói và gán tên họ. Với memory loại 2 (cam kết), lời người dùng chính là sự thật, nên ngụy tạo lời nói phá huỷ đúng thứ duy nhất khiến nó verify được.

### Nguyên nhân 2: đường ghi MCP không bao giờ tới `active`

`handleMemoryAdd` (`internal/mcp/handlers/memory.go:161`) gọi `memoryreview.Add(entry, AddOptions{})` không truyền `Status`, nên rơi về `MemoryStatusProposed`. Handler cũng không nhận `status`, `sources`, hay `confidence`. CLI `memory create` thì nhận `--status` (`internal/cli/memory.go:376`).

**Đây không phải bug.** MCP `initial` nói rõ đó là chính sách có chủ đích:

> Agent/MCP Memory writes default to proposed unless explicitly resolved; default retrieval only uses active Memories.

Spec này **cố ý ghi đè chính sách đó**, xem D8. Lý do là bằng chứng thực nghiệm, không phải sở thích.

### Bằng chứng cho D8

Kiểm kê toàn kho theo nguồn ghi:

| Đường ghi | Số entry | Số đạt `active` | Chất lượng |
|---|---|---|---|
| Regex heuristic | 86 | **0** | rác toàn bộ |
| LLM tự quyết (`kn-extract`, MCP `add`) | 20 | 8 (phần còn lại kẹt `proposed`) | **20/20 tốt** |

20 memory do agent chủ động viết đều có `**Why:**`, `**How to apply:**`, `sources`, anchor symbol. Không một cái nào là rác.

Nói cách khác: **cổng duyệt đang canh một mối nguy chưa từng xuất hiện, trong khi mối nguy thật đi vòng qua nó.** Phán đoán "cái này có đáng lưu không" là việc LLM làm tốt, vì nó vừa làm xong công việc sinh ra memory đó. Việc LLM không tự làm được là "cái này có mâu thuẫn hoặc trùng cái cũ không", vì đó đòi nhìn toàn kho.

Nên cổng duyệt được giữ, nhưng thu hẹp đúng vào việc nó thực sự cần thiết.

### Hai loại memory

Thiết kế dựa trên phân biệt sau, vì nó quyết định cách verify:

| | Loại 1: mệnh đề về thế giới | Loại 2: cam kết |
|---|---|---|
| Category | `pattern`, `convention`, `failure` | `preference` |
| Thẩm quyền | code, tool, thực tại | người phát ngôn |
| Nguồn thật | symbol, `@doc/<path>`, `@task-<id>`, commit | ai nói, khi nào, nguyên văn, và lý do |
| Hỏng vì | thế giới trôi | tác giả rút lại |
| Verify bằng | tra anchor | hỏi lại người phát ngôn |
| TTL có nghĩa | có | không |

## Locked Decisions

- **D1**: Gỡ toàn bộ tầng auto-capture theo keyword. Bỏ cả `inferWorkingContextCandidate` lẫn `inferGlobalPreferenceCandidate`, kèm `workingContextPhrases`, `globalPreferencePhrases`, và các call site. Memory chỉ sinh ra từ lời gọi `add` có chủ đích.
- **D2**: **Triage trước, xoá sau.** Không xoá cả lô. 83 entry chép prompt bị xoá, 3 entry có nội dung thật được cứu. Toàn bộ 86 file được export ra ngoài `.knowns/` trước khi xoá bất cứ thứ gì, vì `.knowns/.gitignore` ignore thư mục memory nên không có đường khôi phục qua git.
- **D3**: `contradict` phân theo loại. Loại 1 có anchor tra được thì hạ `stale` ngay kèm note. Loại 2 thì agent không có thẩm quyền, chỉ được đánh dấu `disputed` và nêu cho người dùng quyết.
- **D4**: Thiếu `**Why:**` trên memory category `preference` là lỗi chặn khi ghi mới. Entry cũ vẫn đọc và inject được, nhưng bị `knowns validate` liệt kê là thiếu provenance.
- **D5**: Category phải nằm trong hợp đồng của `kn-extract` (`pattern`, `convention`, `preference`, `failure`). Ba entry đang sai được chuẩn hoá: `r7upz8` (`implementation`) và `16m7rp` (`failure-pattern`) đổi về category hợp lệ, `15q1yo` (`decision`, legacy read-only) chuyển thành System Decision. Ghi mới với category ngoài danh sách bị từ chối.
- **D6**: Global layer chỉ chứa thứ đúng với mọi dự án. Năm entry của dự án khác (`kfh4cx`, `xrbwkh` thuộc autosub, `16m7rp` Cloudinary, `vesntm` Stitch, `rnliz9` Coordination ReBAC) được đưa về project layer tương ứng hoặc xoá nếu dự án đó không còn dùng Knowns.
- **D7**: ID giữ nguyên dạng ngẫu nhiên 6 ký tự base36 của `util.GenerateID()`, vì memory ID đang được tham chiếu (`@memory/3kno2x` xuất hiện trong chính nội dung memory đó). ID sinh từ nội dung sẽ đổi khi nội dung được sửa và làm chết mọi ref. Thay vào đó bổ sung field `key` riêng, tuỳ chọn, unique trong một layer, mặc định là slug của `title`. Ghi với `key` đã tồn tại là update tại chỗ và báo `replaced`.
- **D8**: **Memory ghi qua MCP mặc định là `active`, không phải `proposed`.** Đây là ghi đè có chủ đích lên chính sách hiện hành mà MCP `initial` đang công bố ("Agent/MCP Memory writes default to proposed unless explicitly resolved"). Căn cứ: 86 entry do regex sinh đạt 0 `active`, còn 20 entry do LLM tự quyết thì cả 20 đều đạt chuẩn. Cổng duyệt đang canh mối nguy chưa từng xuất hiện.

  Cổng duyệt **không bị bỏ**, chỉ thu hẹp: `memoryreview.Add` vẫn chạy, và nhánh có match trùng lặp vẫn trả `review_required` như hiện tại. Chỉ những entry **không trùng lặp** mới đi thẳng `active`. Phân công trách nhiệm:

  | Câu hỏi | Ai quyết | Có cổng không |
  |---|---|---|
  | Có đáng lưu không | LLM | không, ghi thẳng `active` |
  | Có mâu thuẫn hoặc trùng cái cũ không | hệ thống | có, giữ nguyên `review_required` |

  Vì nhánh có match vẫn sinh ra hàng đợi `proposed`, hàng đợi đó phải có TTL để không tích lại thành 83 lần nữa. Xem FR-10.

## System Decision Impact

- Impact: existing
- Decision: `@decision/20260827-1529-anchor-durable-citations-to-symbols-not-line-numbers`
- Acceptance gate: Decision đang ở `draft` / `needs_evidence`, blocker là `@task-npgfm4` chưa done. Spec này không làm Decision đó được accept, nhưng phải tuân thủ nó: FR-5 chỉ neo vào symbol, không neo vào `path:line`.

## Requirements

### Functional Requirements

- **FR-1**: Gỡ `inferWorkingContextCandidate`, `inferGlobalPreferenceCandidate`, `workingContextPhrases`, `globalPreferencePhrases` và mọi call site trong `internal/runtimememory/`. Sau khi gỡ, `inferCaptureCandidate` không còn nhánh nào trả về ứng viên, nên phần capture path trở thành code chết và phải được dọn cùng, gồm cả `minHighConfidenceCapture` và các capture mode nếu chúng không còn ý nghĩa. Đây là defect đã ship và nên ship sớm, độc lập với phần còn lại của spec nếu cần.

  **Không được xoá nhầm đường inject.** `canonicalityWarning` (`runtimememory.go:60`) và block guidance của `UserPromptSubmit` hook (`runtimememory.go:941`) nằm cùng package nhưng thuộc đường đọc, không thuộc đường ghi. Chúng phải sống, và FR-13 còn sửa chúng.
- **FR-2**: `handleMemoryAdd` nhận thêm `status`, `sources`, `confidence`, `ttlDays`, `key`. Khi `status` không được truyền và `memoryreview.Add` không tìm thấy match trùng lặp, memory tạo ra ở `active` theo D8. Nhánh có match giữ nguyên hành vi `review_required` hiện tại.
- **FR-3**: `handleMemoryUpdate` nhận và ghi được `sources`, `lastVerified`, `confidence`. Hiện tại ba field này chỉ đặt được qua `resolve`, nên không có đường thông thường để ghi nhận một lần tái xác minh.
- **FR-4**: Bổ sung hai action `confirm` và `contradict`.
  - `confirm(id)` cập nhật `lastVerified` về thời điểm hiện tại và giữ nguyên status.
  - `contradict(id, note)` xử theo D3: loại 1 chuyển `stale` và ghi note; loại 2 giữ `active` nhưng gắn `disputed` kèm note, và kết quả trả về phải nói rõ rằng cần người dùng quyết.
- **FR-5**: Lúc retrieval, với memory loại 1, kiểm tra các anchor mà entry trích dẫn trong `sources`. Anchor là symbol, đường dẫn file, `@doc/<path>`, hoặc `@task-<id>`. Anchor không còn tồn tại thì entry được đánh dấu `suspect` trong phần inject, không tự hạ status. Memory loại 2 không bị kiểm tra.
- **FR-6**: Ghi mới một memory category `preference` mà content không chứa `**Why:**` thì bị từ chối kèm thông báo nêu rõ vì sao. Áp cho cả `add` và `update` khi chúng tạo nội dung mới; không áp hồi tố lên entry đã tồn tại.
- **FR-7**: Category ngoài hợp đồng `kn-extract` (`pattern`, `convention`, `preference`, `failure`) bị từ chối khi ghi mới. Category `decision` giữ nguyên hành vi legacy read-only hiện có.
- **FR-8**: Bổ sung field `key` theo D7. Tuỳ chọn, unique trong một layer, mặc định là slug của `title`. `add` với `key` đã tồn tại là update tại chỗ và báo `replaced: true`. `id` giữ nguyên dạng ngẫu nhiên và không bao giờ derive từ nội dung, vì `@memory/<id>` là ref đang được dùng.
- **FR-9**: Migration một lần theo D2, D5, D6:
  - export toàn bộ 86 entry heuristic ra ngoài `.knowns/` trước khi xoá bất cứ thứ gì
  - xoá 83 entry chép prompt
  - cứu 3 entry có nội dung thật: `zzt7pq` và `8a36wi` (cùng một bug hash, gộp thành một memory `failure` có anchor), `9ha6fk` (tài liệu chiến lược, chuyển thành doc chứ không giữ dạng memory)
  - chuẩn hoá category cho `r7upz8`, `16m7rp`, `15q1yo`
  - đưa `kfh4cx`, `xrbwkh`, `16m7rp`, `vesntm`, `rnliz9` về đúng layer
  - chuyển 6 memory project hợp lệ sang `active`
- **FR-10**: Hàng đợi `proposed` phải có hạn. Một entry `proposed` quá `n` ngày mà không được resolve sẽ tự chuyển terminal (`rejected`). `cleanupMemoryCandidates` hiện lọc thuần theo `UpdatedAt` và **không đọc `status`** (`internal/cli/memory.go:215`), nên một memory `active` đang chạy tốt vẫn bị liệt kê là ứng viên dọn dẹp. Sửa nó để phân biệt `proposed` bị bỏ quên với entry chỉ đơn thuần là cũ. Mục tiêu là hàng đợi tự giới hạn, không bao giờ tích lại thành 83 entry.
- **FR-11**: Viết lại block `Knowledge Lifecycle` của MCP `initial` (`internal/mcp/handlers/initial.go:345`). Cả 6 bullet hiện tại đều mô tả cơ chế vòng đời và **không dòng nào nói memory là gì hay khi nào nên ghi**. Block mới phải dạy được bốn điều:
  1. Memory là sự việc bền vững mà **phiên sau** cần, không phải trạng thái phiên này, không phải prompt của người dùng.
  2. Nó sinh ra từ **kết quả**, không từ một cụm từ trong yêu cầu. Phép thử phủ định: nếu nó không chứa thông tin nào ngoài input đã tạo ra nó thì nó không phải memory.
  3. `pattern`/`convention`/`failure` là mệnh đề về code, phải trích symbol, `@doc/<path>` hoặc `@task-<id>`. `preference` là cam kết của người dùng, phải trích ai nói, khi nào, và **lý do**. Đây là thứ FR-5 và FR-6 cưỡng chế, nên bootstrap phải dạy trước.
  4. Vòng đời sau D8. Câu "Agent/MCP Memory writes default to proposed unless explicitly resolved" thành sai và phải bị gỡ.

  Ràng buộc: `TestBuildInitialInstructionsLineLimit` (`initial_test.go:72`) giới hạn output ở 80 dòng. Hai bullet về System Decision và legacy `decision` category có thể nén thành một và trỏ sang `help("decision.*")`.
- **FR-12**: Số lượng memory chờ duyệt phải hiện ra như một việc cần làm, không phải một con số thống kê. `initial` hiện in `memories: 48p, 60g`. Thay bằng một dòng nêu số entry đang chờ và lệnh xử lý chúng. `knowns doctor` cũng nêu tương tự khi hàng đợi vượt ngưỡng.
- **FR-13**: Hướng dẫn "memory là gì" không được chỉ nằm ở `initial`, vì `initial` là best-effort: agent phải tự gọi và thường xuyên không gọi. Phân bổ theo độ tin cậy và chi phí của từng kênh:

  | Kênh | Tần suất | Đảm bảo | Nội dung |
  |---|---|---|---|
  | `CLAUDE.md` (`internal/instructions/`) | mỗi phiên, harness inject | **có** | định nghĩa đầy đủ, phép thử phủ định, yêu cầu provenance theo category |
  | MCP `initial` | mỗi phiên nếu được gọi | không | như FR-11, cộng vòng đời và trạng thái hàng đợi |
  | `UserPromptSubmit` hook (`runtimememory.go:941`) | **mỗi prompt** | **có** | đúng một dòng, vì nó trả giá token mỗi lượt |

  Dòng duy nhất trong hook phải là dòng có tác dụng đúng lúc ghi, đại ý: memory là thứ phiên sau cần, viết từ kết quả; nếu nó chỉ lặp lại prompt thì không viết. Bảy bullet hiện có trong block đó chỉ nói cách gọi tool, không nói cái gì đáng ghi, nên có thể nén để lấy chỗ.

  `CLAUDE.md` hiện đã có "Use memory tools ... `memory({ action: \"add\" })` after tasks for reusable knowledge" và "Proactively capture durable memory when scope and durability are clear". Hai câu này đúng hướng nhưng quá mơ hồ để hành động theo, và phải được thay bằng định nghĩa cùng phép thử phủ định.

### Non-Functional Requirements

- **NFR-1**: Anchor check ở FR-5 không được làm chậm đường inject đáng kể. Kho hiện ở quy mô vài chục entry sau migration, nên kiểm tra tuần tự là đủ; không đưa thêm phụ thuộc mạng hay lệnh dựng lại index vào đường này.
- **NFR-2**: Không có bước nào trong spec này yêu cầu agent nhớ làm một việc phụ để trạng thái trở nên đúng. Trạng thái dùng được phải là trạng thái mặc định của đường ghi.

## Acceptance Criteria

- [ ] **AC-1**: Grep `internal/runtimememory/` không còn khớp `workingContextPhrases`, `globalPreferencePhrases`, `inferWorkingContextCandidate`, `inferGlobalPreferenceCandidate`. Package build sạch và không còn hàm nào không có call site.
- [ ] **AC-2**: Trên một project mới khởi tạo, không cấu hình gì thêm, gửi một prompt chứa "hiện tại" hoặc "currently" thì không có memory nào được tạo ra. Đây là AC chứng minh defect đã ship được chặn ở mặc định.
- [ ] **AC-3**: Gọi MCP `memory({action:"add", content, title, category:"failure"})` với nội dung không trùng memory nào, không truyền `status`, thì entry trả về có `status: "active"` và được retrieve ngay ở lượt inject kế tiếp.
- [ ] **AC-4**: Cùng lời gọi đó nhưng nội dung trùng một memory đang có thì trả `review_required` và **không** tạo entry `active`. Cổng duyệt vẫn còn cho nhánh trùng lặp.
- [ ] **AC-5**: Gọi MCP `memory({action:"update", id, sources:[...], confidence:"high"})` rồi `get` lại thì thấy đúng giá trị vừa ghi, và `lastVerified` đổi khi được truyền.
- [ ] **AC-6**: `contradict` trên một memory `category:"failure"` chuyển nó sang `stale`. `contradict` trên một memory `category:"preference"` giữ `active`, gắn `disputed`, và response nêu rõ cần người dùng quyết.
- [ ] **AC-7**: Một memory loại 1 trích một symbol không còn tồn tại trong repo thì xuất hiện trong phần inject kèm dấu `suspect`, và status của nó không đổi.
- [ ] **AC-8**: `memory({action:"add", category:"preference"})` với content không có `**Why:**` bị từ chối. Cùng lời gọi đó có `**Why:**` thì thành công.
- [ ] **AC-9**: `memory({action:"add", category:"implementation"})` bị từ chối. Bốn category hợp lệ thì thành công.
- [ ] **AC-10**: Hai lần `add` cùng một `key` trong cùng một layer cho ra đúng một entry, lần thứ hai trả `replaced: true`, và `id` không đổi giữa hai lần.
- [ ] **AC-11**: Một entry `proposed` quá hạn tự chuyển `rejected`. Một entry `active` cũ hơn ngưỡng đó **không** xuất hiện trong danh sách ứng viên cleanup, khác với hành vi hiện tại.
- [ ] **AC-12**: Block `Knowledge Lifecycle` của `initial` nêu được cả bốn điều ở FR-11: memory là sự việc phiên sau cần, sinh từ kết quả chứ không từ prompt, phép thử phủ định, và yêu cầu provenance khác nhau giữa `preference` và ba category còn lại. Câu "writes default to proposed unless explicitly resolved" không còn.
- [ ] **AC-13**: `TestBuildInitialInstructionsLineLimit` vẫn pass sau khi viết lại block, tức toàn bộ output `initial` còn dưới 80 dòng.
- [ ] **AC-14**: `initial` nêu số memory đang chờ duyệt kèm lệnh xử lý, thay cho dòng thống kê `48p, 60g`.
- [ ] **AC-15**: Sau migration, không còn entry nào có title `Session working context`, `User collaboration preference`, `Memory capture preference`, hay `Response preference`. Thư mục export chứa đủ 86 file. Sáu memory `0ecdjo`, `haohsn`, `jd7fhu`, `ev4e4o`, `3eifu6`, `sbf2ih` ở trạng thái `active`. Nội dung của `zzt7pq`, `8a36wi`, `9ha6fk` tồn tại ở dạng mới và truy được.
- [ ] **AC-16**: Không còn memory nào ở global layer mang tag của một dự án khác (`autosub`, `stitch`, `cloudinary`, `rebac`).
- [ ] **AC-17**: `knowns validate --scope all` liệt kê ba entry `2s3q4u`, `3kno2x`, `ew4xea` là thiếu provenance, và không coi đó là lỗi chặn.

## Scenarios

### Scenario 1: Agent ghi một memory và dùng được ngay

**Given** một agent vừa sửa xong một lỗi và rút ra được bài học có trích symbol
**When** agent gọi MCP `memory({action:"add", category:"failure", content:"... `binaryPath()` ...", sources:["internal/runtimequeue/runtimequeue.go"]})`
**Then** memory được tạo ở `active`, và ở prompt kế tiếp nó xuất hiện trong phần inject với `trust=active`

### Scenario 2: Xác minh trở thành sản phẩm phụ của việc dùng

**Given** một memory loại 1 đang `active`, `lastVerified` đã cũ
**When** agent đọc nó, đối chiếu với code hiện tại, thấy vẫn đúng, rồi gọi `confirm(id)`
**Then** `lastVerified` cập nhật về hiện tại, status giữ nguyên, và không cần thao tác nào khác

### Scenario 3: Agent không được phép bác một cam kết

**Given** memory `ipkq69` category `preference`, nội dung là rule không dùng em dash
**When** một agent gọi `contradict("ipkq69", "thấy em dash trong một file")`
**Then** memory vẫn `active`, được gắn `disputed` kèm note, và response nói rõ rằng chỉ người dùng mới bác được cam kết của chính họ

### Scenario 4: Anchor chết được phát hiện mà không bị xoá oan

**Given** memory `ev4e4o` trích symbol `runtimequeue.testSandboxRoot()`
**When** symbol đó bị đổi tên trong một refactor và một prompt mới được gửi
**Then** memory vẫn được inject nhưng mang dấu `suspect`, status không đổi, và agent thấy được là cần kiểm tra lại trước khi tin

### Scenario 5: Preference không có lý do bị chặn

**Given** một agent muốn lưu một preference mới
**When** agent gọi `add` với `category:"preference"` và content chỉ có mệnh lệnh, không có `**Why:**`
**Then** lời gọi bị từ chối kèm thông báo nêu rằng preference phải ghi lý do vì đó là thứ duy nhất cho phép suy rộng ra tình huống mới

## Technical Notes

- `memoryreview.Add` giữ nguyên chữ ký. FR-2 sửa ở phía gọi, tức `handleMemoryAdd` truyền `AddOptions{Status: ...}`, không đổi mặc định của `memoryreview` để tránh ảnh hưởng các đường gọi khác.
- Nhánh `ResultReviewRequired` giữ nguyên hành vi hiện tại ở lần này. Việc biến review thành non-blocking là hướng riêng, không nằm trong spec này.
- FR-5 phải tuân `@decision/20260827-1529-anchor-durable-citations-to-symbols-not-line-numbers`: neo vào symbol, không neo vào số dòng. Sáu memory project hiện có đã trích đúng dạng này (`binaryPath()`, `TaskChange.OldValue`, `runtimequeue.testSandboxRoot()`), nên chúng là bộ dữ liệu thử sẵn có.
- `internal/instructions/skills/kn-extract/SKILL.md` đã quy định chỉ dùng bốn category `pattern`, `convention`, `preference`, `failure`. Category `context` mà auto-capture đang ghi nằm ngoài danh sách đó, nên FR-1 cũng là việc đưa code về đúng contract đã có.

## Task Generation

- Task Prefix: MEM

## Task Links

| Wave | Task | FR | Status |
|---|---|---|---|
| 1 | `MEM-ZRRANS` Remove keyword auto-capture from runtime memory | FR-1 | in-review, committed `3b02f6e` |
| 2 | `MEM-7MH0SK` MCP memory write path: provenance, active default, Why and category gates, key upsert | FR-2, 3, 6, 7, 8 | in-review |
| 2 | `MEM-YEWBH2` Teach the instruction layer what a Memory is, across all three delivery channels | FR-11, 12, 13 | in-review |
| 3 | `MEM-F2GSWW` Verification lifecycle: confirm and contradict, plus a bounded proposed queue | FR-4, 10 | todo |
| 3 | `MEM-1YT800` Flag world-fact memories whose cited anchors no longer exist | FR-5 | todo |
| 4 | `MEM-TAT57N` Migrate the memory store: export, delete 83, rescue 3, normalize the rest | FR-9 | todo |
| follow-up | `MEM-FB7A6Y` Retire the runtime memory capture surface now that nothing can capture | out of spec scope | todo |

Phụ thuộc khai bằng `@task-<id>{blocked-by}` trong description, không bằng `order`, theo `@decision/20260828-0249-task-dependencies-are-declared-as-blocked-by-edges-order-is-display-sequence-only`.

### Đính chính với FR-12

FR-12 viết "thay dòng thống kê `memories: 48p, 60g`". Sai: `%dp, %dg` ở `internal/mcp/handlers/initial.go` là số theo **layer** (project và global), không phải số `proposed`. `MEM-YEWBH2` giữ nguyên số theo layer và **thêm** một dòng cảnh báo chỉ hiện khi có entry chờ duyệt.

## Open Questions

- [ ] Ba preference `2s3q4u` (giữ tên feature tiếng Anh), `3kno2x` (chính sách model cho sub-agent), `ew4xea` (trả lời trung thực) đang thiếu `**Why:**`. Chỉ người dùng cấp được lý do. Cần thu thập trước khi coi kho là sạch.
- [ ] Bug hash mà `zzt7pq` mô tả (watcher ghi `\n{content}\n` còn hàm hash hash `{content}`) còn sống không. Chưa xác nhận được vì không tìm thấy `internal/watcher/`. Nếu còn sống thì phải tách thành task riêng.
- [ ] Thư mục export ở D2 đặt ở đâu và có commit không.
- [ ] `9ha6fk` chuyển thành doc ở đường dẫn nào.
- [ ] Người dùng đã cài Knowns từ trước có cần một lệnh dọn dẹp một lần không, hay chỉ cần FR-1 chặn nguồn rồi để họ tự xử lý phần tồn đọng.
- [ ] Cột `Review state` trong Web UI hiển thị `Needs evidence` cho mọi dòng, kể cả memory `active` vừa được xác minh. `reviewState` không tồn tại trong bất kỳ file memory nào (grep 107 file, 0 kết quả). Bug hiển thị, cần task riêng ngoài spec này.

## Spillover: chỉ dẫn không hiệu lực ngoài phạm vi memory

Ba bằng chứng dưới đây nằm ngoài phạm vi spec này nhưng cùng một dạng lỗi, và nên thành task riêng thay vì mở rộng spec:

1. **`initial` phát FORBIDDEN mà agent không thể tuân.** Nó viết "Do not use built-in read/grep/edit as the first step for code" và bắt dùng `code.find`, trong khi chính nó báo `Code index: symbols: 0 | relations: 0`. Không có gì để tìm. `initial` nên nói thật trạng thái kèm lệnh khắc phục khi một năng lực bắt buộc đang không sẵn sàng, thay vì phát một quy tắc không thể tôn trọng. Nguyên tắc chung: **không ra lệnh cho một đường đi mà runtime đang không cung cấp.**
2. **`blocked-by` edges rỗng.** Có code (`internal/references/references.go:24-34`), có structural edges (`internal/storage/structural_edges.go:186`), có test multi-hop pass, và 0 trên 35 task dùng. Xem `@decision/20260828-0249-task-dependencies-are-declared-as-blocked-by-edges-order-is-display-sequence-only`.
3. **`tasks/` và `memory/` không sync giữa máy.** `.knowns/.gitignore` chỉ track `docs/`, `templates/`, `decisions/`, `config.json`. Config repo này đặt `gitTracking.tasks: false`, trong khi `@doc/features/git-modes` quy định mặc định phải là `true` ở cả hai mode. 42 task và 107 memory chỉ tồn tại trên một máy.

Cả ba cùng một hình dạng với lỗi trung tâm của spec này: **năng lực đã được xây, đường ghi không bắt buộc dùng nó.** Đó là lý do chúng được ghi lại ở đây thay vì bị bỏ quên.
