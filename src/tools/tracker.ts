import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { getStore } from '../storage/file-store.js';

const STORAGE_VERSION = 1;
const MAX_ENTRIES = parseInt(process.env.MCP_TRACKER_MAX_ENTRIES || '1000', 10);
const ROTATE_KEEP = parseInt(process.env.MCP_TRACKER_ROTATE_KEEP || '800', 10);

// Generate unique ID with random suffix to prevent collisions
function generateId(type: string): string {
  return `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

interface TrackerEntry {
  id: string;
  type: 'decision' | 'change' | 'todo' | 'note' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  tags: string[];
  status?: 'pending' | 'done' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

interface TrackerStore {
  version: number;
  entries: TrackerEntry[];
  projectName?: string;
}

const TRACKER_FILE = 'tracker.json';

async function getTrackerStore(): Promise<TrackerStore> {
  const store = getStore();
  try {
    const data = await store.read<TrackerStore>(TRACKER_FILE, { version: STORAGE_VERSION, entries: [] });
    if (!data.version) data.version = STORAGE_VERSION;
    // Ensure entries is an array
    if (!Array.isArray(data.entries)) {
      data.entries = [];
    }
    return data;
  } catch (error) {
    console.error('[Tracker] Error reading tracker store, resetting:', (error as Error).message);
    return { version: STORAGE_VERSION, entries: [] };
  }
}

async function saveTrackerStore(data: TrackerStore): Promise<void> {
  const store = getStore();
  data.version = STORAGE_VERSION;
  // Auto-rotate when exceeding limit
  if (data.entries.length > MAX_ENTRIES) {
    data.entries = data.entries.slice(-ROTATE_KEEP);
  }
  await store.write(TRACKER_FILE, data);
}

export function registerTrackerTools(server: McpServer): void {
  server.registerTool(
    'tracker_log',
    {
      title: 'Tracker Log',
      description: `Log a decision, change, todo, note, or error to the project tracker.
WHEN TO USE:
- type:"decision" - After making architectural/implementation choices
- type:"change" - After modifying files
- type:"todo" - When tasks/TODOs/fixes are needed
- type:"error" - When encountering errors or bugs
- type:"note" - For general observations
Recommended: Log important events to maintain project history.`,
      inputSchema: {
        type: z.enum(['decision', 'change', 'todo', 'note', 'error']).describe('Type of entry'),
        content: z.string().describe('Description of the entry'),
        tags: z.array(z.string()).optional().describe('Tags for categorization'),
        metadata: z.record(z.unknown()).optional().describe('Additional metadata')
      }
    },
    async ({ type, content, tags, metadata }) => {
      const trackerStore = await getTrackerStore();
      const now = new Date().toISOString();
      
      const entry: TrackerEntry = {
        id: generateId(type),
        type,
        content,
        metadata,
        tags: tags || [],
        status: type === 'todo' ? 'pending' : undefined,
        createdAt: now,
        updatedAt: now
      };
      
      trackerStore.entries.push(entry);
      await saveTrackerStore(trackerStore);
      
      return {
        content: [{ 
          type: 'text', 
          text: `Logged ${type}: "${content}" (ID: ${entry.id})`
        }]
      };
    }
  );

  server.registerTool(
    'tracker_status',
    {
      title: 'Tracker Status',
      description: `Get current project status including recent decisions, pending todos, and recent changes.
WHEN TO USE:
- At session start (or use session_init instead)
- To review what needs to be done (pending todos)
- To recall recent decisions and changes`,
      inputSchema: {
        limit: z.number().optional().describe('Maximum entries per type (default: 5)')
      }
    },
    async ({ limit = 5 }) => {
      const trackerStore = await getTrackerStore();
      const entries = trackerStore.entries;
      
      const decisions = entries
        .filter(e => e.type === 'decision')
        .slice(-limit);
      
      const pendingTodos = entries
        .filter(e => e.type === 'todo' && e.status === 'pending')
        .slice(-limit);
      
      const recentChanges = entries
        .filter(e => e.type === 'change')
        .slice(-limit);
      
      const recentErrors = entries
        .filter(e => e.type === 'error')
        .slice(-limit);
      
      const status = {
        projectName: trackerStore.projectName,
        totalEntries: entries.length,
        decisions: decisions.map(d => ({ id: d.id, content: d.content, date: d.createdAt })),
        pendingTodos: pendingTodos.map(t => ({ id: t.id, content: t.content, tags: t.tags })),
        recentChanges: recentChanges.map(c => ({ id: c.id, content: c.content, date: c.createdAt })),
        recentErrors: recentErrors.map(e => ({ id: e.id, content: e.content, date: e.createdAt }))
      };
      
      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }]
      };
    }
  );

  server.registerTool(
    'tracker_todo_update',
    {
      title: 'Update Todo',
      description: `Update the status of a todo item.
WHEN TO USE:
- After completing a task -> status:"done"
- When task is no longer needed -> status:"cancelled"
- To re-open a task -> status:"pending"`,
      inputSchema: {
        id: z.string().describe('Todo ID to update'),
        status: z.enum(['pending', 'done', 'cancelled']).describe('New status')
      }
    },
    async ({ id, status }) => {
      const trackerStore = await getTrackerStore();
      const entry = trackerStore.entries.find(e => e.id === id);
      
      if (!entry) {
        return {
          content: [{ type: 'text', text: `Entry not found: ${id}` }]
        };
      }
      
      if (entry.type !== 'todo') {
        return {
          content: [{ type: 'text', text: `Entry ${id} is not a todo` }]
        };
      }
      
      entry.status = status;
      entry.updatedAt = new Date().toISOString();
      await saveTrackerStore(trackerStore);
      
      return {
        content: [{ type: 'text', text: `Todo "${entry.content}" marked as ${status}` }]
      };
    }
  );

  server.registerTool(
    'tracker_search',
    {
      title: 'Tracker Search',
      description: 'Search tracker entries by type, tags, or content.',
      inputSchema: {
        type: z.enum(['decision', 'change', 'todo', 'note', 'error']).optional().describe('Filter by type'),
        tags: z.array(z.string()).optional().describe('Filter by tags'),
        query: z.string().optional().describe('Search in content'),
        limit: z.number().optional().describe('Maximum results (default: 20)')
      }
    },
    async ({ type, tags, query, limit = 20 }) => {
      const trackerStore = await getTrackerStore();
      let results = trackerStore.entries;
      
      if (type) {
        results = results.filter(e => e.type === type);
      }
      
      if (tags && tags.length > 0) {
        results = results.filter(e => 
          tags.some(tag => e.tags.includes(tag))
        );
      }
      
      if (query) {
        const lowerQuery = query.toLowerCase();
        results = results.filter(e => 
          e.content.toLowerCase().includes(lowerQuery)
        );
      }
      
      results = results.slice(-limit);
      
      return {
        content: [{ 
          type: 'text', 
          text: results.length > 0 
            ? JSON.stringify(results, null, 2)
            : 'No entries found'
        }]
      };
    }
  );

  server.registerTool(
    'tracker_set_project',
    {
      title: 'Set Project Name',
      description: 'Set the current project name for context.',
      inputSchema: {
        name: z.string().describe('Project name')
      }
    },
    async ({ name }) => {
      const trackerStore = await getTrackerStore();
      trackerStore.projectName = name;
      await saveTrackerStore(trackerStore);
      
      return {
        content: [{ type: 'text', text: `Project name set to: ${name}` }]
      };
    }
  );

  server.registerTool(
    'tracker_export',
    {
      title: 'Export Tracker',
      description: 'Export all tracker entries as markdown format for documentation.',
      inputSchema: {}
    },
    async () => {
      const trackerStore = await getTrackerStore();
      const entries = trackerStore.entries;
      
      let md = `# Project Tracker${trackerStore.projectName ? `: ${trackerStore.projectName}` : ''}\n\n`;
      md += `Generated: ${new Date().toISOString()}\n\n`;
      
      const decisions = entries.filter(e => e.type === 'decision');
      if (decisions.length > 0) {
        md += `## Decisions\n\n`;
        for (const d of decisions) {
          md += `- **${d.createdAt.split('T')[0]}**: ${d.content}\n`;
        }
        md += '\n';
      }
      
      const todos = entries.filter(e => e.type === 'todo');
      if (todos.length > 0) {
        md += `## Todos\n\n`;
        for (const t of todos) {
          const checkbox = t.status === 'done' ? '[x]' : '[ ]';
          md += `- ${checkbox} ${t.content}${t.status === 'cancelled' ? ' _(cancelled)_' : ''}\n`;
        }
        md += '\n';
      }
      
      const changes = entries.filter(e => e.type === 'change');
      if (changes.length > 0) {
        md += `## Changes\n\n`;
        for (const c of changes) {
          md += `- **${c.createdAt.split('T')[0]}**: ${c.content}\n`;
        }
        md += '\n';
      }
      
      const errors = entries.filter(e => e.type === 'error');
      if (errors.length > 0) {
        md += `## Errors/Issues\n\n`;
        for (const e of errors) {
          md += `- **${e.createdAt.split('T')[0]}**: ${e.content}\n`;
        }
        md += '\n';
      }
      
      return {
        content: [{ type: 'text', text: md }]
      };
    }
  );

  server.registerTool(
    'tracker_cleanup',
    {
      title: 'Tracker Cleanup',
      description: `Clean up old tracker entries. Keeps the most recent entries. Use dryRun:true to preview.
WHEN TO USE:
- When tracker has too many old entries
- To free up storage space
- Periodically for maintenance`,
      inputSchema: {
        keepCount: z.number().optional().describe('Number of entries to keep (default: 500)'),
        dryRun: z.boolean().optional().describe('Preview what would be deleted without actually deleting')
      }
    },
    async ({ keepCount = 500, dryRun = false }) => {
      const trackerStore = await getTrackerStore();
      const originalCount = trackerStore.entries.length;
      
      if (originalCount <= keepCount) {
        return {
          content: [{ type: 'text', text: `No cleanup needed. Current entries: ${originalCount}` }]
        };
      }
      
      const toRemove = originalCount - keepCount;
      const entriesToRemove = trackerStore.entries.slice(0, toRemove);
      
      if (dryRun) {
        return {
          content: [{ 
            type: 'text', 
            text: `[DRY RUN] Would remove ${toRemove} entries:\n${entriesToRemove.map(e => `- ${e.id}: ${e.content.substring(0, 50)}...`).join('\n')}`
          }]
        };
      }
      
      trackerStore.entries = trackerStore.entries.slice(-keepCount);
      await saveTrackerStore(trackerStore);
      
      return {
        content: [{ type: 'text', text: `Cleaned up ${toRemove} old entries. Remaining: ${keepCount}` }]
      };
    }
  );
}
