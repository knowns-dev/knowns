---
id: doc-6ef62953698051296cb551a985a78a0e
title: Knowns Strategy and Context Handoff 2026-09-03
description: Phan tich thi truong va ma nguon Knowns, dinh vi canh tranh, danh sach P0-P3. Khoi phuc tu memory 9ha6fk.
createdAt: '2026-09-09T10:02:44.770Z'
updatedAt: '2026-09-09T10:03:13.635Z'
tags:
  - strategy,positioning,competitive,handoff,historical
---

> Khôi phục từ memory `9ha6fk`, một entry mà auto-capture theo keyword đã tạo ra
> ngày 2026-09-03 bằng cách chép nguyên prompt của người dùng. `normalizeCapturedContent`
> gọi `normalizeWhitespace`, nên **toàn bộ xuống dòng trong tài liệu gốc đã bị nuốt**
> thành một dòng duy nhất.
>
> Cấu trúc dưới đây được dựng lại bằng máy từ các dấu hiệu markdown không mơ hồ:
> heading, blockquote, checklist, hàng bảng, và đường kẻ ngang. Xuống dòng bên trong
> đoạn văn thì **không khôi phục được**, nên nhiều đoạn vẫn dính liền nhau.
> Nội dung chữ nghĩa còn nguyên vẹn, chỉ có trình bày là mất.
>
> Nguồn: `@task-MEM-TAT57N`, spec `@doc/specs/2026-09-09/persistent-memory-usability` (D2).

# Knowns — Chiến lược & bàn giao ngữ cảnh
> Tài liệu bàn giao cho phiên Claude Code. Tổng hợp kết quả một buổi phân tích thị trường
> và đọc mã nguồn. Ngày: 2026-09-03.
> Chủ dự án: Howz (`howznguyen`) — Go là ngôn ngữ chính, làm một mình, ngoài giờ.

---

## 1. Bối cảnh: hai mục tiêu đang bị trộn vào nhau Buổi làm việc bắt đầu từ câu hỏi "làm sản phẩm nhỏ nào để kiếm thu nhập", đi qua khoảng mười hai vòng đề xuất và loại bỏ, rồi quay về Knowns. Kết luận quan trọng nhất: **Đây là hai mục tiêu khác nhau và không nên bắt một sản phẩm gánh cả hai.** - Mục tiêu A — thu nhập sớm, chu kỳ ngắn. - Mục tiêu B — Knowns thành sản phẩm thật, chu kỳ 12–24 tháng. Trộn chúng lại là cách phổ biến nhất để cả hai cùng chết. Tài liệu này chủ yếu phục vụ mục tiêu B; mục tiêu A được ghi lại ở mục 7 để không mất dấu.

---

## 2. Phân tích mã nguồn Knowns (đã đọc trực tiếp repo) Repo: `github.com/knowns-dev/knowns` · module `github.com/howznguyen/knowns` Quy mô: **150.642 dòng Go, 493 file.**

### 2.1 Phân bổ công sức — đây là phát hiện trung tâm
| Nhóm
| Package
| Dòng
| |---|---|---|
| Hàng hóa phổ thông
| `cli`
| 26.067
| |
| `storage`
| 23.433
| |
| `search`
| 22.017
| |
| `lsp`
| 15.817
| |
| `server`
| 12.584
| |
| `mcp`
| 10.853
| |
| **Cộng**
| **110.771 — 74%**
| | Khác biệt hóa
| `validate`
| 1.638
| |
| `decisionreview`
| 1.646
| |
| `decisionmigration`
| 1.633
| |
| `memoryreview`
| 930
| |
| **Cộng**
| **5.847 — ~4%**
| **74% khối lượng đang cạnh tranh trực diện với Beads, Serena, Mem0 — và thua vì đối thủ có phân phối. 4% không cạnh tranh với ai.**

