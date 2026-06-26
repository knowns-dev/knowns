# Skills

Skills are reusable workflow instructions embedded in the Knowns binary and synced to platform-specific directories.

Skills are separate from MCP tools. MCP tools appear in clients as structured domain tools such as `tasks`, `docs`, `memory`, `search`, and `code`; skills are invoked through each agent's skill-command syntax.

## Current skill paths

- `.claude/skills` -> Claude Code
- `.agents/skills` -> OpenCode, Codex, Antigravity, Generic Agents
- `.kiro/skills` -> Kiro

## Setup

Skills are generated via `knowns setup <target> --global` for normal personal assistant setup, via `knowns setup <target>` for intentional repo-local setup, or re-synced with `knowns sync --skills`:

```bash
knowns setup claude --global    # Syncs Claude skills/config at user scope
knowns setup opencode --global  # Syncs OpenCode skills/config at user scope
knowns setup codex --global     # Syncs Codex skills/config at user scope
knowns setup kiro --global      # Syncs Kiro skills/config at user scope
knowns sync --skills   # Re-syncs all configured platforms
```

## Invocation syntax

| Platform | Example |
|---|---|
| Claude Code | `/kn-spec`, `/kn-flow`, `/kn-review` |
| Codex | `$kn-spec`, `$kn-flow`, `$kn-review` |

For SDD, the recommended approved-spec path is:

```text
Claude Code:
/kn-spec <feature-name>
/kn-flow @doc/<spec-path>

Codex:
$kn-spec <feature-name>
$kn-flow @doc/<spec-path>
$kn-flow @doc/<spec-path> --sequential # Opt out of Codex sub-agent delegation
```

`kn-go` still exists for the legacy no-review-gates pipeline. Use `kn-flow` for normal approved-spec execution.

## Research behavior

`kn-research` is MCP-first:

- use Knowns `search`/`retrieve` for project docs, tasks, memory, and decisions
- use Knowns `code` tools before raw file search for code structure, symbols, definitions, and references
- use specialized external MCP providers such as Context7/library docs, GitHub/source MCP, or official docs MCP when upstream facts matter
- use general web search only when specialized MCP providers are unavailable, insufficient, or explicitly requested

When the research scope is large and the runtime exposes sub-agent tools, `kn-research` may split independent tracks across sub-agents. External results should be treated as supporting evidence, not as a replacement for local docs, tasks, source files, or user instructions.

## Notes

- `.agents/skills` is the primary path for agent-compatible platforms
- `knowns init` no longer syncs skills — use `knowns setup <target> --global` after init for personal assistant setup
- `knowns sync --skills` is the entrypoint for regenerating skills after updates
