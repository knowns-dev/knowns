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

## Compact Notes

```bash
# ❌ Verbose notes
knowns task edit 42 --append-notes "I have successfully completed the implementation of the authentication middleware which validates JWT tokens and handles refresh logic..."

# ✅ Compact notes
knowns task edit 42 --append-notes "✓ Auth middleware + JWT validation done"
```

---

## Avoid Redundant Operations

| Don't | Do Instead |
|-------|------------|
| Re-read files already in context | Reference from memory |
| List tasks/docs multiple times | List once, remember results |
| Quote entire file contents | Summarize key points |
| Repeat full error messages | Reference error briefly |

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

1. **Always `--plain`** - Never use `--json` unless specifically needed
2. **Search first** - Don't read all docs hoping to find info
3. **Read selectively** - Use offset/limit for large files
4. **Write concise** - Compact notes, not essays
5. **Don't repeat** - Reference context already loaded
6. **Summarize** - Key points, not full quotes
