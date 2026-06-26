# Why Knowns Exists

Modern software work has two context problems.

First, project knowledge is scattered. The task lives in one place, architecture notes in another, decisions in chat, conventions in someone's memory, and implementation details in code. People can sometimes reconstruct that context, but AI assistants lose it quickly unless every session starts with a long explanation.

Second, AI workflows need more than raw chat. A useful assistant needs to know the current task, relevant docs, durable memory, accepted decisions, project rules, and how to verify work. Without that structure, the assistant can sound confident while working from incomplete or stale context.

Knowns exists to make project context explicit, local, and usable by both humans and AI agents.

## The Core Idea

Knowns is a repo-local context layer. It keeps task, doc, memory, template, search, MCP tools, and agent skills connected around the same project state.

That means:

- task defines what should change
- doc explains why the project works the way it does
- memory keeps short reusable context and conventions
- search / retrieval finds relevant context without pasting everything into chat
- MCP exposes structured tools to AI assistants
- skills define repeatable workflows such as spec, implementation, review, and verification

The goal is not to make AI "remember everything". The goal is to give people and AI a shared operating layer they can inspect, update, validate, and trust more carefully.

## Why Repo-Local?

Project context changes with the code. Keeping it near the repository makes it easier to:

- onboard a new person or assistant
- avoid repeating the same explanations in every chat
- keep implementation work tied to acceptance criteria
- preserve decisions and conventions after the conversation ends
- validate that generated project artifacts still match config

Knowns also supports user-level setup where that makes sense. For example, `knowns setup codex --global` installs user-level MCP config, skills, and runtime hooks so your assistant integration follows you across repositories.

## Why MCP `initial` and `help`?

Agent bootstrap should be easy to change without rewriting every repository file. Knowns puts runtime-critical guidance in MCP `initial` and on-demand `help`, while repo instruction files stay lightweight compatibility shims for tools that auto-detect filenames.

This keeps the startup path small:

1. the assistant calls MCP `initial`
2. it uses `help("tool.*")` or `help("workflow.*")` when it needs details
3. it reads only the task, doc, memory, or code context needed for the current work

## What Knowns Is Not

Knowns does not replace source code, tests, or human review.

Memory is supplemental context only. It should not override source-of-truth docs, tasks, source files, tests, or explicit user instructions. Knowns helps surface context and workflow state, but correctness still comes from reading the code, running verification, and reviewing changes.

## The Practical Outcome

With Knowns, a project can move from:

```text
"Here is a long chat history. Please infer what matters."
```

to:

```text
"Start with MCP initial, inspect the task and docs, retrieve relevant context, implement, review, and validate."
```

That is the reason Knowns exists: less repeated context, more inspectable workflow state, and safer collaboration between people and AI agents.