### 2.2 Phần khác biệt hóa — đã tồn tại trong code, không phải kế hoạch `internal/models/decision.go` có vòng đời quyết định đầy đủ: - Trạng thái: `draft` → `accepted` → `superseded` / `rejected` / `archived` - Quan hệ: `Supersedes`, `SupersededBy` - Kiểm chứng: `Verification`, `VerifiedAt` - Máy trạng thái review: `needs_evidence` / `needs_resolution` / `ready_for_review` - `DecisionReviewMatch` có `Score` + `MatchedBy` — phát hiện quyết định mới trùng/mâu thuẫn với quyết định cũ `internal/validate/validate.go` có phần đối chiếu spec với quyết định: ```go decisionComplianceLineRE = `^\s*Spec Decision Compliance:\s*(.+)$` decisionComplianceItemRE = `^\s*(D[1-9][0-9]*)\s*=\s*(pass|conflict)...` codeRefRE = `@code/([^\s\)]+)` lockedDecisionRE = `^\s*-\s*(D[1-9][0-9]*):\s*\S` systemDecisionImpactRE = `^\s*-\s*Impact:\s*(.+)$` ``` **Không đối thủ nào có cái này.** Xem mục 3.

### 2.3 Hai lỗi cần sửa ngay — chi phí gần bằng 0, tác động lớn **(a) `ARCHITECTURE.md` mô tả sai codebase.** Nó viết về một dự án **TypeScript**: `task.ts`, `doc.ts`, `file-store.ts`, `version-store.ts`, `src/index.ts`, "Express + WebSocket". Code thật là Go trong `internal/`. Với một sản phẩm mà luận điểm cốt lõi là *"AI nên đọc artifact thật của dự án"*, việc tài liệu kiến trúc nói dối mọi agent đọc nó là mâu thuẫn nghiêm trọng — và là thứ đầu tiên một dev khó tính trên Hacker News soi ra. **(b) `PHILOSOPHY.md` đã trôi khỏi code.** Nó viết *"No SQLite. No JSON database. Just markdown files."* Nhưng repo có `internal/qdrantruntime` (1.507 dòng), `storage` 23k, `search` 22k. Cần một trong hai: sửa triết lý cho khớp thực tế, hoặc nói rõ đâu là nguồn sự thật và đâu là chỉ mục phái sinh.
> PHILOSOPHY.md là tài sản định vị tốt nhất hiện có — rõ ràng, có lập trường, hơn hẳn
> README dài 27.372 ký tự. Đừng để nó sai.

---

## 3. Bối cảnh cạnh tranh (đã kiểm chứng qua tra cứu)
| Đối thủ
| Chiếm phần nào
| Vì sao không đấu trực diện được
| |---|---|---|
| **Mem0, Zep, Letta, Cognee, Supermemory, Graphiti, MemoryLake**
| Memory layer
| Danh mục bão hòa, giá đã chuẩn hóa $10–20/tháng. Supermemory có sẵn plugin cho Claude Code và OpenCode.
| | **GitHub spec-kit**
| Spec workflow
| Thương hiệu GitHub, MIT, hỗ trợ 30+ agent, "default-tool gravity".
| | **Beads (`gastownhall/beads`, Steve Yegge)**
| Task + project memory
| **MIT, viết bằng Go, single binary — cùng stack, cùng triết lý.** ~8–9k commit, phát hành qua npm + PyPI. Có `bd remember` cho memory, compaction để tiết kiệm context. Yegge có lượng độc giả không mua được bằng tiền. |

### 3.1 Nhưng cả ba đều dừng ở cùng một chỗ - **Beads** là *issue tracker* có trí nhớ. `bd remember "insight"` là ghi chú phẳng — không có vòng đời, không có `superseded`, không đối chiếu với code. - **spec-kit** đóng băng spec sau khi ship. Nguyên tắc số II trong hiến pháp của chính họ: *"Spec-Forward, Historical Once Shipped"*. Theo thiết kế, nó không quan tâm chuyện gì xảy ra sáu tháng sau. - **Mem0 và họ hàng** lưu fact, không lưu ràng buộc. **Không ai trả lời được câu: "symbol vừa viết này vi phạm quyết định kiến trúc đặt ra từ tháng ba".** Đó là ô trống, và Knowns đã có code trong ô đó.

