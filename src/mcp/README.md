# Knowns MCP Server

Model Context Protocol (MCP) server for Knowns task management system, enabling AI agents like Claude to interact with your tasks.

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

### Resources

The server also exposes all tasks as resources accessible via URIs:
- Format: `knowns://task/{taskId}`
- MIME type: `application/json`

## Installation & Setup

### 1. Build the MCP Server

```bash
bun run build
```

This will create the built server at `dist/mcp/server.js`.

### 2. Configure Claude Desktop

Add the following to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "knowns": {
      "command": "node",
      "args": [
        "/absolute/path/to/knowns/dist/mcp/server.js"
      ]
    }
  }
}
```

Replace `/absolute/path/to/knowns` with the actual path to your knowns installation.

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

## Development

### Running the Server Directly

```bash
bun run mcp
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
- `task`/`tasks`: result data if `success` is true

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
