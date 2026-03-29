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
  try {
    const data = await store.read<MemoryStore>(MEMORY_FILE, { version: STORAGE_VERSION, entries: {} });
    // Ensure version field exists for old stores
    if (!data.version) data.version = STORAGE_VERSION;
    // Ensure entries is an object
    if (!data.entries || typeof data.entries !== 'object') {
      data.entries = {};
    }
    return data;
  } catch (error) {
    console.error('[Memory] Error reading memory store, resetting:', (error as Error).message);
    return { version: STORAGE_VERSION, entries: {} };
  }
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

// Deep merge utility for objects
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];
    
    if (Array.isArray(sourceVal) && Array.isArray(targetVal)) {
      // Concat arrays
      result[key] = [...targetVal, ...sourceVal];
    } else if (
      typeof sourceVal === 'object' && sourceVal !== null &&
      typeof targetVal === 'object' && targetVal !== null &&
      !Array.isArray(sourceVal) && !Array.isArray(targetVal)
    ) {
      // Recursive merge for nested objects
      result[key] = deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>);
    } else {
      // Override with source value
      result[key] = sourceVal;
    }
  }
  
  return result;
}

interface MemoryCandidate {
  key: string;
  value: string;
  tags: string[];
  confidence: number;
  reason: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'item';
}

function buildMemoryCandidates(text: string, source: string, baseTags: string[]): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (lower.includes('decision:') || lower.includes('decided to')) {
      const subject = line.replace(/^.*?(decision:\s*|decided to\s*)/i, '').trim() || line;
      candidates.push({
        key: `decision.${slugify(subject)}`,
        value: line,
        tags: [...baseTags, source, 'decision'],
        confidence: 0.92,
        reason: 'decision signal'
      });
    }

    if (lower.includes('todo:') || lower.includes('action:') || lower.includes('must ')) {
      const subject = line.replace(/^.*?(todo:\s*|action:\s*|must\s*)/i, '').trim() || line;
      candidates.push({
        key: `todo.${slugify(subject)}`,
        value: line,
        tags: [...baseTags, source, 'todo'],
        confidence: 0.86,
        reason: 'actionable item signal'
      });
    }

    if (lower.includes('error') || lower.includes('failed') || lower.includes('exception')) {
      candidates.push({
        key: `error.${slugify(line)}`,
        value: line,
        tags: [...baseTags, source, 'error'],
        confidence: 0.9,
        reason: 'error signal'
      });
    }

    if (/\bhttps?:\/\//i.test(line)) {
      candidates.push({
        key: `reference.url.${slugify(line)}`,
        value: line,
        tags: [...baseTags, source, 'reference'],
        confidence: 0.8,
        reason: 'url reference signal'
      });
    }

    const configMatch = line.match(/\b([A-Z][A-Z0-9_]{2,})\s*[=:]\s*(.+)$/);
    if (configMatch) {
      candidates.push({
        key: `config.${slugify(configMatch[1])}`,
        value: line,
        tags: [...baseTags, source, 'config'],
        confidence: 0.84,
        reason: 'config/env signal'
      });
    }
  }

  const dedup = new Map<string, MemoryCandidate>();
  for (const candidate of candidates) {
    const existing = dedup.get(candidate.key);
    if (!existing || candidate.confidence > existing.confidence) {
      dedup.set(candidate.key, candidate);
    }
  }

  return Array.from(dedup.values());
}

export const __memoryTestables = {
  slugify,
  buildMemoryCandidates
};

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
    'memory_capture_candidates',
    {
      title: 'Memory Capture Candidates',
      description: `Extract and optionally persist important memory candidates from raw text.
WHEN TO USE:
- After long tool outputs to store decisions/errors/todos automatically
- Before pruning context to avoid losing important details
- For proactive memory capture workflows`,
      inputSchema: {
        text: z.string().describe('Raw text to analyze for memory candidates'),
        source: z.string().optional().describe('Source label for extracted candidates (default: llm)'),
        autoTags: z.array(z.string()).optional().describe('Additional tags to include on all candidates'),
        maxCandidates: z.number().optional().describe('Maximum number of candidates to return/store (default: 10)'),
        dryRun: z.boolean().optional().describe('If true, only preview candidates without persisting')
      }
    },
    async ({ text, source = 'llm', autoTags = [], maxCandidates = 10, dryRun = true }) => {
      const candidates = buildMemoryCandidates(text, source, autoTags).slice(0, maxCandidates);

      if (candidates.length === 0) {
        return {
          content: [{ type: 'text', text: 'No important memory candidates detected' }]
        };
      }

      if (dryRun) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ dryRun: true, count: candidates.length, candidates }, null, 2)
          }]
        };
      }

      const memStore = await getMemoryStore();
      const now = new Date().toISOString();
      const savedKeys: string[] = [];

      for (const candidate of candidates) {
        const existing = memStore.entries[candidate.key];
        memStore.entries[candidate.key] = {
          key: candidate.key,
          value: candidate.value,
          tags: candidate.tags,
          createdAt: existing?.createdAt || now,
          updatedAt: now
        };
        savedKeys.push(candidate.key);
      }

      await saveMemoryStore(memStore);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            dryRun: false,
            savedCount: savedKeys.length,
            savedKeys,
            candidates
          }, null, 2)
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

  server.registerTool(
    'memory_update',
    {
      title: 'Memory Update',
      description: `Partially update an existing memory value (merge objects or replace).
WHEN TO USE:
- To update specific fields in a stored object without losing other data
- To append to existing arrays
- When you only want to modify part of a memory value`,
      inputSchema: {
        key: z.string().describe('Key of memory to update'),
        value: z.unknown().describe('Value to merge/update with'),
        merge: z.boolean().optional().describe('If true, deep merge objects. If false, replace value entirely (default: true)'),
        tags: z.array(z.string()).optional().describe('Update tags (replaces existing tags if provided)')
      }
    },
    async ({ key, value, merge = true, tags }) => {
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
      
      const now = new Date().toISOString();
      
      if (merge && typeof entry.value === 'object' && entry.value !== null && typeof value === 'object' && value !== null) {
        // Deep merge objects
        entry.value = deepMerge(entry.value as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        // Replace value entirely
        entry.value = value;
      }
      
      // Update tags if provided
      if (tags !== undefined) {
        entry.tags = tags;
      }
      
      entry.updatedAt = now;
      await saveMemoryStore(memStore);
      
      return {
        content: [{ 
          type: 'text', 
          text: `Memory updated: "${key}"${merge ? ' (merged)' : ' (replaced)'}${tags !== undefined ? ' (tags updated)' : ''}`
        }]
      };
    }
  );
}
