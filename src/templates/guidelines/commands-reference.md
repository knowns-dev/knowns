# Commands Reference

## task create

```bash
knowns task create <title> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--description` | `-d` | Task description |
| `--ac` | | Acceptance criterion (repeatable) |
| `--labels` | `-l` | Comma-separated labels |
| `--assignee` | `-a` | Assign to user ⚠️ |
| `--priority` | | low/medium/high |
| `--status` | `-s` | Initial status |
| `--parent` | | Parent task ID (raw ID only!) |

**⚠️ `-a` = assignee, NOT acceptance criteria! Use `--ac` for AC.**

---

## task edit

```bash
knowns task edit <id> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--title` | `-t` | Change title |
| `--description` | `-d` | Change description |
| `--status` | `-s` | Change status |
| `--priority` | | Change priority |
| `--labels` | `-l` | Set labels |
| `--assignee` | `-a` | Assign user ⚠️ |
| `--parent` | | Move to parent |
| `--ac` | | Add acceptance criterion |
| `--check-ac` | | Mark AC done (1-indexed) |
| `--uncheck-ac` | | Unmark AC (1-indexed) |
| `--remove-ac` | | Delete AC (1-indexed) |
| `--plan` | | Set implementation plan |
| `--notes` | | Replace notes |
| `--append-notes` | | Add to notes |

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

| Flag | Short | Purpose |
|------|-------|---------|
| `--description` | `-d` | Description |
| `--tags` | `-t` | Comma-separated tags |
| `--folder` | `-f` | Folder path |

---

## doc edit

```bash
knowns doc edit <name> [options]
```

| Flag | Short | Purpose |
|------|-------|---------|
| `--title` | `-t` | Change title |
| `--description` | `-d` | Change description |
| `--tags` | | Set tags |
| `--content` | `-c` | Replace content |
| `--append` | `-a` | Append content ⚠️ |
| `--content-file` | | Content from file |
| `--append-file` | | Append from file |

**⚠️ In doc edit, `-a` = append content, NOT assignee!**

---

## doc view/list

```bash
knowns doc <path> --plain             # View single doc
knowns doc list --plain               # List all
knowns doc list --tag api --plain     # Filter by tag
```

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
