import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';

export function registerPrompts(server: McpServer): void {
  // ctx-init - Load previous context
  server.registerPrompt(
    'ctx-init',
    {
      title: 'Init Session',
      description: 'Load previous context at session start'
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Initialize session with session_init() - loads checkpoint, tracker status, memories, and detects project in one call.`
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
          text: `Context getting long. Summarize conversation with context_summarize(), save checkpoint, store key info to memory.`
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
}
