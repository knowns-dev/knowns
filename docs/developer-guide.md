# Knowns Developer Guide

Technical documentation for contributors and developers building on Knowns.

---

## Architecture Overview

Knowns follows a layered architecture with CLI as the primary interface.

### Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun / Node.js |
| Language | TypeScript 5.7 |
| CLI | Commander.js |
| Server | Express 5 + WebSocket (ws) |
| Web UI | React 19 + Vite + TailwindCSS 4 |
| UI Components | Radix UI (shadcn/ui) |
| Storage | File-based (Markdown + YAML Frontmatter) |
| AI Integration | Model Context Protocol (MCP) |
| Testing | Vitest (unit) |
| Linting | Biome |

### Module Structure

```
src/
├── index.ts                    # CLI entry point
├── commands/                   # CLI Command Pattern
│   ├── task.ts                # Task CRUD
│   ├── doc.ts                 # Document management
│   ├── time.ts                # Time tracking
│   ├── search.ts              # Full-text search
│   ├── browser.ts             # Web UI launcher
│   ├── agents.ts              # AI guidelines management
│   └── ...
├── templates/                  # AI Agent Guidelines
│   ├── cli/
│   │   ├── general.md         # Full CLI guidelines (~15KB)
│   │   └── gemini.md          # Compact CLI (~3KB)
│   └── mcp/
│       ├── general.md         # Full MCP guidelines (~12KB)
│       └── gemini.md          # Compact MCP (~2.5KB)
├── models/                     # Domain Models
│   ├── task.ts                # Task interface + helpers
│   ├── project.ts             # Project configuration
│   └── version.ts             # Version history
├── storage/                    # Persistence Layer
│   ├── file-store.ts          # Main storage class
│   ├── markdown.ts            # Parsing + serialization
│   └── version-store.ts       # Version history
├── server/                     # Web Server & API
│   └── index.ts               # Express + WebSocket
├── mcp/                        # Model Context Protocol
│   └── server.ts              # Claude integration
├── ui/                         # React Web UI
│   ├── App.tsx
│   ├── components/
│   │   ├── atoms/             # Basic components
│   │   ├── molecules/         # Composite components
│   │   ├── organisms/         # Complex components
│   │   ├── templates/         # Page layouts
│   │   └── ui/                # shadcn/ui primitives
│   ├── pages/
│   ├── contexts/
│   └── api/
└── utils/                      # Shared Utilities
```

---

## Domain Model

### Task Model

```typescript
interface Task {
  id: string;              // Unique identifier (e.g., "42")
  title: string;           // Task title
  description?: string;    // Markdown description
  status: TaskStatus;      // todo | in-progress | in-review | blocked | done
  priority: Priority;      // low | medium | high
  labels: string[];        // Tags/categories
  assignee?: string;       // @username or @me
  parent?: string;         // Parent task ID
  acceptanceCriteria: AcceptanceCriterion[];
  implementationPlan?: string;   // Markdown plan
  implementationNotes?: string;  // Markdown notes
  createdAt: string;       // ISO timestamp
  updatedAt: string;       // ISO timestamp
}

interface AcceptanceCriterion {
  text: string;
  checked: boolean;
}
```

### Document Model

```typescript
interface Doc {
  filename: string;        // File name without extension
  path: string;            // Full path from docs root
  title: string;           // Display title
  description?: string;    // Short description
  tags: string[];          // Tags for filtering
  content: string;         // Markdown content
  createdAt: string;       // ISO timestamp
  updatedAt: string;       // ISO timestamp
}
```

### Project Configuration

```typescript
interface ProjectConfig {
  name: string;
  prefix?: string;         // Task ID prefix
  labels?: string[];       // Predefined labels
  users?: User[];          // Team members
  timeTracking?: TimeTrackingConfig;
}
```

---

## Storage System

### File Structure

```
.knowns/
├── config.json           # Project configuration
├── tasks/
│   ├── task-1 - Title.md
│   ├── task-2 - Another.md
│   └── .versions/        # Version history
│       ├── task-1/
│       │   ├── v1.json
│       │   └── v2.json
│       └── task-2/
│           └── v1.json
└── docs/
    ├── README.md
    ├── guides/
    │   └── getting-started.md
    └── patterns/
        └── architecture.md
```

### Markdown + Frontmatter Format

```markdown
---
id: "42"
title: Task Title
status: in-progress
priority: high
labels: [feature, auth]
assignee: "@harry"
createdAt: 2025-12-25T10:00:00.000Z
updatedAt: 2025-12-29T15:30:00.000Z
---

## Description

Task description in Markdown.

## Acceptance Criteria

- [x] First criterion (checked)
- [ ] Second criterion (unchecked)

## Implementation Plan

1. Step one
2. Step two

## Implementation Notes

Notes added after completion.
```

### FileStore API

```typescript
class FileStore {
  // Tasks
  async createTask(data: CreateTaskInput): Promise<Task>
  async getTask(id: string): Promise<Task | null>
  async getTasks(filters?: TaskFilters): Promise<Task[]>
  async updateTask(id: string, updates: TaskUpdates): Promise<Task>
  async deleteTask(id: string): Promise<void>

  // Documents
  async createDoc(data: CreateDocInput): Promise<Doc>
  async getDoc(path: string): Promise<Doc | null>
  async getDocs(filters?: DocFilters): Promise<Doc[]>
  async updateDoc(path: string, updates: DocUpdates): Promise<Doc>

  // Search
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]>
}
```

