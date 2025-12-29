# Knowns MCP Server

Model Context Protocol (MCP) server for Knowns task management system, enabling AI agents like Claude to interact with your tasks and documentation.

## Features

The Knowns MCP server exposes the following capabilities:

### Task Management Tools

1. **create_task** - Create a new task
   - Required: `title`
   - Optional: `description`, `status`, `priority`, `assignee`, `labels`, `parent`

2. **get_task** - Retrieve a task by ID
   - Required: `taskId`

3. **update_task** - Update task fields
   - Required: `taskId`
   - Optional: `title`, `description`, `status`, `priority`, `assignee`, `labels`

4. **list_tasks** - List tasks with optional filters
   - Optional: `status`, `priority`, `assignee`, `label`

5. **search_tasks** - Search tasks by query
   - Required: `query`

### Time Tracking Tools

6. **start_time** - Start time tracking for a task
   - Required: `taskId`

7. **stop_time** - Stop active time tracking
   - Required: `taskId`

8. **add_time** - Manually add a time entry
   - Required: `taskId`, `duration` (e.g., "2h", "30m", "1h30m")
   - Optional: `note`, `date` (YYYY-MM-DD)

9. **get_time_report** - Generate time tracking report
   - Optional: `from` (YYYY-MM-DD), `to` (YYYY-MM-DD), `groupBy` (task/label/status)

### Board Management Tools

10. **get_board** - Get current board state with tasks grouped by status
    - No parameters required

### Documentation Tools

11. **list_docs** - List all documentation files
    - Optional: `tag` (filter by tag)

12. **get_doc** - Get a documentation file by path
    - Required: `path` (e.g., "readme", "guides/setup", "conventions/naming")

13. **create_doc** - Create a new documentation file
    - Required: `title`
    - Optional: `description`, `content`, `tags`, `folder`

14. **update_doc** - Update an existing documentation file
    - Required: `path`
    - Optional: `title`, `description`, `content`, `tags`, `appendContent`

15. **search_docs** - Search documentation by query
    - Required: `query`
    - Optional: `tag`

### Resources

The server also exposes all tasks and docs as resources accessible via URIs:

**Tasks:**
- Format: `knowns://task/{taskId}`
- MIME type: `application/json`

**Documentation:**
- Format: `knowns://doc/{docPath}`
- MIME type: `text/markdown`

## Installation & Setup

### Option 1: Using CLI Command (Recommended)

If you have knowns installed globally or locally:

```bash
# Show configuration instructions
knowns mcp --info

# Start MCP server
knowns mcp

# Start with verbose logging
knowns mcp --verbose
```

Configure Claude Desktop:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "knowns": {
      "command": "knowns",
      "args": ["mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Replace `/path/to/your/project` with your actual project path.

### Option 2: Using Built Server Directly

Build and run the standalone server:

```bash
bun run build
```

Configure Claude Desktop:

```json
{
  "mcpServers": {
    "knowns": {
      "command": "node",
      "args": ["/absolute/path/to/knowns/dist/mcp/server.js"]
    }
  }
}
```

### 3. Restart Claude Desktop

After updating the configuration, restart Claude Desktop for the changes to take effect.

## Usage Examples

Once configured, you can interact with Knowns through Claude Desktop:

### Create a Task

```
Create a task titled "Implement dark mode" with priority high and label "ui"
```

Claude will use the `create_task` tool to create the task in your Knowns system.

### Search Tasks

```
Search for all tasks related to authentication
```

Claude will use the `search_tasks` tool to find matching tasks.

### Update a Task

```
Update task 1 to status "in-progress" and assign it to @developer
```

Claude will use the `update_task` tool to modify the task.

### List Filtered Tasks

```
Show me all high priority tasks that are in-progress
```

Claude will use the `list_tasks` tool with appropriate filters.

### Time Tracking

```
Start tracking time for task 5
```

Claude will use the `start_time` tool to begin tracking.

```
Add 2 hours to task 3 with note "Backend development"
```

Claude will use the `add_time` tool to manually log time.

```
Show me time report for last week grouped by status
```

Claude will use the `get_time_report` tool with date filtering and grouping.

### Board View

```
Show me the current board state
```

Claude will use the `get_board` tool to display all tasks organized by status columns.

### Documentation

```
List all documentation files
```

Claude will use the `list_docs` tool to show available docs.

```
Get the README documentation
```

Claude will use the `get_doc` tool to retrieve the doc content.

```
Create a new doc titled "API Guidelines" with tag "api" in the guides folder
```

Claude will use the `create_doc` tool to create a new documentation file.

```
Search docs for "authentication"
```

Claude will use the `search_docs` tool to find relevant documentation.

## Architecture

The MCP server is organized into modular handlers:

```
src/mcp/
├── server.ts         # Main server entry point
├── utils.ts          # Shared utilities
├── handlers/
│   ├── index.ts      # Handler exports
│   ├── task.ts       # Task management handlers
│   ├── time.ts       # Time tracking handlers
│   ├── board.ts      # Board management handlers
│   └── doc.ts        # Documentation handlers
└── README.md
```

## Real-time Updates

The MCP server integrates with the Knowns web UI for real-time updates. When tasks or docs are modified via MCP:

1. Changes are persisted to `.knowns/` directory
2. Notifications are sent to the web server (if running)
3. Web UI updates automatically

The server reads the port from `.knowns/config.json` (default: 6420).

## Development

### Running the Server

```bash
# Using CLI command
knowns mcp --verbose

# Using npm script
bun run mcp

# Using tsx directly
npx tsx src/mcp/server.ts
```

This starts the server in stdio mode, ready to accept JSON-RPC messages.

### Testing

The MCP server uses the same FileStore as the CLI, so all task operations are immediately reflected in your `.knowns` directory.

## Protocol Details

The server implements the [Model Context Protocol specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25) and uses:

- **Transport:** stdio (standard input/output)
- **Protocol:** JSON-RPC 2.0
- **Validation:** Zod schemas for all inputs

## Error Handling

All tool calls return a JSON response with:
- `success`: boolean indicating if the operation succeeded
- `error`: error message if `success` is false
- `task`/`tasks`/`doc`/`docs`: result data if `success` is true

Example error response:
```json
{
  "success": false,
  "error": "Task 999 not found"
}
```

Example success response:
```json
{
  "success": true,
  "task": {
    "id": "1",
    "title": "Implement dark mode",
    "status": "todo",
    "priority": "high"
  }
}
```

## Limitations

- The server currently runs from the current working directory (`process.cwd()`)
- Ensure Claude Desktop or your MCP client is started from your Knowns project directory
- Or modify the `FileStore` initialization in `server.ts` to use a specific path

## Troubleshooting

### Server not appearing in Claude Desktop

1. Check the configuration file path is correct
2. Ensure the absolute path to `server.js` is correct
3. Restart Claude Desktop
4. Check Claude Desktop logs for errors

### Tasks not found

Ensure the MCP server is running from the correct directory that contains your `.knowns` folder.

### Building issues

```bash
# Clean and rebuild
rm -rf dist/mcp
bun run build
```

## Resources

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Knowns CLI Documentation](../../README.md)
