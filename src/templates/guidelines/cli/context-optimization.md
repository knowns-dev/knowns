# Context Optimization

Optimize your context usage to work more efficiently within token limits.

---

## Output Format

```bash
# ❌ Verbose output
knowns task 42 --json

# ✅ Compact output (always use --plain)
knowns task 42 --plain
```

---

## Search Before Read

```bash
# ❌ Reading all docs to find info
knowns doc "doc1" --plain
knowns doc "doc2" --plain
knowns doc "doc3" --plain

# ✅ Search first, then read only relevant docs
knowns search "authentication" --type doc --plain
knowns doc "security-patterns" --plain  # Only the relevant one
```

---

## Selective File Reading

```bash
# ❌ Reading entire large file
Read file (2000+ lines)

# ✅ Read specific sections
Read file with offset=100 limit=50
```

---

## Large Documents (--info, --toc, --section)

For large documents, check size first with `--info`:

```bash
# ❌ Reading entire large document (may be truncated)
knowns doc readme --plain

# ✅ Step 1: Check document size first
knowns doc readme --info --plain
# Output: Size: 42,461 chars (~12,132 tokens) | Headings: 83

# ✅ Step 2: View table of contents (if >2000 tokens)
knowns doc readme --toc --plain

# ✅ Step 3: Read only the section you need
knowns doc readme --section "3. Config" --plain
```

**Decision flow:** `--info` → check tokens → if >2000, use `--toc` then `--section`

---

## Compact Notes

```bash
# ❌ Verbose notes
knowns task edit 42 --append-notes "I have successfully completed the implementation of the authentication middleware which validates JWT tokens and handles refresh logic..."

# ✅ Compact notes
knowns task edit 42 --append-notes "✓ Auth middleware + JWT validation done"
```

---

## Avoid Redundant Operations

| Don't                            | Do Instead                  |
| -------------------------------- | --------------------------- |
| Re-read files already in context | Reference from memory       |
| List tasks/docs multiple times   | List once, remember results |
| Quote entire file contents       | Summarize key points        |
| Repeat full error messages       | Reference error briefly     |

---

## Efficient Workflow

| Phase          | Context-Efficient Approach     |
| -------------- | ------------------------------ |
| **Research**   | Search → Read only matches     |
| **Planning**   | Brief plan, not detailed prose |
| **Coding**     | Read only files being modified |
| **Notes**      | Bullet points, not paragraphs  |
| **Completion** | Summary, not full log          |

---

## Quick Rules

1. **Always `--plain`** - Never use `--json` unless specifically needed
2. **Search first** - Don't read all docs hoping to find info
3. **Read selectively** - Use offset/limit for large files
4. **Use --info first** - Check doc size before reading, then --toc/--section if needed
5. **Write concise** - Compact notes, not essays
6. **Don't repeat** - Reference context already loaded
7. **Summarize** - Key points, not full quotes