### 3.2 Cảnh báo: ô đó không hoàn toàn trống - `jmanhype/speckit` đã ghép spec-kit + Beads và gọi đó là "killer combo" - CodeMySpec tự định vị là "full-lifecycle harness" - Amazon có Kiro - Chạy chậm là mất chỗ

---

## 4. Định vị đề xuất Bỏ nhãn "memory layer" — nó đặt Knowns vào ô đông nhất và có vốn nhất. **Định vị mới, một câu:**
> Knowns giữ cho coding agent không phá vỡ quyết định kiến trúc đã có —
> cắm cạnh Beads hoặc spec-kit, không thay thế chúng. Hệ quả: **spec-kit là kênh phân phối, không phải bức tường.** Nó MIT, trung lập với agent, và có quy trình xuất bản extension/preset/community bundle chính thức. Đọc được output của nó (`constitution.md`, `spec.md`, `plan.md`, `tasks.md`) rồi làm phần nó từ chối làm. Rủi ro phải chấp nhận: sống trên nền tảng người khác thì bị nuốt tính năng lúc nào cũng được — `/speckit-converge` đã là bước đối chiếu implementation với spec. Nhưng ở vị trí chưa có người dùng, rủi ro bị nuốt sau này nhẹ hơn rủi ro không ai biết đến mình bây giờ.

---

## 5. Việc cần làm — theo thứ tự ưu tiên

### P0 — sửa ngay, gần như miễn phí
- [ ] **Viết lại `ARCHITECTURE.md`** cho khớp cấu trúc Go thật (`cmd/knowns`, `internal/*`). Xóa toàn bộ tham chiếu TypeScript/Express.
- [ ] **Đối chiếu `PHILOSOPHY.md` với code.** Làm rõ: markdown là nguồn sự thật, Qdrant/search index là chỉ mục phái sinh, dựng lại được, xóa được.
- [ ] **Viết một câu định vị** và đặt lên đầu README. Học cách Beads gọi tên kẻ thù rất cụ thể ("thay thế đống markdown plan nửa vời trong thư mục `plans/`"). README 27k ký tự hiện tại là một bức tường, không ai đọc.

### P1 — thu hẹp phạm vi
- [ ] **Đóng băng `internal/lsp` (15.817), `internal/server` (12.584), phần lớn `internal/search`.** Không xóa — chúng chạy được và vẫn dùng nội bộ. Chỉ ngừng đầu tư thời gian.
- [ ] **Không xây đồ thị phụ thuộc task.** `models.Task` hiện chỉ có `Parent`; Beads có bốn loại quan hệ và `bd ready`. Sự thiếu vắng này là *bằng chứng task là sân của Beads*, không phải hạng mục cần bù.
- [ ] Cân nhắc: tích hợp với `bd` thay vì cạnh tranh ở tầng task.

### P2 — lấy từ Beads
- [ ] **Đổi cách đặt tên file task.** Hiện tại: `task-KN-4F7Q2M - Title.md` — tiêu đề nằm trong tên file, nên đổi tiêu đề = đổi tên file = rác trong git + đụng độ merge khi nhiều agent chạy song song trên nhiều nhánh. Beads dùng ID băm (`bd-a1b2`) và tuyên bố zero-conflict đúng vì lý do này. **Sửa: tên file chỉ chứa ID, tiêu đề nằm trong frontmatter.** Cần script migrate.
- [ ] **Onboarding một dòng.** Beads: thêm một dòng vào `AGENTS.md` + `bd prime`. Cài bằng một lệnh curl, phát hành npm + PyPI. Knowns đã có thư mục `npm/` — hoàn thiện nốt.
- [ ] Xem cơ chế compaction của Beads (tóm tắt task cũ đã đóng để tiết kiệm context window) và so với `internal/memoryreview` (930 dòng).

