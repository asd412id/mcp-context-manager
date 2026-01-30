import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { getStore } from '../storage/file-store.js';

const STORAGE_VERSION = 1;
const MAX_CHECKPOINTS = parseInt(process.env.MCP_MAX_CHECKPOINTS || '50', 10);

interface Checkpoint {
  id: string;
  name: string;
  description?: string;
  state: Record<string, unknown>;
  files: string[];
  createdAt: string;
}

interface CheckpointStore {
  version: number;
  checkpoints: Checkpoint[];
}

const CHECKPOINTS_DIR = 'checkpoints';

async function getCheckpointStore(): Promise<CheckpointStore> {
  const store = getStore().getSubStore(CHECKPOINTS_DIR);
  const data = await store.read<CheckpointStore>('index.json', { version: STORAGE_VERSION, checkpoints: [] });
  if (!data.version) data.version = STORAGE_VERSION;
  return data;
}

async function saveCheckpointStore(data: CheckpointStore): Promise<void> {
  const store = getStore().getSubStore(CHECKPOINTS_DIR);
  data.version = STORAGE_VERSION;
  await store.write('index.json', data);
}

async function saveCheckpointData(id: string, data: Record<string, unknown>): Promise<void> {
  const store = getStore().getSubStore(CHECKPOINTS_DIR);
  await store.write(`${id}.json`, data);
}

async function loadCheckpointData(id: string): Promise<Record<string, unknown> | null> {
  const store = getStore().getSubStore(CHECKPOINTS_DIR);
  if (await store.exists(`${id}.json`)) {
    return store.read<Record<string, unknown>>(`${id}.json`, {});
  }
  return null;
}

