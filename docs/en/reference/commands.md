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
- lightweight project instruction shims such as `CLAUDE.md` and `AGENTS.md`
- semantic search
- embedding model

`knowns init` creates lightweight project shims, but leaves MCP configs, skills, and runtime hooks to `knowns setup`.

### `knowns setup`

Configures AI tool integrations for an initialized project.

```bash
knowns setup --global        # Interactive user-level platform selector
knowns setup claude --global # Claude user-level MCP/skills/hooks
knowns setup codex --global  # Codex user-level MCP/skills/hooks
knowns setup all --global    # All supported platforms at user scope
knowns setup agents          # Lightweight repo-local agent shims only
knowns setup                 # Interactive project-level platform selector
knowns setup claude          # Project-level Claude files
knowns setup codex           # Project-level Codex files
```

Use `--global` for normal personal assistant setup. It updates user-level MCP config, skills, and runtime hooks, so the integration follows you across repositories. Use project-level setup only when you intentionally want repo-local platform artifacts.

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

### `knowns settings`

Opens the interactive project settings center.

```bash
knowns settings
knowns settings --global
```

Use `knowns settings` for human-friendly project edits: project name, git tracking, AI platforms, search, code intelligence, Browser/Chat UI, and maintenance guidance. In Search settings, Local ONNX models are listed with downloaded/not downloaded status; selecting a missing model can download it before saving. Use `knowns settings --global` for defaults reused by future `knowns init` runs. Use `knowns config get/set/list/reset` when you need scriptable config access.

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

## Decisions

```bash
knowns decision create "Use Postgres for metadata"
knowns decision list --plain
knowns decision get <id> --plain
knowns decision link <id> --doc architecture/storage
knowns decision supersede <old-id> <new-id>
```

Use decisions for durable architectural choices that may later be superseded rather than edited in place.

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

### Code index inspection (CLI)

```bash
knowns code symbols --plain
knowns code search "AuthService" --plain
knowns code deps --plain
```

Use CLI code commands for inspecting indexed symbol/dependency data. Use the MCP `code` tool for structured navigation and edits.

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

## Project status and audit

```bash
knowns status
knowns audit recent
knowns audit stats
```

Use `status` for project readiness and `audit` to inspect recent MCP tool calls.

## Agent and guidance files

```bash
knowns setup
knowns sync --skills
knowns sync --instructions
```

Use `knowns setup` to generate AI integration files, or `knowns sync` to refresh them.

## Model management

```bash
knowns model add <model-name>
knowns model list
knowns model download multilingual-e5-small
knowns model set multilingual-e5-small
knowns model status
knowns model remove <id>
```

## Providers and runtime adapters

```bash
knowns provider list
knowns provider add --id openai --name "OpenAI" --api-base https://api.openai.com/v1 --api-key <key>
knowns provider test <id>
knowns provider remove <id>

knowns runtime status
knowns runtime install codex
knowns runtime ps
knowns runtime logs
knowns runtime stop
knowns runtime uninstall codex

knowns runtime-memory hook
knowns runtime-memory hook --json
```

Use providers for API-backed embedding providers. Use runtime commands to install and inspect runtime memory adapters and the shared runtime.

The default hook output is plain prompt context for runtime adapters. Each injected memory includes inline score/trust metadata, for example `score=0.92; trust=active`, so the assistant can weigh supplemental context.

Use `knowns runtime-memory hook --json` when a caller needs structured metadata instead of prompt text. JSON output includes retrieval item scores and capture trust metadata such as `capture.score`, `capture.threshold`, `capture.trusted`, and review `capture.matches` when review is required.

## Tunnels

```bash
knowns tunnel status
knowns tunnel stop
```

Use tunnel commands to inspect or stop Cloudflare Quick Tunnels created for local server sharing.

## Imports

```bash
knowns import add <name> <source>
knowns import sync
knowns import list
```

Use imports when you want to bring in docs or templates from git, local, or package sources.
