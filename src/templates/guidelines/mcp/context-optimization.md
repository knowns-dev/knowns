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

## Large Documents (info, toc, section)

For large documents, check size first with `info`:

```json
// DON'T: Read entire large document (may be truncated)
mcp__knowns__get_doc({ "path": "readme" })

// DO: Step 1 - Check document size first
mcp__knowns__get_doc({ "path": "readme", "info": true })
// Response: { stats: { estimatedTokens: 12132 }, recommendation: "..." }

// DO: Step 2 - Get table of contents (if >2000 tokens)
mcp__knowns__get_doc({ "path": "readme", "toc": true })

// DO: Step 3 - Read only the section you need
mcp__knowns__get_doc({ "path": "readme", "section": "3. Config" })
```

**Decision flow:** `info: true` → check tokens → if >2000, use `toc` then `section`

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

1. **Search first** - Don't read all docs hoping to find info
2. **Use filters** - Don't list everything then filter manually
3. **Read selectively** - Only fetch what you need
4. **Use info first** - Check doc size before reading, then toc/section if needed
5. **Write concise** - Compact notes, not essays
6. **Don't repeat** - Reference context already loaded
7. **Summarize** - Key points, not full quotes
