---
title: "Implementation Checklist"
description: ""
createdAt: "2025-12-25T15:16:58.867Z"
updatedAt: "2025-12-25T15:25:52.985Z"
tags: ["conventions"]
---

---

## New Feature

### Domain Layer (`src/domain/{module}/`)

- [ ] Create entity extending `Entity<Props>` or `EntityWithEvents<Props>`
- [ ] Define enum for entity status
- [ ] Create domain events (if state changes)
- [ ] Define repository interface (abstract class)

### Value Objects (`src/core/value-objects/`)

- [ ] Create value objects for complex types
- [ ] Implement `create()` factory with validation
- [ ] Implement `isValid()` static method
- [ ] Implement `toPlain()` for serialization

### Exceptions (`src/core/exceptions/`)

- [ ] Create domain exceptions extending `DomainException`
- [ ] Define unique `code` for each
- [ ] Use appropriate HTTP status codes

### Application Layer (`src/application/{module}/`)

- [ ] Create repository port in `ports/`
- [ ] Create use cases in `use-cases/`
- [ ] Create event handlers in `event-handlers/`

### Infrastructure Layer (`src/infra/`)

- [ ] Create Prisma mapper (5 methods) in `persistence/prisma/mapper/`
- [ ] Create Prisma repository in `persistence/prisma/repositories/`
- [ ] Create DTOs in `http/dtos/`
- [ ] Create controller in `http/controllers/`

### Module Registration

- [ ] Register use cases as providers
- [ ] Bind repository port to implementation
- [ ] Register event handlers
- [ ] Export necessary providers

---

## Security

- [ ] `@UseGuards(JwtGuard, EmailVerifiedGuard, RoleGuard)`
- [ ] `@Roles()` for required roles
- [ ] `@Public()` for public endpoints
- [ ] `@SkipEmailVerification()` where needed
- [ ] Validate inputs with class-validator

---

## Event-Driven

- [ ] Entity extends `EntityWithEvents<Props>`
- [ ] Events in `src/domain/{module}/events/`
- [ ] Handlers in `src/application/{module}/event-handlers/`
- [ ] Repository dispatches events after persistence


| Question | If Yes → |
|----------|----------|
| `@doc/patterns/server-pattern` | Create Atom |
| @doc/patterns/server-pattern | Create Molecule |
| Is it a distinct UI section with business logic? | Create Organism |
| Does it define page structure without content? | Create Template |
| Does it render a complete view with data? | Create Page |

## Related Docs

- @doc/patterns/server-pattern - Express Server Pattern
- @doc/patterns/storage-pattern - File-Based Storage Pattern
