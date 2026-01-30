# MCP Context Manager

MCP (Model Context Protocol) tools for context management in AI coding agents. Helps prevent out-of-context issues in long conversations.

## Features

- **Memory Store** - Persistent key-value storage across sessions
- **Context Summarizer** - Summarize chat/text, extract key points, decisions, action items
- **Project Tracker** - Track decisions, changes, todos, notes, errors
- **Session Checkpoint** - Save/restore session state
- **Smart File Loader** - Load files with relevance filtering

## Installation

Requires Node.js >= 18.0.0

```bash
# Run directly with npx (recommended)
npx @asd412id/mcp-context-manager

# Or install globally
npm install -g @asd412id/mcp-context-manager
```

## Configuration by Client

### Claude Desktop

**Config file location:**
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "context-manager": {
      "command": "npx",
      "args": ["-y", "@asd412id/mcp-context-manager"]
    }
  }
}
```

### VS Code (GitHub Copilot / Claude Extension)

**Option 1: Workspace config** - `.vscode/mcp.json`

```json
{
  "servers": {
    "context-manager": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@asd412id/mcp-context-manager"]
    }
  }
}
```

**Option 2: User settings** - `settings.json`

```json
{
  "mcp.servers": {
    "context-manager": {
      "command": "npx",
      "args": ["-y", "@asd412id/mcp-context-manager"]
    }
  }
}
```

### Cursor

**Config file location:**
- **Windows:** `%APPDATA%\Cursor\mcp.json`
- **macOS:** `~/Library/Application Support/Cursor/mcp.json`
- **Linux:** `~/.config/Cursor/mcp.json`

```json
{
  "mcpServers": {
    "context-manager": {
      "command": "npx",
      "args": ["-y", "@asd412id/mcp-context-manager"]
    }
  }
}
```

### Windsurf

**Config file location:**
- **Windows:** `%USERPROFILE%\.codeium\windsurf\mcp_config.json`
- **macOS:** `~/.codeium/windsurf/mcp_config.json`
- **Linux:** `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "context-manager": {
      "command": "npx",
      "args": ["-y", "@asd412id/mcp-context-manager"]
    }
  }
}
```

### Cline (VS Code Extension)

**Config file location:**
- **Windows:** `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- **macOS:** `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Linux:** `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

```json
{
  "mcpServers": {
    "context-manager": {
      "command": "npx",
      "args": ["-y", "@asd412id/mcp-context-manager"],
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

### Continue (VS Code / JetBrains Extension)

**Config file:** `~/.continue/config.json`

```json
{
  "mcpServers": [
    {
      "name": "context-manager",
      "command": "npx",
      "args": ["-y", "@asd412id/mcp-context-manager"]
    }
  ]
}
```

Or using YAML (`~/.continue/config.yaml`):

```yaml
mcpServers:
  - name: context-manager
    command: npx
    args:
      - "-y"
      - "@asd412id/mcp-context-manager"
```

### OpenCode

**Config file:** `opencode.json` in your project root or `~/.config/opencode/config.json`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "context-manager": {
      "type": "local",
      "command": ["npx", "-y", "@asd412id/mcp-context-manager"],
      "enabled": true
    }
  }
}
```

### Zed Editor

**Config file:** `~/.config/zed/settings.json`

```json
{
  "context_servers": {
    "context-manager": {
      "command": "npx",
      "args": ["-y", "@asd412id/mcp-context-manager"],
      "env": {}
    }
  }
}
```

### Custom Context Path

To specify a custom path for storing context data, add environment variables.

**Claude Desktop / Cursor / Windsurf / Cline:**
```json
{
  "mcpServers": {
    "context-manager": {
      "command": "npx",
      "args": ["-y", "@asd412id/mcp-context-manager"],
      "env": {
        "MCP_CONTEXT_PATH": "/path/to/your/project/.context"
      }
    }
  }
}
```

