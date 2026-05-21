# KNOWNS

Canonical repository guidance for agents working in this project.

## Table of Contents

- [Source of Truth](#source-of-truth)
- [TL;DR](#tldr)
- [Repo Mental Model](#repo-mental-model)
- [How Agents Should Read This File](#how-agents-should-read-this-file)
- [Tool Selection](#tool-selection)
- [Memory Usage](#memory-usage)
- [Critical Rules](#critical-rules)
- [Git Safety](#git-safety)
- [Context Retrieval Strategy](#context-retrieval-strategy)
- [References](#references)
- [Common Mistakes](#common-mistakes)
- [Recommended File Roles](#recommended-file-roles)
- [Compatibility Pattern](#compatibility-pattern)
- [Maintenance Rules](#maintenance-rules)

## Source of Truth

- `KNOWNS.md` is the canonical repo-level guidance file.
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `OPENCODE.md`, and `.github/copilot-instructions.md` are compatibility shims for runtimes that auto-detect those filenames.
- If guidance appears in multiple places, follow this precedence order:
  1. System instructions
  2. Developer instructions
  3. `KNOWNS.md`
  4. Compatibility shim files
  5. Other repository docs
- If a shim file and `KNOWNS.md` differ, treat `KNOWNS.md` as correct.

## TL;DR

- Read `KNOWNS.md` first.
- Call `initial` at session start — it returns project readiness, knowledge counts, code intelligence rules, workflow guidance, and available tools.
- Use Knowns as the memory layer for humans and the AI-friendly working layer for agents.
- Search before reading; read only the sections and docs relevant to the current task.
- Never manually edit Knowns-managed task or doc markdown.
- Prefer Knowns MCP tools; use the `knowns` CLI only as fallback.
- Let skills handle detailed workflows; use this file for rules, conventions, and context routing.
- Validate before marking work complete.
- Do not revert user changes you did not make.

## Repo Mental Model

- Knowns is the project's memory layer for humans and the AI-friendly operating layer for agents.
- Knowns manages tasks, docs, templates, specs, references, and workflow state in one place.
- Tasks and docs may reference each other using `@task-<id>`, `@doc/<path>`, and `@template/<name>`.
- `KNOWNS.md` defines repo-level operating rules; skills define step-by-step execution flows.
- Long guidance should be retrieved by section, not blindly injected in full on every request.

## How Agents Should Read This File

- Always read `## Source of Truth` and `## TL;DR` first.
- For short or obvious tasks, use the summary sections plus the relevant section only.
- For tool usage questions, read `## Tool Selection` and `## Common Mistakes`.
- For safety-sensitive work, read `## Critical Rules` and `## Git Safety`.
- For large files or docs, read `## Context Retrieval Strategy`.
- For ambiguous requests, search the repo and related docs before asking the user.
- Do not assume the entire file is present in context; retrieve the needed sections when required.

## Tool Selection

- Call `initial` at session start — it includes project readiness, capabilities, and code intelligence rules.
- Use `help("tool.action")` or `help("tool.*")` for detailed per-action documentation on demand.
- Use Knowns MCP tools first for tasks, docs, templates, validation, and time tracking.
- Use Knowns `code` tools for code discovery, structure, and editing — not built-in Read/Grep/Edit.
- Use shell commands for git, tests, builds, generators, and other terminal operations.
- Prefer targeted retrieval over loading large files in full.
- Use `knowns search` for discovery and quick relevance checks.
- Use MCP `retrieve` tool when a workflow needs structured context with citations and context-pack assembly. Fall back to CLI `knowns retrieve` if MCP is unavailable.
- Prefer `--json` for structured CLI reads consumed by agents, scripts, or workflows, including `get`, `list`, `search`, and `retrieve` commands.
- Prefer `--plain` for human-facing inspection, quick content reads, and logs when JSON is unnecessary.
- Do not rely on styled default CLI output for automation or parsing.

### Preferred Tool Matrix

- `knowns_*`: canonical operations on tasks, docs, templates, validation, and time.
- `read`: inspect a known file.
- `glob`: find files by path pattern.
- `grep`: locate content by regex.
- `bash`: run git, builds, tests, package managers, or other terminal commands.
- `apply_patch`: make small, explicit file edits.
- `task`: delegate large research or multi-step exploration when useful.

## Memory Usage

- Session start: `memory({ action: "list", layer: "project" })` to load accumulated project knowledge.
- After task: `memory({ action: "add" })` for reusable patterns, decisions, and conventions (alongside docs).
- Cross-project: `memory({ action: "promote" })` to move project knowledge to global (`project→global`).
- Memory complements docs: memory is for fast agent recall, docs are for structured human-readable reference.
- Never duplicate the full doc content into memory — store a summary and reference the doc with `@doc/<path>`.
- During any skill: if you discover a reusable pattern, decision, convention, or failure, save it with `memory({ action: "add", layer: "project" })`. Capture knowledge as it emerges, don't wait for extraction.
- Proactively save durable memory without waiting for the user to say "save this" when confidence is high.
- Use `project` for repo-specific rules, architecture decisions, conventions, recurring failure patterns, and implementation constraints.
- Use `global` for stable user preferences or workflow rules that should carry across repositories and future sessions.
- Ask the user only when the information appears durable but the correct scope (`working`, `project`, or `global`) is genuinely ambiguous.
- After any meaningful user instruction, correction, or newly discovered pattern, quickly evaluate whether it should be stored as memory and save it when appropriate.
- If the user states a stable collaboration preference, default to saving it as `global` memory unless they clearly scoped it to this repository only.

## Critical Rules

- Never manually edit Knowns-managed task or doc markdown.
- Search first, then read only relevant docs and code.
- Follow `@task-<id>`, `@doc/<path>`, and `@template/<name>` references before acting.
- Use `appendNotes` for progress updates; `notes` replaces existing notes and should only be used intentionally.
- Validate before marking work complete.
- Use skills for detailed workflow execution instead of duplicating step-by-step process here.
- Compatibility shim files must stay lightweight and must direct agents back to `KNOWNS.md` for behavioral rules instead of restating divergent guidance.

## Git Safety

- Assume the worktree may already contain user changes.
- Never revert or overwrite unrelated user changes unless explicitly requested.
- Avoid destructive git commands unless explicitly requested.
- Do not amend commits unless explicitly requested.
- Do not create commits unless the user explicitly asks for a commit.
- Do not push unless the user explicitly asks for it.

## Context Retrieval Strategy

- Treat `KNOWNS.md` as an indexed manual, not a prompt to fully inject every time.
- Read in this order when context is limited:
  1. `## Source of Truth`
  2. `## TL;DR`
  3. The section most relevant to the task
- For large or complex tasks, retrieve additional sections on demand.
- Prefer section headings with stable names so tools can target them precisely.
- If a downstream runtime supports startup loading, preload only the top-level summary and fetch deeper sections lazily.

## References

- Task references use `@task-<id>`.
- Doc references use `@doc/<path>`.
- Template references use `@template/<name>`.
- Doc references support line and range suffixes:
  - `@doc/<path>:42` — link to a specific line.
  - `@doc/<path>:10-25` — link to a line range.
  - `@doc/<path>#heading-slug` — link to a heading anchor.
- Follow references recursively before planning, implementation, or validation work.

## Common Mistakes

### Notes vs Append Notes

- Use `appendNotes` for progress updates and audit trail entries.
- Use `notes` only when intentionally replacing the task's notes content.

### CLI Pitfalls

- In `task create` and `task edit`, `-a` means `--assignee`, not acceptance criteria.
- In `doc edit`, `-a` means `--append`.
- Use raw task IDs where a command expects an ID value rather than a mention.
- Use `--plain` for read, list, and search commands, not for create or edit commands.
- Use `--json` for structured reads like `get`, `list`, `search`, and `retrieve` when the output will be parsed or fed into an agent workflow.
- Use `--plain` when inspecting manually or when only clean text output is needed.
- Use `--smart` when reading docs through the CLI.

### Retrieval Pitfalls

- Do not read every doc hoping to find the answer; search first.
- Do not replace discovery-oriented `search` with `retrieve` by default; use `retrieve` only when you need assembled context, citations, or expansion metadata.
- Do not repeatedly list the same tasks or docs if the needed context is already loaded.
- Do not quote large file contents when a concise summary is enough.

## Recommended File Roles

- `KNOWNS.md`: canonical repo-level guide.
- Compatibility shim files: lightweight entrypoints that introduce Knowns and redirect runtimes to `KNOWNS.md`.
- Other docs: deeper domain, feature, or workflow references.

## Compatibility Pattern

- Keep shim files short.
- In every shim file, explicitly say that `KNOWNS.md` is canonical.
- Preserve the `<!-- KNOWNS GUIDELINES START -->` and `<!-- KNOWNS GUIDELINES END -->` markers in shim files so tooling can detect and sync them reliably.

## Maintenance Rules

- Update the Knowns generator when the repository's operational rules change.
- Keep top sections stable so automated loaders can depend on them.
- Prefer adding new sections over bloating the TL;DR.
- Keep workflow details in skills when possible; keep `KNOWNS.md` focused on rules, conventions, and routing.
