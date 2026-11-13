---
id: doc-00e4dddf6cbe0a2be033d72e1f5ea4f3
title: Mention Playground
description: Playground document for testing advanced mention rendering in the WebUI.
createdAt: '2026-04-17T07:01:00.408Z'
updatedAt: '2026-04-17T07:01:00.408Z'
tags:
  - playground
  - mentions
  - references
  - webui
---

# Mention Playground

Doc này dùng để thử các kiểu mention nâng cao trong WebUI.

## Resolved references

- Task cơ bản: @task-cuhima
- Task có relation: @task-cuhima{implements}
- Memory cơ bản: @memory-gplwgk
- Memory có relation: @memory-gplwgk{references}
- Doc cơ bản: @doc/features/semantic-reference-runtime
- Doc có relation: @doc/features/semantic-reference-runtime{implements}
- Doc theo heading: @doc/specs/semantic-reference-runtime#scenarios
- Doc theo line range: @doc/specs/semantic-reference-runtime:10-25
- Legacy doc path: .knowns/docs/features/semantic-reference-runtime.md

## Mixed sentence examples

Task @task-7m45b2{references} dựa trên @doc/specs/semantic-reference-runtime và có liên quan tới memory @memory-sfvzee.

Nếu cần parser/reference runtime, xem @task-cuhima, rồi đọc @doc/features/semantic-reference-runtime{related} và @doc/specs/semantic-reference-runtime#technical-notes.

## Broken references

- Broken task: @task-doesnotexist
- Broken memory: @memory-doesnotexist
- Broken doc: @doc/does/not/exist
- Broken doc heading: @doc/specs/semantic-reference-runtime#missing-heading

## Raw syntax comparison

Những dòng dưới đây để so sánh với render thật và không nên transform vì đang nằm trong code block:

```md
@task-cuhima{implements}
@memory-gplwgk{references}
@doc/specs/semantic-reference-runtime:10-25
@doc/specs/semantic-reference-runtime#scenarios
```
