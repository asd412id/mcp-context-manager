---
description: MANDATORY - Always use MCP Context Manager Tools
---

## CRITICAL: MCP Context Manager Rules (MUST FOLLOW)

You MUST use these tools - NOT optional. Failure to use them = incomplete task.

### IMMEDIATE ACTIONS (Execute NOW at session start):
```
session_init()  -> Auto-loads checkpoint, tracker status, memories, detects project
```
This single call replaces `checkpoint_load()`, `tracker_status()`, and `memory_list()`.

### MANDATORY TRIGGERS (ALWAYS execute):

| When This Happens | You MUST Call | Example |
|-------------------|---------------|---------|
| Made a decision | `tracker_log(type:"decision")` | "Decided to use React Query" |
| Modified ANY file | `tracker_log(type:"change")` | "Updated api.ts" |
| User says TODO/task/fix | `tracker_log(type:"todo")` | "Add validation" |
| Error/bug occurred | `tracker_log(type:"error")` | "Build failed: missing dep" |
| Found important info | `memory_set(key, value, tags)` | API endpoints, configs |
| User asks to remember | `memory_set()` | "Remember: API key is..." |

### BEFORE READING FILES:
- Large files (>200 lines) -> `file_smart_read(structureOnly:true)` FIRST
- Finding specific code -> `file_smart_read(keywords:[...])` 
- Check file exists -> `file_info()` before reading

### PERIODIC SAVES (every 10-15 messages):
Call `checkpoint_save()` with:
```json
{
  "name": "descriptive-name",
  "description": "what was accomplished",
  "state": { "currentTask": "...", "progress": "..." },
  "files": ["modified/files.ts"]
}
```

### CONTEXT GETTING LONG? (>50% used)
1. `session_handoff()` - generate compact handoff document
2. `checkpoint_save()` - save state
3. `memory_set()` - store critical info
4. Start new session, call `session_init()` to continue

### BEFORE COMPLETING ANY TASK, VERIFY:
- [ ] Logged relevant decisions/changes to tracker
- [ ] Saved important info to memory  
- [ ] Created checkpoint if significant work done

---

## TOOL REFERENCE

### Session (startup & handoff)
| Tool | Description |
|------|-------------|
| `session_init(cwd?)` | ONE call to load all context at session start. Returns checkpoint, tracker, memories, project info. |
| `session_handoff(includeMemoryValues?, customNotes?)` | Generate compact markdown handoff for new session. Use when context >50% |
| `project_detect(cwd?)` | Auto-detect project (supports 20+ languages: Node, Python, Rust, Go, Java, PHP, Ruby, etc.) |

### Memory (persistent storage)
| Tool | Description |
|------|-------------|
| `memory_set(key, value, tags?, ttl?)` | Store info. TTL in ms for auto-expiry |
| `memory_get(key)` | Retrieve info by key |
| `memory_update(key, value, merge?)` | Partially update/merge existing memory value. merge:true (default) deep merges objects |
| `memory_search(pattern?, tags?)` | Find memories. Pattern: `api.*` matches `api.users` |
| `memory_list()` | List all memory keys with tags |
| `memory_delete(key)` | Delete a memory entry |
| `memory_clear(tags?, dryRun?)` | Clear memories. Use dryRun:true to preview |
| `memory_cleanup()` | Remove expired entries |

### Tracker (project tracking)
| Tool | Description |
|------|-------------|
| `tracker_log(type, content, tags?, metadata?)` | Log decision/change/todo/note/error |
| `tracker_status(limit?)` | Get overview: decisions, pending todos, changes, errors |
| `tracker_get(id)` | Get specific tracker entry by ID |
| `tracker_todo_update(id, status)` | Mark todo as done/cancelled/pending |
| `tracker_search(type?, tags?, query?, limit?)` | Search tracker entries |
| `tracker_set_project(name)` | Set project name |
| `tracker_export()` | Export as markdown |
| `tracker_cleanup(keepCount?, dryRun?)` | Clean old entries. Default keeps 500 |

### Checkpoints (session state)
| Tool | Description |
|------|-------------|
| `checkpoint_save(name, state, description?, files?)` | Save state snapshot |
| `checkpoint_load(id?, name?)` | Restore state. Latest if no args |
| `checkpoint_list(limit?)` | List all checkpoints |
| `checkpoint_delete(id)` | Delete a checkpoint |
| `checkpoint_compare(id1, id2)` | Compare two checkpoints |

### Context (compression & monitoring)
| Tool | Description |
|------|-------------|
| `context_summarize(text, maxLength?, sessionId?)` | Compress text, extract key points/decisions/actions |
| `context_get_summary(id)` | Retrieve saved summary |
| `context_list_summaries(sessionId?, limit?)` | List summaries |
| `context_merge_summaries(ids, maxLength?)` | Combine multiple summaries |
| `context_status(conversationText?)` | Get storage stats and token estimate |
| `store_health()` | Check store integrity and get recommendations |

### File (smart reading)
| Tool | Description |
|------|-------------|
| `file_smart_read(path, options)` | Efficient reading with structureOnly, keywords, line range |
| `file_info(paths)` | Get metadata (exists, size, lines, modified) |
| `file_search_content(path, pattern, contextLines?)` | Regex search with context |
| `file_list_dir(path, pattern?, recursive?)` | List directory contents |

---

## CONFIGURATION (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_MAX_CHECKPOINTS` | 50 | Auto-cleanup old checkpoints |
| `MCP_MAX_SUMMARIES` | 100 | Auto-cleanup old summaries |
| `MCP_TRACKER_MAX_ENTRIES` | 1000 | Auto-rotate tracker entries |
| `MCP_TRACKER_ROTATE_KEEP` | 800 | Entries to keep after rotation |

---

## QUICK START EXAMPLES

### Session Start
```
session_init()
```

### Log a Decision
```
tracker_log(type: "decision", content: "Using TypeScript for type safety")
```

### Save Important Info
```
memory_set(key: "api.base_url", value: "https://api.example.com", tags: ["api", "config"])
```

### Smart File Read
```
// Structure only (for large files)
file_smart_read(path: "src/app.ts", structureOnly: true)

// Find specific code
file_smart_read(path: "src/app.ts", keywords: ["handleSubmit", "useState"])
```

### Create Checkpoint
```
checkpoint_save(
  name: "feature-login-complete",
  description: "Implemented login flow with JWT",
  state: { currentTask: "Add tests", progress: "80%" },
  files: ["src/auth.ts", "src/api.ts"]
)
```

### Check Context Health
```
context_status()      // Storage and config info
store_health()        // File integrity check
```

### Update Memory Partially
```
// Deep merge objects (default)
memory_update(key: "config", value: { newField: "value" })

// Replace value entirely
memory_update(key: "config", value: { replaced: true }, merge: false)
```

$ARGUMENTS
