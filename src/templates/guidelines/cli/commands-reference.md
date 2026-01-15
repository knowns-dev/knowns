# Commands Reference

## task create

```bash
knowns task create <title> [options]
```

| Flag            | Short | Purpose                           |
| --------------- | ----- | --------------------------------- |
| `--description` | `-d`  | Task description                  |
| `--ac`          |       | Acceptance criterion (repeatable) |
| `--labels`      | `-l`  | Comma-separated labels            |
| `--assignee`    | `-a`  | Assign to user ⚠️                 |
| `--priority`    |       | low/medium/high                   |
| `--status`      | `-s`  | Initial status                    |
| `--parent`      |       | Parent task ID (raw ID only!)     |

**⚠️ `-a` = assignee, NOT acceptance criteria! Use `--ac` for AC.**

---

## task edit

```bash
knowns task edit <id> [options]
```

| Flag             | Short | Purpose                  |
| ---------------- | ----- | ------------------------ |
| `--title`        | `-t`  | Change title             |
| `--description`  | `-d`  | Change description       |
| `--status`       | `-s`  | Change status            |
| `--priority`     |       | Change priority          |
| `--labels`       | `-l`  | Set labels               |
| `--assignee`     | `-a`  | Assign user ⚠️           |
| `--parent`       |       | Move to parent           |
| `--ac`           |       | Add acceptance criterion |
| `--check-ac`     |       | Mark AC done (1-indexed) |
| `--uncheck-ac`   |       | Unmark AC (1-indexed)    |
| `--remove-ac`    |       | Delete AC (1-indexed)    |
| `--plan`         |       | Set implementation plan  |
| `--notes`        |       | Replace notes            |
| `--append-notes` |       | Add to notes             |

**⚠️ `-a` = assignee, NOT acceptance criteria! Use `--ac` for AC.**

---

## task view/list

```bash
knowns task <id> --plain              # View single task
knowns task list --plain              # List all
knowns task list --status in-progress --plain
knowns task list --assignee @me --plain
knowns task list --tree --plain       # Tree hierarchy
```

---

## doc create

```bash
knowns doc create <title> [options]
```

| Flag            | Short | Purpose              |
| --------------- | ----- | -------------------- |
| `--description` | `-d`  | Description          |
| `--tags`        | `-t`  | Comma-separated tags |
| `--folder`      | `-f`  | Folder path          |

### Document Structure Best Practice

When creating/editing docs, use clear heading structure for `--toc` and `--section` to work properly:

```markdown
# Main Title (H1 - only one)

## 1. Overview

Brief introduction...

## 2. Installation

Step-by-step guide...

## 3. Configuration

### 3.1 Basic Config

...

### 3.2 Advanced Config

...

## 4. API Reference

...
```

**Writing rules:**

- Use numbered headings (`## 1. Overview`) for easy `--section "1"` access
- Keep H1 for title only, use H2 for main sections
- Use H3 for subsections within H2
- Each section should be self-contained (readable without context)

**Reading workflow:**

```bash
# Step 1: Check size first
knowns doc <path> --info --plain
# → If <2000 tokens: read directly with --plain
# → If >2000 tokens: continue to step 2

# Step 2: Get table of contents
knowns doc <path> --toc --plain

# Step 3: Read specific section
knowns doc <path> --section "2" --plain
```

---

## doc edit

```bash
knowns doc edit <name> [options]
```

| Flag             | Short | Purpose                                   |
| ---------------- | ----- | ----------------------------------------- |
| `--title`        | `-t`  | Change title                              |
| `--description`  | `-d`  | Change description                        |
| `--tags`         |       | Set tags                                  |
| `--content`      | `-c`  | Replace content (or section if --section) |
| `--append`       | `-a`  | Append content ⚠️                         |
| `--section`      |       | Target section to replace (use with -c)   |
| `--content-file` |       | Content from file                         |
| `--append-file`  |       | Append from file                          |

**⚠️ In doc edit, `-a` = append content, NOT assignee!**

### Section Edit (Context-Efficient)

Replace only a specific section instead of entire document:

```bash
# Step 1: View TOC to find section
knowns doc readme --toc --plain

# Step 2: Edit only that section
knowns doc edit readme --section "2. Installation" -c "New content here..."
knowns doc edit readme --section "2" -c "New content..."  # By number works too
```

This reduces context usage significantly - no need to read/write entire document.

---

## doc view/list

```bash
knowns doc <path> --plain             # View single doc
knowns doc list --plain               # List all
knowns doc list --tag api --plain     # Filter by tag
```

### Large Documents (--info, --toc, --section)

For large documents, check size first with `--info`, then use `--toc` and `--section`:

```bash
# Step 1: Check document size and token count
knowns doc readme --info --plain
# Output: Size: 42,461 chars (~12,132 tokens) | Headings: 83
# Recommendation: Document is large. Use --toc first, then --section.

# Step 2: View table of contents
knowns doc readme --toc --plain

# Step 3: Read specific section by title or number
knowns doc readme --section "5. Sync" --plain
knowns doc readme --section "3" --plain
```

**Decision flow:**

- `--info` → Check size (~tokens) → If >2000 tokens, use --toc/--section
- `--toc` → Get heading list → Choose section to read
- `--section` → Read only what you need

---

## time

```bash
knowns time start <id>    # REQUIRED when taking task
knowns time stop          # REQUIRED when completing
knowns time pause
knowns time resume
knowns time status
knowns time add <id> <duration> -n "Note" -d "2025-01-01"
```

---

## search

```bash
knowns search "query" --plain
knowns search "auth" --type task --plain
knowns search "api" --type doc --plain
knowns search "bug" --type task --status in-progress --priority high --plain
```

---

## Multi-line Input (Bash/Zsh)

```bash
knowns task edit <id> --plan $'1. Step\n2. Step\n3. Step'
```
