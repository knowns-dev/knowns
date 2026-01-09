<!-- KNOWNS GUIDELINES START -->
# Knowns Project

This project uses **Knowns MCP** tools for task and documentation management.

## Before Starting

Call this MCP tool to get usage guidelines:

```
mcp__knowns__get_guideline({})
```

This will return the complete rules for:
- Task management workflow
- Documentation commands
- Time tracking
- Reference system
- Common mistakes to avoid
- MCP tools unavailable? Use the equivalent CLI command as a fallback.

You MUST call this at session start and follow every rule it returns. If you cannot follow a rule, stop and ask for guidance before proceeding.

**Fallback:** If any MCP tool is missing or fails, first run `knowns agents guideline --cli` to load the CLI rules, then switch to the matching CLI command (e.g., `knowns task list --plain`, `knowns doc "README" --plain`) and continue.

## Quick Tools

```
// Get guidelines (call this first!)
mcp__knowns__get_guideline({})

// List tasks
mcp__knowns__list_tasks({})

// List docs
mcp__knowns__list_docs({})
```

**Important:** Always read the guidelines before working on tasks.
<!-- KNOWNS GUIDELINES END -->
