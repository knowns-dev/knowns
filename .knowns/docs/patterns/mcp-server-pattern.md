---
title: MCP Server Pattern
createdAt: '2025-12-29T07:02:33.684Z'
updatedAt: '2025-12-29T07:12:42.894Z'
description: Documentation for the Model Context Protocol (MCP) server pattern
tags:
  - architecture
  - patterns
  - mcp
  - ai
---
## Overview

MCP (Model Context Protocol) is a protocol that allows AI models to interact with tools via JSON-RPC. Knowns implements an MCP server so Claude can access tasks and documentation directly.

## Location

```
src/mcp/server.ts (24KB)
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Claude Desktop                      │
│                                                       │
│  "Work on task 42"                                   │
│         │                                            │
│         ▼                                            │
│  ┌────────────────┐                                  │
│  │ MCP Client     │                                  │
│  │ (built-in)     │                                  │
│  └───────┬────────┘                                  │
└──────────│───────────────────────────────────────────┘
           │ JSON-RPC over stdio
           │
┌──────────▼───────────────────────────────────────────┐
│              Knowns MCP Server                        │
│  ┌────────────────────────────────────────────────┐  │
│  │             Tool Definitions                    │  │
│  │  - create_task    - list_tasks                 │  │
│  │  - get_task       - update_task                │  │
│  │  - start_time     - stop_time                  │  │
│  │  - list_docs      - get_doc                    │  │
│  └────────────────────────────────────────────────┘  │
│                        │                              │
│  ┌────────────────────▼───────────────────────────┐  │
│  │             Tool Handlers                       │  │
│  │  async handleCreateTask(args) { ... }          │  │
│  │  async handleGetTask(args) { ... }             │  │
│  └────────────────────────────────────────────────┘  │
│                        │                              │
│  ┌────────────────────▼───────────────────────────┐  │
│  │             FileStore                           │  │
│  │  Read/Write .knowns/ files                     │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Key Components

### 1. Tool Definitions (Zod Schemas)

```typescript
import { z } from "zod";

const createTaskSchema = z.object({
  title: z.string().describe("Task title"),
  description: z.string().optional().describe("Task description"),
  status: z.enum(["todo", "in-progress", "in-review", "done"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  labels: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
});

const getTaskSchema = z.object({
  taskId: z.string().describe("Task ID to retrieve"),
});

const listTasksSchema = z.object({
  status: z.string().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
});
```

### 2. Tool Registration

```typescript
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_task",
        description: "Create a new task",
        inputSchema: zodToJsonSchema(createTaskSchema),
      },
      {
        name: "get_task",
        description: "Get task details by ID",
        inputSchema: zodToJsonSchema(getTaskSchema),
      },
      {
        name: "list_tasks",
        description: "List tasks with optional filters",
        inputSchema: zodToJsonSchema(listTasksSchema),
      },
      // ... more tools
    ],
  };
});
```

### 3. Tool Handlers

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "create_task": {
      const validated = createTaskSchema.parse(args);
      const task = await fileStore.createTask({
        title: validated.title,
        description: validated.description,
        status: validated.status || "todo",
        priority: validated.priority || "medium",
        labels: validated.labels || [],
        acceptanceCriteria: validated.acceptanceCriteria?.map(text => ({
          text,
          completed: false,
        })) || [],
      });
      return {
        content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
      };
    }

    case "get_task": {
      const validated = getTaskSchema.parse(args);
      const task = await fileStore.getTask(validated.taskId);
      if (!task) {
        throw new Error(`Task ${validated.taskId} not found`);
      }

      // Auto-fetch linked documentation
      const linkedDocs = await fetchLinkedDocs(task.description);

      return {
        content: [
          { type: "text", text: JSON.stringify(task, null, 2) },
          ...linkedDocs.map(doc => ({
            type: "text",
            text: `\n--- Linked Doc: ${doc.name} ---\n${doc.content}`,
          })),
        ],
      };
    }

    // ... more handlers
  }
});
```

### 4. Resource Providers

MCP also allows exposing resources (docs) for AI to read:

```typescript
// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const docs = await fileStore.getAllDocs();
  return {
    resources: docs.map(doc => ({
      uri: `knowns://docs/${doc.path}`,
      name: doc.title,
      description: doc.description,
      mimeType: "text/markdown",
    })),
  };
});

// Read a specific resource
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const path = uri.replace("knowns://docs/", "");
  const content = await fileStore.getDocContent(path);
  return {
    contents: [{ uri, mimeType: "text/markdown", text: content }],
  };
});
```

### 5. Stdio Transport

MCP server runs as a subprocess, communicating via stdin/stdout:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  { name: "knowns-mcp", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

// Register handlers...

const transport = new StdioServerTransport();
await server.connect(transport);
```

## Tools Exposed

| Tool | Description | Input |
|------|-------------|-------|
| `create_task` | Create new task | title, description?, status?, priority?, labels? |
| `get_task` | Get task by ID | taskId |
| `list_tasks` | List tasks with filters | status?, assignee?, labels? |
| `update_task` | Update task fields | taskId, fields to update |
| `search_tasks` | Search tasks by query | query, filters? |
| `start_time` | Start timer | taskId |
| `stop_time` | Stop current timer | - |
| `get_time_entries` | Get time entries | taskId?, dateRange? |
| `list_docs` | List all docs | folder? |
| `get_doc` | Get doc content | path |
| `create_doc` | Create new doc | title, content, tags? |
| `update_doc` | Update doc | path, content |

## Auto-Fetch Linked Docs

When Claude calls `get_task`, the server automatically fetches docs linked in the description:

```typescript
async function fetchLinkedDocs(description: string): Promise<DocContent[]> {
  const refs = extractDocReferences(description);
  // @doc/patterns/auth -> .knowns/docs/patterns/auth.md

  const docs = [];
  for (const ref of refs) {
    const content = await fileStore.getDocContent(ref.path);
    if (content) {
      docs.push({ name: ref.path, content });
    }
  }
  return docs;
}
```

## Configuration

In Claude Desktop config:

```json
{
  "mcpServers": {
    "knowns": {
      "command": "knowns",
      "args": ["mcp"],
      "cwd": "/path/to/project"
    }
  }
}
```

## Benefits

1. **AI-Native**: Claude directly interacts with project data
2. **Type-Safe**: Zod schemas validate inputs
3. **Auto-Context**: Automatically fetches linked docs
4. **Extensible**: Easy to add new tools
5. **Standard Protocol**: Compatible with any MCP client

## Adding New Tools

1. Define schema:

```typescript
const myToolSchema = z.object({
  param1: z.string(),
  param2: z.number().optional(),
});
```

2. Register tool:

```typescript
// In ListToolsRequestSchema handler
{
  name: "my_tool",
  description: "What this tool does",
  inputSchema: zodToJsonSchema(myToolSchema),
}
```

3. Add handler:

```typescript
case "my_tool": {
  const validated = myToolSchema.parse(args);
  // Implementation
  return { content: [{ type: "text", text: result }] };
}
```

## Related Docs

- @doc/patterns/command-pattern - CLI Command Pattern
- @doc/patterns/storage-pattern - File-Based Storage Pattern
