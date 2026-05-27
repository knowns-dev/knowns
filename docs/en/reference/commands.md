# Command Reference

Use `knowns <command> --help` for the exact syntax accepted by the current binary. This page is the practical reference for the main command groups and how they are typically used.

## Conventions

- Use `--plain` when an AI or script needs text output that is easy to parse.
- Use `--json` when you want structured output.
- Use `knowns sync` when you want generated files and platform artifacts to match the current config.

## Initialize and sync

### `knowns init`

Initializes Knowns in the current project.

```bash
knowns init
knowns init my-project --no-wizard
knowns init --force
```

What `init` configures:

- project name
- git tracking mode (with per-section toggles)
- semantic search
- embedding model

### `knowns setup`

Configures AI tool integrations for an initialized project.

```bash
knowns setup              # Interactive platform selector
knowns setup claude       # Claude Code: CLAUDE.md, .mcp.json, skills, hooks
knowns setup opencode     # OpenCode: OPENCODE.md, opencode.json, skills, hooks
knowns setup kiro         # Kiro: .kiro steering/settings, skills, hooks
knowns setup copilot      # GitHub Copilot: .github/copilot-instructions.md
knowns setup all          # All supported platforms
```

### `knowns sync`

Re-applies `.knowns/config.json` to the current machine.

```bash
knowns sync
knowns sync --skills
knowns sync --instructions
knowns sync --model
knowns sync --instructions --platform claude
knowns sync --instructions --platform cursor
```

Typical uses:

- after cloning a repo
- after updating Knowns
- after changing selected platforms
- after changing local generated artifacts manually and wanting to restore them

### `knowns update`

Updates the CLI and syncs project artifacts afterward.

```bash
knowns update
knowns update --check
```

## Tasks

### Create

```bash
knowns task create "Title" -d "Description"
knowns task create "Add auth" \
  --ac "User can login" \
  --ac "JWT token returned" \
  --priority high \
  -l auth
```

Common options:

- `-d, --description`
- `--ac`
- `-l, --label`
- `--priority`
- `-a, --assignee`
- `--parent`

### View and list

```bash
knowns task list --plain
knowns task list --status in-progress --assignee @me
knowns task <id> --plain
knowns task view <id> --plain
```

### Edit

```bash
knowns task edit <id> -s in-progress
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "Completed middleware"
knowns task edit <id> --plan $'1. Research\n2. Implement\n3. Test'
```

Common edit operations:

- change title/description
- update status/priority/assignee
- add, check, uncheck, or remove acceptance criteria
- replace or append implementation notes
- set an implementation plan

## Docs

### Create

```bash
knowns doc create "Architecture" -d "System overview" -f architecture
knowns doc create "Auth Pattern" -d "JWT auth pattern" -f patterns -t auth -t security
```

### View and list

```bash
knowns doc list --plain
knowns doc "architecture/auth" --plain
knowns doc "architecture/auth" --info --plain
knowns doc "architecture/auth" --toc --plain
knowns doc "architecture/auth" --section "2" --plain
```

### Edit

```bash
knowns doc edit "architecture/auth" -a "\n\n## Notes\n..."
knowns doc edit "architecture/auth" -c "# New content"
knowns doc edit "architecture/auth" --section "2" -c "## 2. Updated section"
```

## Search, retrieve, and resolve

### Search

```bash
knowns search "authentication" --plain
knowns search "jwt" --type doc --plain
knowns search "jwt" --keyword --plain
knowns search --status-check
knowns search --reindex
```

Modes:

- default: hybrid
- `--keyword`: keyword-only

### Retrieve

```bash
knowns retrieve "how auth works" --json
knowns retrieve "auth flow" --source-types doc,task --json
```

Use retrieve when you want a ranked context pack rather than a flat result list.

### Resolve

```bash
knowns resolve "@doc/specs/auth{implements}" --plain
knowns resolve "@doc/specs/auth{depends}" --direction inbound --depth 2 --plain
```

Use resolve to traverse structural relationships between docs, tasks, and other entities.

## Memory

```bash
knowns memory add "We use repository pattern" --category decision
knowns memory list --plain
knowns memory <id> --plain
knowns memory edit <id> --append "More detail"
```

Memory is useful for persistent project-level or global knowledge that AI should recall later.

## Templates

```bash
knowns template list
knowns template get <name>
knowns template run <name>
knowns template create <name>
```

Use templates for repeatable scaffolding and standardized output.

## Code intelligence

### LSP management

```bash
knowns lsp list                    # Show supported languages and their status
knowns lsp install <language>      # Download and install an LSP server
knowns lsp cleanup                 # Remove old LSP server versions
```

Knowns auto-detects project languages and checks for LSP binaries. If a binary is missing, `knowns lsp list` shows install guidance.

### Code operations (via MCP)

Code intelligence is LSP-based and accessed through the MCP `code` tool:

- `symbols` — list symbols in a file
- `find` — search symbols by name pattern with optional body/depth
- `definition` — go to definition
- `references` — find all references
- `implementations` — find implementations of interface
- `diagnostics` — get compile errors/warnings
- `rename` — rename symbol across workspace
- `replace` — regex/literal text replacement
- `replace_body` — replace entire symbol body
- `insert` — insert code before/after a symbol
- `delete` — safe delete with reference check

## Validation

```bash
knowns validate --plain
knowns validate --scope docs --plain
knowns validate --scope sdd --plain
knowns validate --strict --plain
```

Use validation before considering documentation or workflow changes complete.

## Time tracking

```bash
knowns time start <task-id>
knowns time stop
knowns time add <task-id> 1h30m -n "Pair programming"
knowns time report
```

## Browser UI

```bash
knowns browser
knowns browser --open
knowns browser --port 6421
```

## Agent and guidance files

```bash
knowns setup
knowns sync --skills
knowns sync --instructions
```

Use `knowns setup` to generate AI integration files, or `knowns sync` to refresh them.

## Model management

```bash
knowns model list
knowns model download multilingual-e5-small
knowns model set multilingual-e5-small
knowns model status
```

## Imports

```bash
knowns import add <name> <source>
knowns import sync
knowns import list
```

Use imports when you want to bring in docs or templates from git, local, or package sources.