### P3 — kiểm chứng bên ngoài
- [ ] Cài spec-kit vào một repo thật, chạy hết vòng `constitution → specify → plan → tasks → implement → converge`. Ghi lại **chỗ nào nó làm mình khó chịu nhất**. Nếu chỗ đó trùng với thứ Knowns đã làm → có định vị. Nếu thấy nó đủ dùng → đó cũng là câu trả lời.
- [ ] Viết một đoạn ba câu mô tả **một tình huống cụ thể** agent phá vỡ quyết định cũ và Knowns chặn được. Đưa cho 5 developer đang dùng Claude Code/Cursor hằng ngày.
- [ ] Xuất hiện ở nơi dev tool được tìm thấy: GitHub, Hacker News, r/programming, X, danh bạ MCP server, các bài so sánh "best AI memory tools". **Poster Facebook tiếng Việt là lệch kênh** — mọi đối thủ ở mục 3 đều có mặt trong các bài so sánh đó, Knowns thì không.

---

## 6. Câu hỏi chưa trả lời — quyết định mọi thứ
> **Ngoài Howz ra, hiện có bao nhiêu người dùng Knowns hàng tuần?** - Nếu **0**: vấn đề không phải Hub, không phải kiến trúc, không phải tính năng. Mọi thứ trong roadmap đều là trì hoãn. Việc cần làm là P0 + P3. - Nếu **3–5**: có thứ quý hơn nhiều so với cảm nhận. Việc tiếp theo là hỏi họ trả tiền cho cái gì. Câu hỏi thứ hai, thành thật: **Knowns là thứ muốn dùng, hay thứ muốn bán?** Nếu để dùng — bối cảnh cạnh tranh ở mục 3 không liên quan, cứ dùng và sửa. Nếu để bán — phải chấp nhận rằng thứ quyết định thắng thua là phân phối, không phải tính năng.

### Hạng mục roadmap nên hoãn cho tới khi có câu trả lời - Hub multi-tenant đầy đủ — bán được, nhưng chỉ khi có đội nhóm đòi - Plugin marketplace — của sản phẩm đã có hệ sinh thái - Tự viết agent loop bằng Go thay OpenCode — hàng hóa phổ thông, không ai trả tiền - Web Chat UI riêng — như trên

---

## 7. Mục tiêu A (thu nhập ngắn hạn) — trạng thái Đã loại, kèm lý do: công cụ ảnh cho seller Shopee/TikTok (sàn tự làm miễn phí); sổ sách hộ kinh doanh (Nghị định 20/2026 — Nhà nước phát phần mềm miễn phí); sao kê PDF → Excel (bão hòa toàn cầu); ảnh thẻ (đỏ nhất); quyết toán thuế TNCN (rào cản lòng tin); BHXH (quy định thống nhất toàn quốc → không có phân mảnh → không có hào bảo vệ). **Quy tắc rút ra:** ở Việt Nam không thể có đồng thời cả ba — *đời thường*, *trả một lần*, và *đủ tiền để đáng làm*. Phải bỏ một. Còn sống: - **Tuyển sinh lớp 10 + đại học** — deadline cứng, hai mùa/năm (tháng 4 và tháng 7), dữ liệu có biên, phụ huynh chịu chi. Nhược điểm: dùng một lần trong đời → **không SaaS được**. - **PDF/A + PDF/X compliance repair** — thị trường quốc tế, $3–9/file, chi phí biên ~0, SEO theo từng mã lỗi validation. Lưu ý: `pdfcpu` là Apache 2.0 dùng được, `UniPDF` cần license thương mại; `veraPDF` chạy Java nên có thể phải hy sinh single-binary. Hạ tầng thanh toán quốc tế (nếu cần): **Polar** có Việt Nam trong danh sách payout; **Lemon Squeezy** payout qua PayPal phủ 200+ nước. Duyệt mất ~2 tuần → nộp hồ sơ trước khi code.