---

## WebSocket Protocol

### Connection

```
ws://localhost:6420/ws
```

### Message Types

#### Server -> Client

```typescript
// Task updated
{
  type: "tasks:updated",
  task: Task
}

// Full refresh needed
{
  type: "tasks:refresh"
}

// Timer update
{
  type: "timer:update",
  timer: TimerState
}
```

### Connection Flow

1. Client connects to WebSocket
2. Server sends initial state (optional)
3. On any data change, server broadcasts to all clients
4. Client updates local state

### CLI Integration

When CLI modifies data, it notifies the server:

```typescript
// src/utils/notify-server.ts
export async function notifyServer(type: string, data?: any) {
  try {
    await fetch('http://localhost:6420/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, data })
    });
  } catch {
    // Server not running, ignore
  }
}
```

---

## MCP Server Implementation

### Protocol

JSON-RPC 2.0 over stdio.

### Available Tools

```typescript
const tools = [
  {
    name: "get_task",
    description: "Get task details by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID" }
      },
      required: ["id"]
    }
  },
  {
    name: "list_tasks",
    description: "List tasks with optional filters",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        assignee: { type: "string" },
        priority: { type: "string" }
      }
    }
  },
  {
    name: "create_task",
    description: "Create a new task",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string" },
        labels: { type: "array", items: { type: "string" } }
      },
      required: ["title"]
    }
  }
  // ... more tools
];
```

### Adding a New Tool

1. Define Zod schema in `src/mcp/server.ts`
2. Register in `ListToolsRequestSchema` handler
3. Add handler case in `CallToolRequestSchema`

```typescript
// Example: Adding a new tool
{
  name: "my_new_tool",
  description: "Does something useful",
  inputSchema: zodToJsonSchema(MyToolInputSchema)
}

// Handler
case "my_new_tool": {
  const input = MyToolInputSchema.parse(request.params.arguments);
  const result = await doSomething(input);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
```

---

## Template System

AI agent guidelines are embedded at build time using esbuild's text loader.

### Template Matrix

| Type | Variant | Size | Use Case |
|------|---------|------|----------|
| cli | general | ~15KB | Claude, GPT-4, large context models |
| cli | gemini | ~3KB | Gemini 2.5 Flash, small context |
| mcp | general | ~12KB | Claude Desktop, full MCP reference |
| mcp | gemini | ~2.5KB | Gemini with MCP tools |

### How It Works

```typescript
// src/commands/agents.ts
import CLI_GENERAL from "../templates/cli/general.md";
import CLI_GEMINI from "../templates/cli/gemini.md";
import MCP_GENERAL from "../templates/mcp/general.md";
import MCP_GEMINI from "../templates/mcp/gemini.md";

export function getGuidelines(type: GuidelinesType, variant: GuidelinesVariant = "general"): string {
  if (type === "mcp") {
    return variant === "gemini" ? MCP_GEMINI : MCP_GENERAL;
  }
  return variant === "gemini" ? CLI_GEMINI : CLI_GENERAL;
}
```

### Adding a New Template Variant

1. Create template file in `src/templates/<type>/<variant>.md`
2. Import in `src/commands/agents.ts`
3. Update `getGuidelines()` function
4. Add CLI option if needed (e.g., `--<variant>`)

### Commander.js Option Inheritance

When parent command has options that should pass to subcommands:

```typescript
const parentCommand = new Command("parent")
  .enablePositionalOptions()
  .passThroughOptions()
  .option("--flag", "Description")
```

Also ensure `.enablePositionalOptions()` is on root program in `src/index.ts`.

---

## Contributing Guidelines

### Development Setup

```bash
# Clone repository
git clone https://github.com/knowns-dev/knowns.git
cd knowns

# Install dependencies
npm install

# Start development server
npm run dev
```

### Code Style

- **Formatter**: Biome
- **Run lint**: `npm run lint`
- **Auto-fix**: `npm run lint:fix`

### Testing

```bash
# Unit tests
npm test

# Unit tests with coverage
npm test -- --coverage
```

### Git Workflow

1. Create feature branch from `develop`
2. Make changes with clear commits
3. Run tests and lint
4. Create PR to `develop`

### Commit Message Format

```
<type>: <description>

[optional body]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `refactor`: Code refactoring
- `test`: Adding tests
- `chore`: Maintenance

### Adding a New Command

1. Create file in `src/commands/`
2. Export from `src/commands/index.ts`
3. Register in `src/index.ts`

Example:

```typescript
// src/commands/my-command.ts
import { Command } from "commander";

export function registerMyCommand(program: Command) {
  program
    .command("my-command")
    .description("Does something")
    .option("-o, --option <value>", "An option")
    .action(async (options) => {
      // Implementation
    });
}
```

### Adding UI Components

Follow Atomic Design:
- **Atoms**: Basic elements (Button, Input)
- **Molecules**: Combinations (SearchBox, FormField)
- **Organisms**: Complex (TaskCard, Board)
- **Templates**: Page layouts

Use shadcn/ui primitives from `src/ui/components/ui/`.

### Pull Request Checklist

- [ ] Tests pass (`npm test`)
- [ ] Lint passes (`npm run lint`)
- [ ] Build works (`npm run build`)
- [ ] Documentation updated if needed
- [ ] Commit messages follow convention
