---
id: doc-3ec2add162085f2bc37851cebe1a9d84
title: Hash drift between writer and verifier
description: 'Bang chung day du cho memory jd7fhu: hai ca da xac nhan, chan doan, va cach sua'
createdAt: '2026-09-09T10:22:25.200Z'
updatedAt: '2026-09-09T10:22:30.665Z'
tags:
  - storage,hashing,integrity,debug,evidence
---

> Bằng chứng đầy đủ cho `@memory/jd7fhu`. Memory giữ mệnh đề, doc này giữ chẩn đoán,
> nguyên nhân gốc, và cách sửa. Tách ra ngày 2026-09-09 vì memory được inject vào MỌI
> prompt, còn phần bằng chứng chỉ cần khi đang gặp đúng lỗi này.


When a stored hash validates on write but fails on read, suspect two implementations of the same hash before suspecting the data.

**Signal:** `history is corrupt: record hash mismatch at revision N` while the plain read of the same file succeeds and returns complete snapshots, and the `prevRecordHash` chain is unbroken. Intact data plus a failing integrity check means the checker is wrong.

**Root cause found in `internal/storage/history_jsonl.go` (fixed 2026-08-27, commit `985517f`):** `historyRecordHash` normalized records through `models.HistoryRecord`, where `TaskChange.OldValue` and `NewValue` are `any`, so a nested object became `map[string]any` and Go marshalled its keys sorted. `marshalMetadataForHash` re-emitted the file's bytes verbatim through `json.RawMessage`, preserving the struct field order they were written in. `models.AcceptanceCriterion` declares `Text` before `Completed`, so disk held `{"text":...,"completed":false}` and the normalized form held `{"completed":false,"text":...}`.

**Why it hid:** only records whose change values contain a nested object diverge. Revisions carrying scalar changes such as `status` or `priority` validated fine, so the defect needed a Task to accumulate an acceptance-criteria change before it surfaced. It was introduced at birth, not by a regression: the two representations were created seven minutes apart in `ac1c615` and `25b5f81` and never reconciled.

**Second confirmed instance, same family, different subsystem (2026-08-20, since fixed).** Doc tag writes were stuck: every write after a successful one was rejected with two fixed hash values. The mechanism was the same shape, a writer and a verifier disagreeing about what the record is, but here it was byte framing rather than key order: the watcher wrote the file as `\n{content}\n` while the hash function hashed `{content}`. The tell was that it needed no pre-existing broken chain: a document created minutes earlier jammed on its second write. Also notable is what still worked, `doc edit --section --content` succeeded while metadata writes failed, so the failure looked content-specific when it was not. Verified resolved on 2026-09-09 by writing tags to one doc twice in a row; both succeeded.

**Diagnostic that settles it fast:** for every revision, compute the hash both ways and compare each against the stored value. If the writer's path matches the stored hash everywhere and only the reader disagrees, the data is fine and the reader is the bug. Print the first differing byte with surrounding context rather than comparing hashes alone; the byte diff names the field immediately.

**Fix shape:** delete the second implementation. Have the reader rebuild the full typed record and call the writer's function, so the two cannot drift again. Keep a test that a tampered payload is still rejected, so unifying the paths does not turn the check into a formality.

**This is not confined to hashing.** The same shape appeared again on 2026-09-09 in `cleanupMemoryCandidates`, which existed twice, once in `internal/cli` and once in `internal/mcp/handlers`, and the copies had already drifted: one applied defaults for `olderThanDays` and `limit` and the other did not, so the same request answered differently depending on which door it came through. Any rule duplicated across two call paths will drift; the fix is always to keep one and have the other call it.

Related: [[knowns-sync-uses-binary-embed]]
