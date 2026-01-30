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

// Get all memories with values (for handoff)
async function getMemoriesWithValues(): Promise<Array<{ key: string; value: unknown; tags: string[] }>> {
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
  
  return Object.values(memStore.entries)
    .filter(e => {
      if (!e.ttl) return true;
      const expiresAt = new Date(e.updatedAt).getTime() + e.ttl;
      return Date.now() <= expiresAt;
    })
    .map(e => ({ key: e.key, value: e.value, tags: e.tags }));
}

// Get latest summary
async function getLatestSummary(): Promise<{ id: string; context: string; keyPoints: string[]; decisions: string[]; actionItems: string[] } | null> {
  const store = getStore().getSubStore('summaries');
  const data = await store.read<{ summaries: Array<{ id: string; context: string; keyPoints: string[]; decisions: string[]; actionItems: string[] }> }>('index.json', { summaries: [] });
  
  if (data.summaries.length === 0) return null;
  return data.summaries[data.summaries.length - 1];
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

  server.registerTool(
    'session_handoff',
    {
      title: 'Session Handoff',
      description: `Generate a compact handoff document for starting a new session.
WHEN TO USE:
- When context is getting long (>50% used)
- Before starting a new conversation
- To create a portable summary of current work state
Returns: Markdown document with all essential context for seamless continuation.`,
      inputSchema: {
        includeMemoryValues: z.boolean().optional().describe('Include full memory values (default: true)'),
        customNotes: z.string().optional().describe('Additional notes to include in handoff')
      }
    },
    async ({ includeMemoryValues = true, customNotes }) => {
      const workingDir = process.cwd();
      
      // Gather all context in parallel
      const [checkpoint, tracker, memories, memoriesWithValues, latestSummary, project] = await Promise.all([
        getCheckpointLatest(),
        getTrackerStatus(),
        getMemoryList(),
        includeMemoryValues ? getMemoriesWithValues() : Promise.resolve([]),
        getLatestSummary(),
        Promise.resolve(detectProject(workingDir))
      ]);
      
      const cp = checkpoint as { name?: string; description?: string; state?: Record<string, unknown>; files?: string[] } | null;
      const tr = tracker as { 
        projectName?: string; 
        pendingTodos?: Array<{ content: string }>; 
        recentChanges?: Array<{ content: string }>;
        decisions?: Array<{ content: string }>;
      };
      
      // Build compact markdown handoff document
      let md = `# Session Handoff\n\n`;
      md += `**Generated:** ${new Date().toISOString()}\n`;
      md += `**Project:** ${project?.name || 'Unknown'} (${project?.type || 'unknown'})\n`;
      md += `**Path:** ${workingDir}\n\n`;
      
      // Current state from checkpoint
      if (cp) {
        md += `## Current State\n`;
        md += `**Checkpoint:** ${cp.name}\n`;
        if (cp.description) md += `**Description:** ${cp.description}\n`;
        if (cp.state) {
          const state = cp.state;
          if (state.currentTask) md += `**Current Task:** ${state.currentTask}\n`;
          if (state.progress) md += `**Progress:** ${state.progress}\n`;
        }
        if (cp.files && cp.files.length > 0) {
          md += `**Modified Files:** ${cp.files.join(', ')}\n`;
        }
        md += `\n`;
      }
      
      // Pending todos
      if (tr.pendingTodos && tr.pendingTodos.length > 0) {
        md += `## Pending Tasks\n`;
        for (const todo of tr.pendingTodos) {
          md += `- [ ] ${todo.content}\n`;
        }
        md += `\n`;
      }
      
      // Recent decisions
      if (tr.decisions && tr.decisions.length > 0) {
        md += `## Recent Decisions\n`;
        for (const d of tr.decisions) {
          md += `- ${d.content}\n`;
        }
        md += `\n`;
      }
      
      // Recent changes
      if (tr.recentChanges && tr.recentChanges.length > 0) {
        md += `## Recent Changes\n`;
        for (const c of tr.recentChanges) {
          md += `- ${c.content}\n`;
        }
        md += `\n`;
      }
      
      // Key memories
      if (includeMemoryValues && memoriesWithValues.length > 0) {
        md += `## Key Information (Memories)\n`;
        md += `\`\`\`json\n`;
        const memObj: Record<string, unknown> = {};
        for (const m of memoriesWithValues) {
          memObj[m.key] = m.value;
        }
        md += JSON.stringify(memObj, null, 2);
        md += `\n\`\`\`\n\n`;
      } else if (Array.isArray(memories) && memories.length > 0) {
        md += `## Stored Memories\n`;
        md += `Keys: ${(memories as Array<{ key: string }>).map(m => m.key).join(', ')}\n\n`;
      }
      
      // Latest summary context
      if (latestSummary) {
        md += `## Previous Session Summary\n`;
        if (latestSummary.keyPoints.length > 0) {
          md += `**Key Points:**\n`;
          for (const p of latestSummary.keyPoints.slice(0, 5)) {
            md += `- ${p}\n`;
          }
        }
        if (latestSummary.actionItems.length > 0) {
          md += `**Action Items:**\n`;
          for (const a of latestSummary.actionItems.slice(0, 5)) {
            md += `- ${a}\n`;
          }
        }
        md += `\n`;
      }
      
      // Custom notes
      if (customNotes) {
        md += `## Notes\n${customNotes}\n\n`;
      }
      
      // Instructions for new session
      md += `---\n`;
      md += `## To Continue\n`;
      md += `1. Start new session\n`;
      md += `2. Call \`session_init()\` to load full context\n`;
      md += `3. Use this handoff as reference for current state\n`;
      
      return {
        content: [{ type: 'text', text: md }]
      };
    }
  );
}