**OpenCode:**
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "context-manager": {
      "type": "local",
      "command": ["npx", "-y", "@asd412id/mcp-context-manager"],
      "environment": {
        "MCP_CONTEXT_PATH": "/path/to/your/project/.context"
      }
    }
  }
}
```

**Zed:**
```json
{
  "context_servers": {
    "context-manager": {
      "command": "npx",
      "args": ["-y", "@asd412id/mcp-context-manager"],
      "env": {
        "MCP_CONTEXT_PATH": "/path/to/your/project/.context"
      }
    }
  }
}
```

## Prompts (Shortcut Commands)

| Prompt | Description |
|--------|-------------|
| `ctx-init` | Load context from previous session |
| `ctx-save` | Save current state to checkpoint |
| `ctx-remember` | Save important info to memory |
| `ctx-todo` | Add a todo item |
| `ctx-decide` | Log a decision |
| `ctx-status` | Show project status |
| `ctx-compress` | Compress long context |
| `ctx-recall` | Search in memory |

## Available Tools (25 tools)

### Memory Store

| Tool | Description |
|------|-------------|
| `memory_set` | Store key-value in memory |
| `memory_get` | Retrieve value from memory |
| `memory_search` | Search memory by pattern/tags |
| `memory_delete` | Delete memory entry |
| `memory_list` | List all memory keys |
| `memory_clear` | Clear memory (all/by tags) |

### Context Summarizer

| Tool | Description |
|------|-------------|
| `context_summarize` | Summarize text, extract key points, decisions, action items |
| `context_get_summary` | Get summary by ID |
| `context_list_summaries` | List all summaries |
| `context_merge_summaries` | Merge multiple summaries |

### Project Tracker

| Tool | Description |
|------|-------------|
| `tracker_log` | Log decision/change/todo/note/error |
| `tracker_status` | Get project status overview |
| `tracker_todo_update` | Update todo status |
| `tracker_search` | Search tracker entries |
| `tracker_set_project` | Set project name |
| `tracker_export` | Export tracker as markdown |

### Session Checkpoint

| Tool | Description |
|------|-------------|
| `checkpoint_save` | Save session state |
| `checkpoint_load` | Load checkpoint |
| `checkpoint_list` | List all checkpoints |
| `checkpoint_delete` | Delete checkpoint |
| `checkpoint_compare` | Compare 2 checkpoints |

### Smart File Loader

| Tool | Description |
|------|-------------|
| `file_smart_read` | Read file with smart options (lines, keywords, structure) |
| `file_info` | Get file metadata |
| `file_search_content` | Search pattern in file |
| `file_list_dir` | List directory files |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_CONTEXT_PATH` | Path to store context data | `{cwd}/.context` |

## Usage Examples

### Session Start Workflow

```
User: ctx-init
AI: *runs checkpoint_load(), tracker_status(), memory_list()*
```

### Save Important Information

```
User: ctx-remember what:"API endpoint at https://api.example.com"
AI: *saves to memory with appropriate key and tags*
```

### Before Ending Session

```
User: ctx-save name:"feature-login-done"
AI: *creates checkpoint with current state*
```

### When Context Gets Long

```
User: ctx-compress
AI: *summarize conversation, save checkpoint, store key info*
```

## Best Practices

1. **Session start** - Always run `ctx-init` to load previous context
2. **Save decisions** - Use `ctx-decide` for every important decision
3. **Track todos** - Use `ctx-todo` for tasks to be done
4. **Checkpoint regularly** - Run `ctx-save` every ~15-20 messages or after milestones
5. **Compress when long** - Use `ctx-compress` if chat gets too long

## Data Storage

All data is stored in `.context/` folder (default: working directory):

```
.context/
├── memory.json          # Memory store
├── tracker.json         # Project tracker
├── checkpoints/         # Session checkpoints
│   ├── index.json
│   └── cp_*.json
└── summaries/           # Context summaries
    └── index.json
```

## Troubleshooting

### Server not starting

1. Make sure Node.js >= 18 is installed: `node --version`
2. Try running manually: `npx @asd412id/mcp-context-manager`
3. Check if port/process conflicts exist

### Tools not appearing

1. Restart your MCP client after configuration changes
2. Check config file syntax (valid JSON)
3. Verify the config file location is correct for your client

### Permission issues

1. Ensure write access to the context path
2. Try setting explicit `MCP_CONTEXT_PATH` in env

## License

MIT

## Contributing

Issues and PRs welcome at [GitHub](https://github.com/asd412id/mcp-context-manager)
