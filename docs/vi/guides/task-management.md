# Quản lý task

Task là đơn vị công việc chính trong Knowns.

## Task gồm gì?

- title
- description
- status
- priority
- labels
- assignee
- acceptance criteria
- implementation plan
- implementation notes

## Tại sao cần task?

Task cho cả người và AI một mục tiêu rõ ràng.

Thay vì nói "làm phần auth đi", define cụ thể:

- cần build gì
- check thành công bằng cách nào
- context nào liên quan
- đang làm đến đâu

## Flow điển hình

```bash
knowns task create "Add authentication" \
  -d "JWT-based auth with login and register endpoints" \
  --ac "User can register" \
  --ac "User can login" \
  --priority high

# Namespace ID tuỳ chọn cho một task; tạo ID như FR-4F7Q2M
knowns task create "Add authentication feature" --prefix FR

knowns task edit <id> -s in-progress
knowns task edit <id> --plan '1. Review auth pattern\n2. Implement endpoints\n3. Add tests'
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "Completed middleware"
knowns task edit <id> -s done
```

Task ID là immutable và vẫn là public identifier duy nhất. Project có thể set
`settings.defaultTaskIdPrefix`; `--prefix` chỉ override cho task đang tạo và
không đổi config. Các ID numeric, hierarchical và random 6 ký tự cũ vẫn đọc
được, không cần migration.

## Acceptance criteria

AC đặc biệt quan trọng khi làm việc với AI — biến khái niệm "xong" thành thứ kiểm tra được.

AC tốt nên:

- cụ thể
- observable
- đủ nhỏ để check từng cái

## Reference trong task

Task có thể reference tới doc hoặc entity khác:

- `@doc/architecture/auth`
- `@task-abc123`

## Xem thêm

- [Lệnh](../reference/commands.md)
- [Reference system](../reference/reference-system.md)
- [Workflow](./workflow.md)
