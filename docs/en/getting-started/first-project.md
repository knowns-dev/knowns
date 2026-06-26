# First Project

After `knowns init`, your first goal is to add enough context that a person or AI assistant can understand the project without a long chat history. A good first setup usually includes four things:

1. create a task
2. create one or two documents
3. confirm search works
4. connect the AI runtime(s) you actually use

## Example session

This example creates an authentication task because it has a clear scope and testable acceptance criteria. Replace the title and descriptions with work that matches your repository.

```bash
knowns task create "Add authentication" \
  -d "JWT-based auth with login and register endpoints" \
  --ac "User can register with email/password" \
  --ac "User can login and receive JWT token"

knowns doc create "Auth Architecture" \
  -d "Authentication design decisions" \
  -f architecture

knowns search "authentication" --plain
knowns validate --plain
knowns browser --open
```

If you want an AI assistant to use the same project context, run setup for your platform:

```bash
knowns setup codex --global
# or:
knowns setup claude --global
```

`--global` is recommended for personal assistant setup because it updates user-level MCP config, skills, and runtime hooks. Use non-global setup only when you intentionally want repo-local integration files.

## Why these steps matter

- the task gives people and AI a concrete execution target
- acceptance criteria make "done" testable
- the doc gives AI structured context instead of ad-hoc chat explanations
- search confirms local retrieval is working
- validation checks that the basic project structure is sound
- setup connects generated guidance, MCP config, and skills to the assistant you actually use

## What to add next

- Add one architecture doc for the most important subsystem.
- Add one task for the next real change you plan to make.
- Add memory only for short decisions or conventions that should be recalled later.
- Run `knowns validate --plain` before treating the project setup as complete.

## Suggested next reads

- [User guide](../guides/user-guide.md)
- [MCP integration](../guides/mcp-integration.md)
