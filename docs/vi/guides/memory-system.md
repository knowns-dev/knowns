# Memory

Memory là nơi Knowns lưu context cần nhớ lại sau này.

## Ba layer

- **working memory** — context ngắn hạn, chỉ sống trong một session
- **project memory** — pattern, convention, failure và implementation context ngắn của một repo
- **global memory** — preference hoặc rule dùng được across projects

## Memory hay doc?

Dùng memory khi:

- ngắn gọn, cần recall nhanh
- hữu ích để recall nhưng không phải lựa chọn hệ thống bền vững
- hữu ích cho nhiều lần làm việc sau

Dùng doc khi cần giải thích dài hoặc chia thành nhiều section.

## Ví dụ

```
"We use repository pattern for data access"
"Always validate before marking a task done"
"Prefer semantic search over manual grep for exploration"
```

Nội dung memory thường viết bằng tiếng Anh vì AI đọc trực tiếp.

## Lệnh

```bash
knowns memory add "We use repository pattern" --category pattern
knowns memory list --plain
knowns memory <id> --plain
```

Memory category `decision` là legacy và write mới sẽ bị từ chối. Record cũ vẫn đọc được cho tới khi migration đã review có replacement được verify, accepted, current và luồng consumption của Decision đã active. Lựa chọn architecture hoặc workflow bền vững phải dùng first-class System Decision:

```bash
knowns decision create "Use Postgres for metadata"
knowns decision link <id> --source @doc/architecture/storage --task <done-task-id>
knowns decision accept <id>
```

Dùng `knowns decision migrate preview --plain` để lấy inventory read-only. Mỗi lần chỉ apply một resolution đã review rõ ràng; dùng `knowns decision migrate rollback <memory-id>` để hoàn tác migration an toàn.

## Xem thêm

- [Quản lý task](./task-management.md)
- [Reference system](../reference/reference-system.md)
