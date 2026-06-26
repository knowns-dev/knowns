# Knowns Documentation

Knowns is a project context layer for software teams and AI agents. It gives a repository one shared place for tasks, docs, memory, templates, semantic search, and AI integrations.

Use these docs if you want to:

- set up Knowns in an existing repository
- keep project work, decisions, and docs readable by both humans and AI
- connect assistants through MCP, skills, or lightweight shim files
- use the Web UI for boards, docs, graph views, and chat workflows

## Core ideas

- **Task**: planned work with status, acceptance criteria, notes, and links to context.
- **Doc**: durable project knowledge such as architecture, specs, decisions, or onboarding material.
- **Memory**: short reusable context that should be recalled later, such as conventions or preferences.
- **Template**: reusable project scaffolding for repeated code or document patterns.
- **Search / retrieval**: local context lookup that connects tasks, docs, memory, and code references.
- **MCP and skills**: AI integration surfaces. MCP exposes structured tools; skills are agent-side workflow commands such as `/kn-*` in Claude or `$kn-*` in Codex.

## Recommended reading order

1. [Installation](./getting-started/installation.md)
2. [Quick start](./getting-started/quick-start.md)
3. [First project](./getting-started/first-project.md)
4. [Why Knowns exists](./guides/why-knowns.md)
5. [User guide](./guides/user-guide.md)
6. [Task Management](./guides/task-management.md)
7. [AI Agent Guide](./guides/ai-agent-guide.md)
8. [AI Workflow](./guides/ai-workflow.md)

## Which page should I read first?

- New user: start with [Installation](./getting-started/installation.md), then [Quick start](./getting-started/quick-start.md).
- Existing project owner: read [First project](./getting-started/first-project.md), then [Workflow](./guides/workflow.md).
- AI assistant user: read [AI Workflow](./guides/ai-workflow.md), [MCP integration](./guides/mcp-integration.md), and [Skills](./integrations/skills.md).
- CLI reference lookup: go directly to [Commands](./reference/commands.md).

## Structure

- `getting-started/`
  - installation and first-run docs
- `guides/`
  - practical usage guides
- `reference/`
  - command and config reference
- `integrations/`
  - platform, MCP, skills, templates, sync, and compatibility
- `contributing/`
  - contributor-oriented notes

## Index

### Getting started

- [Installation](./getting-started/installation.md)
- [Quick start](./getting-started/quick-start.md)
- [First project](./getting-started/first-project.md)

### Guides

- [Why Knowns exists](./guides/why-knowns.md)
- [User guide](./guides/user-guide.md)
- [Task Management](./guides/task-management.md)
- [AI Agent Guide](./guides/ai-agent-guide.md)
- [AI Workflow](./guides/ai-workflow.md)
- [Memory System](./guides/memory-system.md)
- [Workflow](./guides/workflow.md)
- [Web UI](./guides/web-ui.md)
- [MCP integration](./guides/mcp-integration.md)

### Reference

- [Commands](./reference/commands.md)
- [Configuration](./reference/configuration.md)
- [Sync](./reference/sync.md)
- [Validate](./reference/validate.md)
- [Model Management](./reference/model-management.md)
- [Reference system](./reference/reference-system.md)
- [Semantic search](./reference/semantic-search.md)

### Integrations

- [Platforms](./integrations/platforms.md)
- [Skills](./integrations/skills.md)
- [Templates](./integrations/templates.md)
- [Auto sync](./integrations/auto-sync.md)
- [Compatibility](./integrations/compatibility.md)
- [Guidance files](./integrations/guidance-files.md)

### Contributing

- [Developer guide](./contributing/developer-guide.md)
