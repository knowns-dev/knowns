# Claude Desktop MCP Integration

Integrate Knowns with Claude Desktop for seamless AI-assisted development.

## What is MCP?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is a standard for connecting AI assistants to external tools and data sources. Knowns implements an MCP server that allows Claude to read and manage your tasks and documentation directly.

## Setup

### 1. Install Knowns

```bash
# Using bun (recommended)
bun install -g knowns

# Or using npm
npm install -g knowns
```

### 2. Configure Claude Desktop

Edit Claude's configuration file:

**macOS:**
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

**Windows:**
```
%APPDATA%\Claude\claude_desktop_config.json
```

Add the Knowns MCP server:

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

> **Note**: Replace `/path/to/your/project` with your actual project path where `.knowns/` folder exists.

### 3. Restart Claude Desktop

Close and reopen Claude Desktop to load the new configuration.

## Usage

Once configured, Claude can access your Knowns data automatically.

### Example Conversation

```
You: "Start working on task 42"

Claude: [Reads task via MCP]
"I see task #42 'Add user authentication' with these acceptance criteria:
- User can login with email/password
- JWT token is returned on success
- Invalid credentials return 401

The description references @doc/patterns/auth. Let me check that..."

[Fetches patterns/auth.md via MCP]

"Got it! The auth pattern uses JWT with 15-minute access tokens and
7-day refresh tokens. I'll implement following this pattern.

Starting timer and beginning implementation..."

[Starts time tracking via MCP]
```

## Available MCP Tools

### Task Management

| Tool | Description | Parameters |
|------|-------------|------------|
| `create_task` | Create a new task | `title`, `description?`, `status?`, `priority?`, `labels?`, `assignee?` |
| `get_task` | Get task by ID | `taskId` |
| `update_task` | Update task fields | `taskId`, `title?`, `description?`, `status?`, `priority?`, `assignee?`, `labels?` |
| `list_tasks` | List tasks with filters | `status?`, `priority?`, `assignee?`, `label?` |
| `search_tasks` | Search tasks by query | `query` |

### Time Tracking

| Tool | Description | Parameters |
|------|-------------|------------|
| `start_time` | Start timer for task | `taskId` |
| `stop_time` | Stop active timer | `taskId` |
| `add_time` | Manual time entry | `taskId`, `duration`, `note?`, `date?` |
| `get_time_report` | Generate time report | `from?`, `to?`, `groupBy?` |

### Documentation

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_docs` | List all docs | `tag?` |
| `get_doc` | Get doc content | `path` |
| `create_doc` | Create new doc | `title`, `description?`, `content?`, `tags?`, `folder?` |
| `update_doc` | Update doc | `path`, `title?`, `description?`, `content?`, `appendContent?`, `tags?` |
| `search_docs` | Search docs | `query`, `tag?` |

### Board

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_board` | Get kanban board state | - |

## Benefits

### Zero Context Loss

- AI reads your docs directly — no copy-paste
- References (`@doc/...`, `@task-42`) are resolved automatically
- Project patterns are always available

### Consistent Implementations

- AI follows your documented patterns every time
- Same conventions across all sessions
- No more "how does your auth work?" questions

### Perfect Memory

- Documentation persists between sessions
- AI can reference any past decision
- Knowledge doesn't live in chat history

### Time Tracking Integration

- AI can start/stop timers automatically
- Track time spent on each task
- Generate reports for retrospectives

## Troubleshooting

### Claude doesn't see Knowns

1. Verify installation: `knowns --version`
2. Check config file path is correct
3. Ensure JSON syntax is valid
4. Verify `cwd` points to a valid project with `.knowns/` folder
5. Restart Claude Desktop completely

### MCP server not starting

Run manually to check for errors:

```bash
knowns mcp --verbose
```

### Tools not appearing

Check if project is initialized:

```bash
cd your-project
knowns init  # if not already done
```

### Show MCP configuration info

```bash
knowns mcp --info
```

## Alternative: --plain Output

If you're not using Claude Desktop, use `--plain` flag for AI-readable output:

```bash
knowns task 42 --plain | pbcopy  # Copy to clipboard
knowns doc "auth-pattern" --plain
```

Then paste into any AI assistant.

## Resources

- [MCP Protocol Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [Knowns MCP Server Documentation](../src/mcp/README.md)
- [Claude Desktop Configuration](https://modelcontextprotocol.io/quickstart/user)
