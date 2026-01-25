---
title: Command Pattern
createdAt: '2025-12-29T07:01:51.223Z'
updatedAt: '2026-01-25T09:51:47.984Z'
description: Documentation for the Command Pattern used in CLI architecture
tags:
  - architecture
  - patterns
  - cli
---
## Overview

The Command Pattern is the primary pattern used to build Knowns CLI. Each command is an independent module that can be extended and tested separately.

## Structure

```text
src/commands/
├── index.ts           # Re-exports all commands
├── task.ts            # Task CRUD (46KB - most complex)
├── doc.ts             # Document management (14KB)
├── time.ts            # Time tracking (17KB)
├── search.ts          # Full-text search (8KB)
├── browser.ts         # Web UI launcher (2KB)
├── config.ts          # Configuration (8KB)
├── init.ts            # Project initialization (5KB)
├── board.ts           # Kanban board commands (6KB)
└── agents.ts          # AI agent coordination (4KB)
```

## Pattern Implementation

### 1. Command Definition

Each command is defined as a `Command` object from Commander.js:

```typescript
import { Command } from "commander";

const createCommand = new Command("create")
  .description("Create new task")
  .argument("<title>", "Task title")
  .option("-d, --description <text>", "Task description")
  .option("--ac <criterion>", "Acceptance criterion", collect, [])
  .option("-l, --labels <labels>", "Comma-separated labels")
  .option("--priority <priority>", "Task priority")
  .action(async (title, options) => {
    // Handler logic
    const store = new FileStore(projectRoot);
    const task = await store.createTask({
      title,
      description: options.description,
      labels: options.labels?.split(",") || [],
      priority: options.priority || "medium",
      acceptanceCriteria: options.ac.map(text => ({ text, completed: false })),
    });
    console.log(`Created task ${task.id}`);
  });
```

### 2. Subcommand Aggregation

Commands are grouped by domain:

```typescript
// task.ts
const taskCommand = new Command("task")
  .description("Manage tasks");

taskCommand.addCommand(createCommand);
taskCommand.addCommand(listCommand);
taskCommand.addCommand(viewCommand);
taskCommand.addCommand(editCommand);
taskCommand.addCommand(deleteCommand);

export { taskCommand };
```

### 3. Root Program Registration

All top-level commands are registered to the main program:

```typescript
// index.ts (entry point)
import { Command } from "commander";
import { taskCommand, docCommand, timeCommand, searchCommand } from "./commands";

const program = new Command()
  .name("knowns")
  .description("Knowledge layer for development teams")
  .version("1.0.0");

program.addCommand(taskCommand);
program.addCommand(docCommand);
program.addCommand(timeCommand);
program.addCommand(searchCommand);
program.addCommand(browserCommand);
program.addCommand(configCommand);
program.addCommand(initCommand);

program.parse(process.argv);
```

## Key Patterns

### Option Collection

To collect multiple values for the same option:

```typescript
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

.option("--ac <criterion>", "Add acceptance criterion", collect, [])
// Usage: --ac "First" --ac "Second" --ac "Third"
```

### Plain Output Mode

Support output for AI agents:

```typescript
.option("--plain", "Output in plain text (for AI)")
.action(async (id, options) => {
  const task = await store.getTask(id);

  if (options.plain) {
    // Plain text format for AI consumption
    console.log(`Task ${task.id} - ${task.title}`);
    console.log(`Status: ${task.status}`);
    console.log(`Priority: ${task.priority}`);
    // ...
  } else {
    // Rich formatted output with colors
    console.log(chalk.bold(`Task #${task.id}`));
    // ...
  }
});
```

### Error Handling

Consistent error handling pattern:

```typescript
.action(async (id, options) => {
  try {
    const task = await store.getTask(id);
    if (!task) {
      console.error(`Error: Task ${id} not found`);
      process.exit(1);
    }
    // ...
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
});
```

## Benefits

1. **Modularity**: Each command is a separate file, easy to maintain

2. **Extensibility**: Adding new commands only requires creating a file and registering

3. **Testability**: Test each command independently

4. **Discoverability**: Commander.js auto-generates help text

5. **Consistency**: Same pattern for all commands

## Adding New Commands

1. Create a new file in `src/commands/`:

```typescript
// src/commands/mycommand.ts
import { Command } from "commander";
import { FileStore } from "../storage";

const myCommand = new Command("mycommand")
  .description("Description of my command")
  .option("--option <value>", "Option description")
  .action(async (options) => {
    // Implementation
  });

export { myCommand };
```

2. Export from `src/commands/index.ts`:

```typescript
export { myCommand } from "./mycommand";
```

3. Register in `src/index.ts`:

```typescript
import { myCommand } from "./commands";
program.addCommand(myCommand);
```

## Related Docs

- @doc/architecture/patterns/mcp-server - MCP Server Pattern
- @doc/architecture/patterns/storage - File-Based Storage Pattern



---

## Template

Generate new commands using the template:

```bash
knowns template run knowns-command
```

**Template reference:** @template/knowns-command
