import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { getStore } from '../storage/file-store.js';

const STORAGE_VERSION = 1;

interface MemoryEntry {
  key: string;
  value: unknown;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  ttl?: number;
}

interface MemoryStore {
  version: number;
  entries: Record<string, MemoryEntry>;
}

const MEMORY_FILE = 'memory.json';

async function getMemoryStore(): Promise<MemoryStore> {
  const store = getStore();
  const data = await store.read<MemoryStore>(MEMORY_FILE, { version: STORAGE_VERSION, entries: {} });
  // Ensure version field exists for old stores
  if (!data.version) data.version = STORAGE_VERSION;
  return data;
}

async function saveMemoryStore(data: MemoryStore): Promise<void> {
  const store = getStore();
  data.version = STORAGE_VERSION;
  await store.write(MEMORY_FILE, data);
}

function isExpired(entry: MemoryEntry): boolean {
  if (!entry.ttl) return false;
  // Use updatedAt for TTL calculation (TTL resets on update)
  const expiresAt = new Date(entry.updatedAt).getTime() + entry.ttl;
  return Date.now() > expiresAt;
}

// Safe pattern conversion - escape special regex chars except *
function safePatternToRegex(pattern: string): RegExp {
  // Escape all special regex characters except *
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Convert * to non-greedy .*
  const regexPattern = '^' + escaped.replace(/\*/g, '.*?') + '$';
  return new RegExp(regexPattern, 'i');
}

// Cleanup expired entries and return count
export async function cleanupExpiredMemories(): Promise<number> {
  const memStore = await getMemoryStore();
  const keys = Object.keys(memStore.entries);
  let removed = 0;
  
  for (const key of keys) {
    if (isExpired(memStore.entries[key])) {
      delete memStore.entries[key];
      removed++;
    }
  }
  
  if (removed > 0) {
    await saveMemoryStore(memStore);
  }
  
  return removed;
}