---

## 8. Thí nghiệm đã chạy: khai thác tín hiệu từ GitHub — **kết quả âm tính** Công cụ: `ghsignal.go` (kèm theo). Quét issue GitHub tìm ngôn ngữ sẵn sàng chi trả. **Kết quả: 175 bản ghi trải trên 153 repo — không có cụm nào lặp lại.** Nguyên nhân: trong tiếng Anh kỹ thuật, `"willing to pay"` gần như luôn là thành ngữ chỉ đánh đổi chi phí, không phải rút ví. Nhiễu điển hình: `the account owner would pay the fee` (phí gas), `a cost we're willing to pay` (đánh đổi kỹ thuật), và một trường hợp khớp vào **tên thư mục** `F:\Shut up and take my money\steamapps\...`. Số ít hit thật đều cùng hình dạng: muốn mua **thời gian của một người cụ thể để sửa một cấu hình cụ thể** — không nhân bản được thành sản phẩm.

### Phát hiện phụ, quan trọng hơn kết quả chính Tổng số kết quả cụm "market gap" theo thời gian: ``` 2025 H1: 1.823 2025 H2: 2.257 2026 H1: 15.400 2026 Q3: 30.793 ← chỉ hơn 2 tháng ``` Tăng ~17 lần trong 15 tháng. Không có lý do thị trường nào giải thích được. Gần như chắc chắn là **text do AI sinh đang tràn ngập issue trên GitHub**. **Hệ quả cho IdeaTrack** (`ideatrackhub.com` — hiện `discover` báo "cụm đang theo dõi: 0", "Chưa có bài thảo luận trong kỳ"): nếu giả định nền là "gom tín hiệu từ thảo luận công khai", thì bài toán khó không phải crawl mà là **lọc tín hiệu khỏi nhiễu** — và độ nhiễu đang tăng theo hàm mũ. Chỗ tắc thật có thể không nằm ở khâu lấy dữ liệu.

### Hướng thử lại (chưa chạy) Đổi giả thuyết, không phải đổi từ khóa. Tìm dấu vết **hành vi đã xảy ra** thay vì ý định: `"we built this internally"`, `"we ended up writing our own"`, `"we hacked together a script"`. Người đã bỏ công tự làm vì không mua được gì là bằng chứng mạnh hơn nhiều so với lời hứa trả tiền.

---

## 9. Nguyên tắc rút ra trong buổi làm việc
1. **Pain lớn không đủ; pain phải phân mảnh.** Quy định thống nhất toàn quốc → ai cũng làm được → không có hào bảo vệ. (BHXH chết vì lý do này.)
2. **Mọi thứ có hình dạng "nhận file generic → trả file generic" đều sẽ bị nuốt.**
3. **Ở nơi mọi phần mềm đều miễn phí, tiền nằm ở chỗ có người chịu trách nhiệm** — in ra, giao đến, nộp hộ. Kết luận này xuất hiện độc lập ở hai phương pháp khác nhau.
4. **Một người làm một mình không giữ được phép hợp của nhiều danh mục. Chỉ giữ được phép giao.**
5. **Tỷ lệ trúng của indie hacker rất thấp** — 54% sản phẩm kiếm 0 đồng; hit rate của người giỏi nhất khoảng 8%. Không ai chọn đúng ý tưởng bằng phân tích; họ ship nhiều rồi để thị trường chọn. Suy ra: đừng dồn hết vào một canh bạc, và đừng phân tích thay cho việc ship.
6. **Với dev tool, phân phối là sản phẩm.** Kênh: GitHub, HN, Reddit, X, danh bạ MCP, các bài so sánh — không phải Facebook.
