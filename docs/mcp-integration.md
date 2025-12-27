# Claude Desktop MCP Integration

Integrate Knowns with Claude Desktop for seamless AI-assisted development.

## What is MCP?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is a standard for connecting AI assistants to external tools and data sources. Knowns implements an MCP server that allows Claude to read your tasks and documentation directly.

## Setup

### 1. Install Knowns

```bash
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
      "args": ["mcp"]
    }
  }
}
```

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

Starting implementation..."
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `list_tasks` | List all tasks |
| `get_task` | Get task details by ID |
| `list_docs` | List all documentation |
| `get_doc` | Get document content |
| `search` | Search tasks and docs |

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

## Troubleshooting

### Claude doesn't see Knowns

1. Verify installation: `knowns --version`
2. Check config file path is correct
3. Ensure JSON syntax is valid
4. Restart Claude Desktop completely

### MCP server not starting

Run manually to check for errors:

```bash
knowns mcp
```

### Tools not appearing

Check if project is initialized:

```bash
cd your-project
knowns init  # if not already done
```

## Alternative: --plain Output

If you're not using Claude Desktop, use `--plain` flag for AI-readable output:

```bash
knowns task view 42 --plain | pbcopy  # Copy to clipboard
knowns doc view "auth-pattern" --plain
```

Then paste into any AI assistant.
