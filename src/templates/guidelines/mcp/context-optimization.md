# Context Optimization (MCP)

Optimize your context usage to work more efficiently within token limits.

---

## Search Before Read

```json
// DON'T: Read all docs hoping to find info
mcp__knowns__get_doc({ "path": "doc1" })
mcp__knowns__get_doc({ "path": "doc2" })
mcp__knowns__get_doc({ "path": "doc3" })

// DO: Search first, then read only relevant docs
mcp__knowns__search_docs({ "query": "authentication" })
mcp__knowns__get_doc({ "path": "security-patterns" })  // Only the relevant one
```

---

## Use Filters

```json
// DON'T: List all tasks then filter manually
mcp__knowns__list_tasks({})

// DO: Use filters in the query
mcp__knowns__list_tasks({
  "status": "in-progress",
  "assignee": "@me"
})
```

---

## Reading Documents (smart)

**ALWAYS use `smart: true` when reading documents.** It automatically handles both small and large docs:

```json
// DON'T: Read without smart (may get truncated large doc)
mcp__knowns__get_doc({ "path": "readme" })

// DO: Always use smart
mcp__knowns__get_doc({ "path": "readme", "smart": true })
// Small doc → returns full content
// Large doc → returns stats + TOC

// DO: If doc is large, read specific section
mcp__knowns__get_doc({ "path": "readme", "section": "3" })
```

**`smart: true` behavior:**

- **≤2000 tokens**: Returns full content automatically
- **>2000 tokens**: Returns stats + TOC, then use `section` parameter

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

| Don't                                 | Do Instead                  |
| ------------------------------------- | --------------------------- |
| Re-read tasks/docs already in context | Reference from memory       |
| List tasks/docs multiple times        | List once, remember results |
| Fetch same task repeatedly            | Cache the result            |

---

## Efficient Workflow

| Phase          | Context-Efficient Approach     |
| -------------- | ------------------------------ |
| **Research**   | Search -> Read only matches    |
| **Planning**   | Brief plan, not detailed prose |
| **Coding**     | Read only files being modified |
| **Notes**      | Bullet points, not paragraphs  |
| **Completion** | Summary, not full log          |

---

## Quick Rules

1. **Always `smart: true`** - Use smart when reading docs (auto-handles size)
2. **Search first** - Don't read all docs hoping to find info
3. **Use filters** - Don't list everything then filter manually
4. **Read selectively** - Only fetch what you need
5. **Write concise** - Compact notes, not essays
6. **Don't repeat** - Reference context already loaded
7. **Summarize** - Key points, not full quotes
