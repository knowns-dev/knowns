# Context Optimization

Optimize your context usage to work more efficiently within token limits.

---

{{#if cli}}
## Output Format

```bash
# Verbose output
knowns task 42 --json

# Compact output (always use --plain)
knowns task 42 --plain
```

---
{{/if}}

## Search Before Read

{{#if cli}}
### CLI
```bash
# DON'T: Read all docs hoping to find info
knowns doc "doc1" --plain
knowns doc "doc2" --plain

# DO: Search first, then read only relevant docs
knowns search "authentication" --type doc --plain
knowns doc "security-patterns" --plain
```
{{/if}}
{{#if mcp}}
### MCP
```json
// DON'T: Read all docs hoping to find info
mcp__knowns__get_doc({ "path": "doc1" })
mcp__knowns__get_doc({ "path": "doc2" })

// DO: Search first, then read only relevant docs
mcp__knowns__search_docs({ "query": "authentication" })
mcp__knowns__get_doc({ "path": "security-patterns" })
```
{{/if}}

---

{{#if mcp}}
## Use Filters

```json
// DON'T: List all then filter manually
mcp__knowns__list_tasks({})

// DO: Use filters in the query
mcp__knowns__list_tasks({
  "status": "in-progress",
  "assignee": "@me"
})
```

---
{{/if}}

## Reading Documents

{{#if cli}}
### CLI
**ALWAYS use `--smart`** - auto-handles both small and large docs:

```bash
# DON'T: Read without --smart
knowns doc readme --plain

# DO: Always use --smart
knowns doc readme --plain --smart
# Small doc → full content
# Large doc → stats + TOC

# If large, read specific section:
knowns doc readme --plain --section 3
```
{{/if}}
{{#if mcp}}
### MCP
**ALWAYS use `smart: true`** - auto-handles both small and large docs:

```json
// DON'T: Read without smart
mcp__knowns__get_doc({ "path": "readme" })

// DO: Always use smart
mcp__knowns__get_doc({ "path": "readme", "smart": true })
// Small doc → full content
// Large doc → stats + TOC

// If large, read specific section:
mcp__knowns__get_doc({ "path": "readme", "section": "3" })
```
{{/if}}

**Behavior:**
- **≤2000 tokens**: Returns full content automatically
- **>2000 tokens**: Returns stats + TOC, then use section parameter

---

## Compact Notes

```bash
# DON'T: Verbose notes
knowns task edit 42 --append-notes "I have successfully completed the implementation..."

# DO: Compact notes
knowns task edit 42 --append-notes "Done: Auth middleware + JWT validation"
```

---

## Avoid Redundant Operations

| Don't | Do Instead |
|-------|------------|
| Re-read files already in context | Reference from memory |
| List tasks/docs multiple times | List once, remember results |
| Quote entire file contents | Summarize key points |

---

## Efficient Workflow

| Phase | Context-Efficient Approach |
|-------|---------------------------|
| **Research** | Search → Read only matches |
| **Planning** | Brief plan, not detailed prose |
| **Coding** | Read only files being modified |
| **Notes** | Bullet points, not paragraphs |
| **Completion** | Summary, not full log |

---

## Quick Rules

{{#if cli}}
1. **Always `--plain`** - Never use `--json` unless needed
2. **Always `--smart`** - Auto-handles doc size
{{/if}}
{{#if mcp}}
1. **Always `smart: true`** - Auto-handles doc size
{{/if}}
3. **Search first** - Don't read all docs hoping to find info
4. **Read selectively** - Only fetch what you need
5. **Write concise** - Compact notes, not essays
6. **Don't repeat** - Reference context already loaded
