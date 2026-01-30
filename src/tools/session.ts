import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { getStore } from '../storage/file-store.js';
import { cleanupExpiredMemories } from './memory.js';

interface ProjectInfo {
  name: string;
  type: string;
  path: string;
  detectedFrom: string;
}

interface SessionState {
  checkpoint: unknown;
  tracker: unknown;
  memories: unknown;
  project: ProjectInfo | null;
}

function detectProject(cwd: string): ProjectInfo | null {
  // Try package.json first
  const packageJsonPath = path.join(cwd, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      return {
        name: pkg.name || path.basename(cwd),
        type: pkg.type === 'module' ? 'esm' : 'commonjs',
        path: cwd,
        detectedFrom: 'package.json'
      };
    } catch {
      // ignore parse errors
    }
  }

  // Try .git
  const gitPath = path.join(cwd, '.git');
  if (fs.existsSync(gitPath)) {
    // Try to get repo name from git config
    const gitConfigPath = path.join(gitPath, 'config');
    if (fs.existsSync(gitConfigPath)) {
      try {
        const config = fs.readFileSync(gitConfigPath, 'utf-8');
        const urlMatch = config.match(/url\s*=\s*.*\/([^\/\s]+?)(?:\.git)?$/m);
        if (urlMatch) {
          return {
            name: urlMatch[1],
            type: 'git',
            path: cwd,
            detectedFrom: 'git'
          };
        }
      } catch {
        // ignore
      }
    }
    return {
      name: path.basename(cwd),
      type: 'git',
      path: cwd,
      detectedFrom: 'git-folder'
    };
  }

  // Try pyproject.toml
  const pyprojectPath = path.join(cwd, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const content = fs.readFileSync(pyprojectPath, 'utf-8');
      const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
      return {
        name: nameMatch ? nameMatch[1] : path.basename(cwd),
        type: 'python',
        path: cwd,
        detectedFrom: 'pyproject.toml'
      };
    } catch {
      // ignore
    }
  }

  // Try Cargo.toml (Rust)
  const cargoPath = path.join(cwd, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    try {
      const content = fs.readFileSync(cargoPath, 'utf-8');
      const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
      return {
        name: nameMatch ? nameMatch[1] : path.basename(cwd),
        type: 'rust',
        path: cwd,
        detectedFrom: 'Cargo.toml'
      };
    } catch {
      // ignore
    }
  }

  // Fallback to folder name
  return {
    name: path.basename(cwd),
    type: 'unknown',
    path: cwd,
    detectedFrom: 'folder-name'
  };
}

async function getCheckpointLatest(): Promise<unknown> {
  const store = getStore().getSubStore('checkpoints');
  const index = await store.read<{ checkpoints: Array<{ id: string; name: string; description?: string; createdAt: string; files: string[] }> }>('index.json', { checkpoints: [] });
  
  if (index.checkpoints.length === 0) return null;
  
  const latest = index.checkpoints[index.checkpoints.length - 1];
  const stateData = await store.read<Record<string, unknown>>(`${latest.id}.json`, {});
  
  return {
    id: latest.id,
    name: latest.name,
    description: latest.description,
    createdAt: latest.createdAt,
    files: latest.files,
    state: stateData
  };
}

async function getTrackerStatus(): Promise<unknown> {
  const store = getStore();
  const trackerStore = await store.read<{
    entries: Array<{
      id: string;
      type: string;
      content: string;
      status?: string;
      tags: string[];
      createdAt: string;
    }>;
    projectName?: string;
  }>('tracker.json', { entries: [] });
  
  const entries = trackerStore.entries;
  const limit = 5;
  
  return {
    projectName: trackerStore.projectName,
    totalEntries: entries.length,
    decisions: entries.filter(e => e.type === 'decision').slice(-limit).map(d => ({ id: d.id, content: d.content, date: d.createdAt })),
    pendingTodos: entries.filter(e => e.type === 'todo' && e.status === 'pending').slice(-limit).map(t => ({ id: t.id, content: t.content, tags: t.tags })),
    recentChanges: entries.filter(e => e.type === 'change').slice(-limit).map(c => ({ id: c.id, content: c.content, date: c.createdAt })),
    recentErrors: entries.filter(e => e.type === 'error').slice(-limit).map(e => ({ id: e.id, content: e.content, date: e.createdAt }))
  };
}

async function getMemoryList(): Promise<unknown> {
  const store = getStore();
  const memStore = await store.read<{
    entries: Record<string, {
      key: string;
      value: unknown;
      tags: string[];
      createdAt: string;
      updatedAt: string;
      ttl?: number;
    }>;
  }>('memory.json', { entries: {} });
  
  const entries = Object.values(memStore.entries).filter(e => {
    if (!e.ttl) return true;
    const expiresAt = new Date(e.createdAt).getTime() + e.ttl;
    return Date.now() <= expiresAt;
  });
  
  if (entries.length === 0) return [];
  
  return entries.map(e => ({
    key: e.key,
    tags: e.tags,
    updatedAt: e.updatedAt
  }));
}

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    'session_init',
    {
      title: 'Session Init',
      description: `Initialize session by loading all previous context in ONE call. 
WHEN TO USE: Call this ONCE at the START of every session/conversation.
Returns: latest checkpoint, tracker status (todos/decisions), all memories, and auto-detected project info.
This replaces calling checkpoint_load(), tracker_status(), and memory_list() separately.`,
      inputSchema: {
        cwd: z.string().optional().describe('Current working directory for project detection (defaults to process.cwd())')
      }
    },
    async ({ cwd }) => {
      const workingDir = cwd || process.cwd();
      
      // Cleanup expired memories first
      const cleanedUp = await cleanupExpiredMemories();
      
      const [checkpoint, tracker, memories] = await Promise.all([
        getCheckpointLatest(),
        getTrackerStatus(),
        getMemoryList()
      ]);
      
      const project = detectProject(workingDir);
      
      // Auto-set project name if detected and not already set
      if (project && !(tracker as { projectName?: string })?.projectName) {
        const store = getStore();
        const trackerStore = await store.read<{ entries: unknown[]; projectName?: string }>('tracker.json', { entries: [] });
        trackerStore.projectName = project.name;
        await store.write('tracker.json', trackerStore);
      }
      
      const state: SessionState = {
        checkpoint,
        tracker,
        memories,
        project
      };
      
      const summary = {
        initialized: true,
        project: project ? `${project.name} (${project.type})` : 'unknown',
        hasCheckpoint: !!checkpoint,
        pendingTodos: ((tracker as { pendingTodos?: unknown[] })?.pendingTodos || []).length,
        totalDecisions: ((tracker as { decisions?: unknown[] })?.decisions || []).length,
        memoriesCount: Array.isArray(memories) ? memories.length : 0,
        cleanedUpExpiredMemories: cleanedUp
      };
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            summary,
            ...state
          }, null, 2)
        }]
      };
    }
  );

  server.registerTool(
    'project_detect',
    {
      title: 'Project Detect',
      description: `Auto-detect project information from current directory.
WHEN TO USE: When you need to know what project you're working on.
Detects from: package.json, .git, pyproject.toml, Cargo.toml, or folder name.`,
      inputSchema: {
        cwd: z.string().optional().describe('Directory to detect project from')
      }
    },
    async ({ cwd }) => {
      const workingDir = cwd || process.cwd();
      const project = detectProject(workingDir);
      
      return {
        content: [{ 
          type: 'text', 
          text: project 
            ? JSON.stringify(project, null, 2)
            : 'Could not detect project'
        }]
      };
    }
  );
}
