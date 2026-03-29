import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';

// Built-in instructions for context management and RAM optimization
const CONTEXT_MANAGEMENT_INSTRUCTIONS = `
## Context Management Best Practices

**To minimize context window usage and free RAM:**

1. **Recall before reading** - Use memory_search()/tracker_search() first, then read files only if needed
2. **Offload to persistent storage** - Use memory_set() or memory_capture_candidates() for important findings
3. **Read files efficiently** - Use file_smart_read(structureOnly:true) or file_smart_read(keywords:[...])
4. **Smart prune context** - Use context_prune_smart() to keep high-signal items and prune low-signal chatter
5. **Checkpoint regularly** - Save state every 10-15 messages with checkpoint_save()

**When to cleanup (check with context_status()):**
- Token usage >50% → Run context_prune_smart() and summarize verbose content
- Token usage >70% → Checkpoint and consider handoff
- Token usage >85% → MUST handoff to new session

**Cleanup workflow:**
1. context_status() → Check token usage
2. context_prune_smart(items, mode:"hybrid") → Score and prune low-signal context
3. context_summarize(longText) → Compress high-value verbose content
4. memory_capture_candidates(text, dryRun:false) → Persist important facts automatically
5. checkpoint_save() → Save state
6. session_handoff() → Generate handoff doc
`;

export function registerPrompts(server: McpServer): void {
  // ctx-init - Load previous context with instructions
  server.registerPrompt(
    'ctx-init',
    {
      title: 'Init Session',
      description: 'Load previous context at session start with context management instructions'
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Initialize session with session_init() - loads checkpoint, tracker status, memories, and detects project in one call.

${CONTEXT_MANAGEMENT_INSTRUCTIONS}

**After init, follow these rules:**
- Log decisions with tracker_log(type:"decision")
- Log file changes with tracker_log(type:"change")
- Capture important findings with memory_capture_candidates() or memory_set()
- Prune processed context with context_prune_smart()
- Checkpoint every 10-15 messages`
        }
      }]
    })
  );

  // ctx-save - Quick save current state
  server.registerPrompt(
    'ctx-save',
    {
      title: 'Save State',
      description: 'Quick save current session state',
      argsSchema: {
        name: z.string().optional().describe('Checkpoint name')
      }
    },
    ({ name }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Save current state to checkpoint "${name || 'auto'}". Include: current task, progress, important decisions, modified files.`
        }
      }]
    })
  );

  // ctx-remember - Save to memory
  server.registerPrompt(
    'ctx-remember',
    {
      title: 'Remember',
      description: 'Save important info to memory',
      argsSchema: {
        what: z.string().describe('What to remember')
      }
    },
    ({ what }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Save to memory: "${what}". Use descriptive key and appropriate tags.`
        }
      }]
    })
  );

  // ctx-todo - Add todo item
  server.registerPrompt(
    'ctx-todo',
    {
      title: 'Add Todo',
      description: 'Log a todo item',
      argsSchema: {
        task: z.string().describe('Task to do')
      }
    },
    ({ task }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Log todo: "${task}"`
        }
      }]
    })
  );

  // ctx-decide - Log decision
  server.registerPrompt(
    'ctx-decide',
    {
      title: 'Log Decision',
      description: 'Record a decision',
      argsSchema: {
        decision: z.string().describe('Decision made')
      }
    },
    ({ decision }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Log decision: "${decision}"`
        }
      }]
    })
  );

  // ctx-status - Get current status
  server.registerPrompt(
    'ctx-status',
    {
      title: 'Status',
      description: 'Show project status'
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Show: tracker_status(), memory_list(), checkpoint_list()`
        }
      }]
    })
  );

  // ctx-compress - Summarize long context
  server.registerPrompt(
    'ctx-compress',
    {
      title: 'Compress Context',
      description: 'Summarize to save context space'
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Context getting long. Run context_prune_smart() first, summarize with context_summarize(), persist key info via memory_capture_candidates(), then save checkpoint.`
        }
      }]
    })
  );

  // ctx-recall - Search memories
  server.registerPrompt(
    'ctx-recall',
    {
      title: 'Recall',
      description: 'Search saved memories',
      argsSchema: {
        query: z.string().optional().describe('Search term')
      }
    },
    ({ query }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: query 
            ? `Search memories for: "${query}"` 
            : `List all memories with memory_list()`
        }
      }]
    })
  );

  // ctx-cleanup - Cleanup context and free RAM
  server.registerPrompt(
    'ctx-cleanup',
    {
      title: 'Cleanup Context',
      description: 'Free up context window space and reduce RAM usage'
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Cleanup context to free RAM and reduce token usage.

**Execute this workflow:**
1. context_status() → Check current token usage estimate
2. Identify verbose content in conversation that can be summarized
3. context_prune_smart(items, mode:"hybrid") → Keep high-signal and prune low-signal context
4. context_summarize(verboseText, maxLength:1000) → Compress long content
5. memory_capture_candidates(text, dryRun:false) → Offload important data automatically
6. checkpoint_save(name, state) → Save current session state
7. If token usage >70%, run session_handoff() to prepare for new session

**Tips to reduce context:**
- Use file_smart_read(structureOnly:true) instead of reading full files
- Use file_smart_read(keywords:[...]) to read only relevant sections
- Store discovered info in memory_capture_candidates()/memory_set() instead of keeping in context
- Don't re-read files - use memory_get() for cached data`
        }
      }]
    })
  );

  // ctx-handoff - Generate handoff for new session
  server.registerPrompt(
    'ctx-handoff',
    {
      title: 'Session Handoff',
      description: 'Generate handoff document for seamless session continuation'
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Context is getting long. Generate a handoff document for continuing in a new session.

**Execute:**
1. checkpoint_save() → Save current state
2. session_handoff() → Generate compact markdown handoff

**Instructions for new session:**
1. Start new conversation
2. Paste the handoff document
3. Run session_init() to restore full context`
        }
      }]
    })
  );
}