export function registerMemoryTools(server: McpServer): void {
  server.registerTool(
    'memory_set',
    {
      title: 'Memory Set',
      description: `Store a key-value pair in persistent memory.
WHEN TO USE: 
- After discovering important info (API endpoints, configs, credentials refs)
- When user says "remember this" or "save this"
- To store frequently referenced data
- Before ending a session to preserve key context`,
      inputSchema: {
        key: z.string().describe('Unique identifier for this memory'),
        value: z.unknown().describe('Data to store (any JSON-serializable value)'),
        tags: z.array(z.string()).optional().describe('Tags for categorization and searching'),
        ttl: z.number().optional().describe('Time-to-live in milliseconds (optional)')
      }
    },
    async ({ key, value, tags, ttl }) => {
      const memStore = await getMemoryStore();
      const now = new Date().toISOString();
      
      const existing = memStore.entries[key];
      memStore.entries[key] = {
        key,
        value,
        tags: tags || [],
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        ttl
      };
      
      await saveMemoryStore(memStore);
      
      return {
        content: [{ 
          type: 'text', 
          text: `Memory saved: "${key}"${ttl ? ` (expires in ${ttl}ms)` : ''}`
        }]
      };
    }
  );

  server.registerTool(
    'memory_get',
    {
      title: 'Memory Get',
      description: `Retrieve a value from persistent memory by key.
WHEN TO USE:
- Before starting work to recall saved context
- When you need specific info you saved earlier
- After session_init if you need detailed value (not just key list)`,
      inputSchema: {
        key: z.string().describe('Key to retrieve')
      }
    },
    async ({ key }) => {
      const memStore = await getMemoryStore();
      const entry = memStore.entries[key];
      
      if (!entry) {
        return {
          content: [{ type: 'text', text: `Memory not found: "${key}"` }]
        };
      }
      
      if (isExpired(entry)) {
        delete memStore.entries[key];
        await saveMemoryStore(memStore);
        return {
          content: [{ type: 'text', text: `Memory expired: "${key}"` }]
        };
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            key: entry.key,
            value: entry.value,
            tags: entry.tags,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt
          }, null, 2)
        }]
      };
    }
  );

  server.registerTool(
    'memory_search',
    {
      title: 'Memory Search',
      description: `Search memories by key pattern or tags.
WHEN TO USE:
- When you need to find memories but don't know exact key
- To find all memories related to a topic (via tags)
- Pattern examples: "api.*" matches "api.users", "api.posts"`,
      inputSchema: {
        pattern: z.string().optional().describe('Key pattern to search (supports * wildcard)'),
        tags: z.array(z.string()).optional().describe('Filter by tags (any match)')
      }
    },
    async ({ pattern, tags }) => {
      const memStore = await getMemoryStore();
      let results: MemoryEntry[] = Object.values(memStore.entries);
      
      // Filter out expired entries
      results = results.filter(entry => !isExpired(entry));
      
      if (pattern) {
        try {
          const regex = safePatternToRegex(pattern);
          results = results.filter(entry => regex.test(entry.key));
        } catch {
          return {
            content: [{ type: 'text', text: `Invalid search pattern: "${pattern}"` }]
          };
        }
      }
      
      if (tags && tags.length > 0) {
        results = results.filter(entry => 
          tags.some(tag => entry.tags.includes(tag))
        );
      }
      
      const output = results.map(entry => ({
        key: entry.key,
        value: entry.value,
        tags: entry.tags,
        updatedAt: entry.updatedAt
      }));
      
      return {
        content: [{ 
          type: 'text', 
          text: results.length > 0 
            ? JSON.stringify(output, null, 2)
            : 'No memories found matching criteria'
        }]
      };
    }
  );

  server.registerTool(
    'memory_delete',
    {
      title: 'Memory Delete',
      description: 'Delete a memory entry by key.',
      inputSchema: {
        key: z.string().describe('Key to delete')
      }
    },
    async ({ key }) => {
      const memStore = await getMemoryStore();
      
      if (!memStore.entries[key]) {
        return {
          content: [{ type: 'text', text: `Memory not found: "${key}"` }]
        };
      }
      
      delete memStore.entries[key];
      await saveMemoryStore(memStore);
      
      return {
        content: [{ type: 'text', text: `Memory deleted: "${key}"` }]
      };
    }
  );

  server.registerTool(
    'memory_list',
    {
      title: 'Memory List',
      description: `List all memory keys with their tags.
WHEN TO USE:
- At session start (or use session_init instead)
- To see what's been saved
- Before deciding what to store (avoid duplicates)`,
      inputSchema: {}
    },
    async () => {
      const memStore = await getMemoryStore();
      const entries = Object.values(memStore.entries).filter(e => !isExpired(e));
      
      if (entries.length === 0) {
        return {
          content: [{ type: 'text', text: 'No memories stored' }]
        };
      }
      
      const list = entries.map(e => ({
        key: e.key,
        tags: e.tags,
        updatedAt: e.updatedAt
      }));
      
      return {
        content: [{ type: 'text', text: JSON.stringify(list, null, 2) }]
      };
    }
  );

  server.registerTool(
    'memory_clear',
    {
      title: 'Memory Clear',
      description: 'Clear all memories or memories matching specific tags. Use dryRun:true to preview what would be deleted.',
      inputSchema: {
        tags: z.array(z.string()).optional().describe('Only clear memories with these tags (clears all if not specified)'),
        dryRun: z.boolean().optional().describe('Preview what would be deleted without actually deleting')
      }
    },
    async ({ tags, dryRun = false }) => {
      const memStore = await getMemoryStore();
      const toDelete: string[] = [];
      
      if (tags && tags.length > 0) {
        for (const key of Object.keys(memStore.entries)) {
          const entry = memStore.entries[key];
          if (tags.some(tag => entry.tags.includes(tag))) {
            toDelete.push(key);
          }
        }
      } else {
        toDelete.push(...Object.keys(memStore.entries));
      }
      
      if (dryRun) {
        return {
          content: [{ 
            type: 'text', 
            text: `[DRY RUN] Would delete ${toDelete.length} memories:\n${toDelete.join('\n') || '(none)'}` 
          }]
        };
      }
      
      for (const key of toDelete) {
        delete memStore.entries[key];
      }
      
      await saveMemoryStore(memStore);
      
      return {
        content: [{ type: 'text', text: `Cleared ${toDelete.length} memories` }]
      };
    }
  );

  server.registerTool(
    'memory_cleanup',
    {
      title: 'Memory Cleanup',
      description: 'Remove all expired memory entries. Call periodically to free up storage.',
      inputSchema: {}
    },
    async () => {
      const removed = await cleanupExpiredMemories();
      
      return {
        content: [{ 
          type: 'text', 
          text: removed > 0 
            ? `Cleaned up ${removed} expired memories`
            : 'No expired memories to clean up'
        }]
      };
    }
  );
}
