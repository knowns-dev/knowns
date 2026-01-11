# Knowns Project

This project uses **Knowns MCP** tools for task and documentation management.

## Before Starting

Call this MCP tool to get usage guidelines:

```
mcp__knowns__get_guideline({})
```

You MUST call this at session start and follow every rule it returns.

## Context-Specific Guidelines

Get guidelines for specific contexts:

```
// Full guidelines
mcp__knowns__get_guideline({ type: "unified" })

// CLI-specific (fallback)
mcp__knowns__get_guideline({ type: "cli" })

// MCP-specific
mcp__knowns__get_guideline({ type: "mcp" })
```

**CLI Fallback:** If MCP tools are unavailable, use CLI commands:

```bash
knowns agents guideline --full      # All guidelines
knowns agents guideline --stage creation    # Task creation
knowns agents guideline --stage execution   # Task execution
knowns agents guideline --stage completion  # Task completion
```

## Quick Tools

```
// List tasks
mcp__knowns__list_tasks({})

// View task
mcp__knowns__get_task({ taskId: "<id>" })

// List docs
mcp__knowns__list_docs({})

// View doc
mcp__knowns__get_doc({ path: "<path>" })

// Search
mcp__knowns__search_tasks({ query: "keyword" })
mcp__knowns__search_docs({ query: "keyword" })
```

**Important:** Always read the guidelines before working on tasks.
