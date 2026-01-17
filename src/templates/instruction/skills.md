# Knowns Project

This project uses **Knowns** for task and documentation management with built-in Claude Code skills.

## Available Skills

Use `/knowns.<skill>` to invoke workflows:

| Skill | Description |
|-------|-------------|
| `/knowns.init` | Initialize session - read docs, understand context |
| `/knowns.task <id>` | Full task workflow - research, plan, implement |
| `/knowns.task.brainstorm` | Explore solutions before implementation |
| `/knowns.task.reopen` | Reopen completed task, add requirements |
| `/knowns.task.extract` | Extract patterns from task to docs |
| `/knowns.doc` | Work with documentation - view, create, update |
| `/knowns.commit` | Commit with proper format |
| `/knowns.research` | Research codebase before coding |

## Getting Started

```bash
# Start a new session
/knowns.init

# Work on a task
/knowns.task <task-id>

# Quick commands
knowns task list --plain
knowns doc list --plain
knowns search "query" --plain
```

## Key Principles

1. **Read docs first** - Understand before implementing
2. **Plan before coding** - Wait for approval
3. **Track time** - Always use timer
4. **Ask when blocked** - Don't guess