export function registerCheckpointTools(server: McpServer): void {
  server.registerTool(
    'checkpoint_save',
    {
      title: 'Save Checkpoint',
      description: `Save current session state as a checkpoint.
WHEN TO USE:
- Every 10-15 messages in long conversations
- Before major refactoring or risky changes
- At important milestones (feature complete, bug fixed)
- Before context gets too long (>60% used)
- When ending a work session`,
      inputSchema: {
        name: z.string().describe('Checkpoint name (e.g., "before-refactor", "feature-complete")'),
        description: z.string().optional().describe('Description of what was accomplished'),
        state: z.record(z.unknown()).describe('State data to save (conversation summary, current task, etc.)'),
        files: z.array(z.string()).optional().describe('List of relevant file paths')
      }
    },
    async ({ name, description, state, files }) => {
      const checkpointStore = await getCheckpointStore();
      
      const checkpoint: Checkpoint = {
        id: `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        description,
        state,
        files: files || [],
        createdAt: new Date().toISOString()
      };
      
      await saveCheckpointData(checkpoint.id, state);
      checkpointStore.checkpoints.push({
        ...checkpoint,
        state: {} 
      });
      
      // Auto-cleanup old checkpoints
      if (checkpointStore.checkpoints.length > MAX_CHECKPOINTS) {
        const store = getStore().getSubStore(CHECKPOINTS_DIR);
        const toRemove = checkpointStore.checkpoints.splice(0, checkpointStore.checkpoints.length - MAX_CHECKPOINTS);
        // Delete old checkpoint data files
        for (const cp of toRemove) {
          await store.delete(`${cp.id}.json`).catch(() => {});
        }
      }
      
      await saveCheckpointStore(checkpointStore);
      
      return {
        content: [{ 
          type: 'text', 
          text: `Checkpoint saved: "${name}" (ID: ${checkpoint.id})\nDescription: ${description || 'N/A'}\nFiles: ${files?.length || 0}`
        }]
      };
    }
  );

  server.registerTool(
    'checkpoint_load',
    {
      title: 'Load Checkpoint',
      description: `Load a previously saved checkpoint to restore context.
WHEN TO USE:
- At session start (or use session_init instead)
- To restore to a specific point in time
- After context reset to recover previous work`,
      inputSchema: {
        id: z.string().optional().describe('Checkpoint ID (loads latest if not specified)'),
        name: z.string().optional().describe('Checkpoint name to search for')
      }
    },
    async ({ id, name }) => {
      const checkpointStore = await getCheckpointStore();
      
      let checkpoint: Checkpoint | undefined;
      
      if (id) {
        checkpoint = checkpointStore.checkpoints.find(cp => cp.id === id);
      } else if (name) {
        checkpoint = checkpointStore.checkpoints
          .filter(cp => cp.name.toLowerCase().includes(name.toLowerCase()))
          .pop();
      } else {
        checkpoint = checkpointStore.checkpoints[checkpointStore.checkpoints.length - 1];
      }
      
      if (!checkpoint) {
        return {
          content: [{ type: 'text', text: 'Checkpoint not found' }]
        };
      }
      
      const stateData = await loadCheckpointData(checkpoint.id);
      
      const output = {
        id: checkpoint.id,
        name: checkpoint.name,
        description: checkpoint.description,
        createdAt: checkpoint.createdAt,
        files: checkpoint.files,
        state: stateData
      };
      
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }]
      };
    }
  );

  server.registerTool(
    'checkpoint_list',
    {
      title: 'List Checkpoints',
      description: 'List all saved checkpoints.',
      inputSchema: {
        limit: z.number().optional().describe('Maximum checkpoints to return (default: 10)')
      }
    },
    async ({ limit = 10 }) => {
      const checkpointStore = await getCheckpointStore();
      const checkpoints = checkpointStore.checkpoints.slice(-limit);
      
      if (checkpoints.length === 0) {
        return {
          content: [{ type: 'text', text: 'No checkpoints saved' }]
        };
      }
      
      const list = checkpoints.map(cp => ({
        id: cp.id,
        name: cp.name,
        description: cp.description,
        createdAt: cp.createdAt,
        filesCount: cp.files.length
      }));
      
      return {
        content: [{ type: 'text', text: JSON.stringify(list, null, 2) }]
      };
    }
  );

  server.registerTool(
    'checkpoint_delete',
    {
      title: 'Delete Checkpoint',
      description: 'Delete a checkpoint by ID.',
      inputSchema: {
        id: z.string().describe('Checkpoint ID to delete')
      }
    },
    async ({ id }) => {
      const checkpointStore = await getCheckpointStore();
      const index = checkpointStore.checkpoints.findIndex(cp => cp.id === id);
      
      if (index === -1) {
        return {
          content: [{ type: 'text', text: `Checkpoint not found: ${id}` }]
        };
      }
      
      const removed = checkpointStore.checkpoints.splice(index, 1)[0];
      await saveCheckpointStore(checkpointStore);
      
      const store = getStore().getSubStore(CHECKPOINTS_DIR);
      await store.delete(`${id}.json`);
      
      return {
        content: [{ type: 'text', text: `Deleted checkpoint: "${removed.name}" (${id})` }]
      };
    }
  );

  server.registerTool(
    'checkpoint_compare',
    {
      title: 'Compare Checkpoints',
      description: 'Compare two checkpoints to see what changed.',
      inputSchema: {
        id1: z.string().describe('First checkpoint ID'),
        id2: z.string().describe('Second checkpoint ID')
      }
    },
    async ({ id1, id2 }) => {
      const checkpointStore = await getCheckpointStore();
      
      const cp1 = checkpointStore.checkpoints.find(cp => cp.id === id1);
      const cp2 = checkpointStore.checkpoints.find(cp => cp.id === id2);
      
      if (!cp1 || !cp2) {
        return {
          content: [{ type: 'text', text: 'One or both checkpoints not found' }]
        };
      }
      
      const state1 = await loadCheckpointData(id1) || {};
      const state2 = await loadCheckpointData(id2) || {};
      
      const allKeys = new Set([...Object.keys(state1), ...Object.keys(state2)]);
      const changes: { key: string; change: string }[] = [];
      
      for (const key of allKeys) {
        const hasKey1 = Object.prototype.hasOwnProperty.call(state1, key);
        const hasKey2 = Object.prototype.hasOwnProperty.call(state2, key);
        const v1 = hasKey1 ? JSON.stringify(state1[key]) : undefined;
        const v2 = hasKey2 ? JSON.stringify(state2[key]) : undefined;
        
        if (v1 !== v2) {
          if (!hasKey1) {
            changes.push({ key, change: 'added' });
          } else if (!hasKey2) {
            changes.push({ key, change: 'removed' });
          } else {
            changes.push({ key, change: 'modified' });
          }
        }
      }
      
      const newFiles = cp2.files.filter(f => !cp1.files.includes(f));
      const removedFiles = cp1.files.filter(f => !cp2.files.includes(f));
      
      const comparison = {
        checkpoint1: { id: cp1.id, name: cp1.name, date: cp1.createdAt },
        checkpoint2: { id: cp2.id, name: cp2.name, date: cp2.createdAt },
        stateChanges: changes,
        fileChanges: {
          added: newFiles,
          removed: removedFiles
        }
      };
      
      return {
        content: [{ type: 'text', text: JSON.stringify(comparison, null, 2) }]
      };
    }
  );
}
