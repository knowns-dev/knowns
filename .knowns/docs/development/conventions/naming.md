---
title: "Naming Conventions"
description: ""
createdAt: "2025-12-25T15:16:58.868Z"
updatedAt: "2025-12-25T15:25:52.985Z"
tags: ["conventions"]
---

---

## File Naming

| Type | Pattern | Example |
|------|---------|---------|
| Controller | `{entity}.controller.ts` | `user.controller.ts` |
| Use Case | `{action}-{entity}.use-case.ts` | `create-user.use-case.ts` |
| Repository Port | `{entity}.repository.ts` | `user.repository.ts` |
| Repository Impl | `prisma-{entity}.repository.ts` | `prisma-user.repository.ts` |
| Mapper | `prisma-{entity}.mapper.ts` | `prisma-user.mapper.ts` |
| Request DTO | `{action}-{entity}.request.ts` | `create-user.request.ts` |
| Response DTO | `{entity}.response.ts` | `user.response.ts` |
| Domain Entity | `{entity}.ts` | `user.ts` |
| Value Object | `{name}.value-object.ts` | `email.value-object.ts` |
| Exception | `{entity}-{error}.exception.ts` | `order-not-found.exception.ts` |
| Domain Event | `{entity}-{action}.event.ts` | `order-created.event.ts` |
| Event Handler | `{entity}-event.handlers.ts` | `order-event.handlers.ts` |
| Guard | `{name}.guard.ts` | `jwt.guard.ts` |
| Decorator | `{name}.decorator.ts` | `roles.decorator.ts` |
| Validator | `{name}.validator.ts` | `is-valid-email.validator.ts` |

---

## Code Naming

| Type | Convention | Example |
|------|------------|---------|
| Class | PascalCase | `UserService` |
| Interface | PascalCase | `UserRepository` |
| Enum | PascalCase | `UserRole` |
| Enum Values | SCREAMING_SNAKE | `UserRole.ADMIN` |
| Method | camelCase | `findById()` |
| Variable | camelCase | `userId` |
| Constant | SCREAMING_SNAKE | `MAX_RETRY_COUNT` |
| Private field | _camelCase | `_cache` |