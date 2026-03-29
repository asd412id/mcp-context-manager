import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { getStore } from '../storage/file-store.js';

// Approximate token count (rough estimate: 1 token ≈ 4 chars for English)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Get all store files and their sizes
async function getStoreStats(basePath: string): Promise<{
  totalSize: number;
  fileCount: number;
  files: Array<{ name: string; size: number; modified: string }>;
}> {
  const stats = {
    totalSize: 0,
    fileCount: 0,
    files: [] as Array<{ name: string; size: number; modified: string }>
  };
  
  async function walkDir(dir: string, prefix: string = '') {
    try {
      const items = await fsp.readdir(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = await fsp.stat(fullPath);
        
        if (stat.isDirectory()) {
          await walkDir(fullPath, path.join(prefix, item));
        } else if (item.endsWith('.json')) {
          stats.totalSize += stat.size;
          stats.fileCount++;
          stats.files.push({
            name: path.join(prefix, item),
            size: stat.size,
            modified: stat.mtime.toISOString()
          });
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
  }
  
  await walkDir(basePath);
  return stats;
}

// Get backup files info
async function getBackupStats(basePath: string): Promise<{
  backupCount: number;
  totalBackupSize: number;
  oldestBackup?: string;
  newestBackup?: string;
}> {
  const stats = {
    backupCount: 0,
    totalBackupSize: 0,
    oldestBackup: undefined as string | undefined,
    newestBackup: undefined as string | undefined
  };
  
  const backupTimes: number[] = [];
  
  async function walkDir(dir: string) {
    try {
      const items = await fsp.readdir(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = await fsp.stat(fullPath);
        
        if (stat.isDirectory()) {
          await walkDir(fullPath);
        } else if (item.endsWith('.bak')) {
          stats.backupCount++;
          stats.totalBackupSize += stat.size;
          backupTimes.push(stat.mtime.getTime());
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }
  
  await walkDir(basePath);
  
  if (backupTimes.length > 0) {
    backupTimes.sort((a, b) => a - b);
    stats.oldestBackup = new Date(backupTimes[0]).toISOString();
    stats.newestBackup = new Date(backupTimes[backupTimes.length - 1]).toISOString();
  }
  
  return stats;
}

interface SmartContextItem {
  id: string;
  text: string;
  source?: string;
  timestamp?: string;
  pinned?: boolean;
}

function summarizeForPrune(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const sentences = text.match(/[^.!?\n]+[.!?]?/g) || [text];
  const important: string[] = [];
  const normal: string[] = [];

  for (const sentenceRaw of sentences) {
    const sentence = sentenceRaw.trim();
    if (!sentence) continue;

    const lower = sentence.toLowerCase();
    if (
      lower.includes('important') ||
      lower.includes('decision') ||
      lower.includes('todo') ||
      lower.includes('error') ||
      lower.includes('must') ||
      lower.includes('action')
    ) {
      important.push(sentence);
    } else {
      normal.push(sentence);
    }
  }

  const compact: string[] = [];
  for (const sentence of [...important, ...normal]) {
    const next = compact.length > 0 ? `${compact.join(' ')} ${sentence}` : sentence;
    if (next.length > maxLength) break;
    compact.push(sentence);
  }

  const summary = compact.join(' ').trim();
  return summary || `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function scoreSmartContextItem(item: SmartContextItem, now: number): { score: number; signals: string[] } {
  const text = item.text || '';
  const lower = text.toLowerCase();
  let score = 0;
  const signals: string[] = [];

  if (item.pinned) {
    score += 1000;
    signals.push('pinned');
  }

  const importantKeywords = ['error', 'bug', 'decision', 'todo', 'must', 'important', 'action', 'requirement', 'blocked'];
  const matchedKeywords = importantKeywords.filter((kw) => lower.includes(kw));
  if (matchedKeywords.length > 0) {
    score += Math.min(28, matchedKeywords.length * 4);
    signals.push(`keywords:${matchedKeywords.join(',')}`);
  }

  if (item.source) {
    const sourceLower = item.source.toLowerCase();
    if (sourceLower.includes('user')) {
      score += 10;
      signals.push('source:user');
    } else if (sourceLower.includes('system')) {
      score += 8;
      signals.push('source:system');
    }
  }

  if (/([a-zA-Z]:\\|\/).+\.[a-z0-9]+/i.test(text)) {
    score += 6;
    signals.push('contains:path');
  }

  if (/\bhttps?:\/\//i.test(text)) {
    score += 5;
    signals.push('contains:url');
  }

  if (text.length > 400) {
    score += 4;
    signals.push('long-context');
  } else if (text.length < 24) {
    score -= 4;
    signals.push('very-short');
  }

  if (item.timestamp) {
    const ts = Date.parse(item.timestamp);
    if (!Number.isNaN(ts)) {
      const ageHours = Math.max(0, (now - ts) / (1000 * 60 * 60));
      const recency = Math.max(0, 20 - Math.floor(ageHours / 2));
      score += recency;
      signals.push(`recency:+${recency}`);
    }
  }

  if (/(^|\s)(ok|thanks|noted|done)(\s|$)/i.test(lower)) {
    score -= 3;
    signals.push('low-signal-chat');
  }

  return { score, signals };
}

function extractPruneMemoryCandidates(text: string): Array<{ keyHint: string; reason: string; value: string }> {
  const candidates: Array<{ keyHint: string; reason: string; value: string }> = [];
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('decision:') || lower.includes('decided to')) {
      candidates.push({ keyHint: 'decision.auto', reason: 'decision-signal', value: line });
    }
    if (lower.includes('todo:') || lower.includes('action:') || lower.includes('must ')) {
      candidates.push({ keyHint: 'todo.auto', reason: 'action-signal', value: line });
    }
    if (lower.includes('error') || lower.includes('failed') || lower.includes('exception')) {
      candidates.push({ keyHint: 'error.auto', reason: 'error-signal', value: line });
    }
    if (/\bhttps?:\/\//i.test(line)) {
      candidates.push({ keyHint: 'reference.url', reason: 'url-signal', value: line });
    }
  }

  return candidates.slice(0, 8);
}

export const __contextTestables = {
  summarizeForPrune,
  scoreSmartContextItem,
  extractPruneMemoryCandidates
};

export function registerContextTools(server: McpServer): void {
  server.registerTool(
    'context_status',
    {
      title: 'Context Status',
      description: `Get current context/token usage estimate and storage statistics.
WHEN TO USE:
- To check if context is getting long (>60% usage suggests compression)
- Before deciding whether to save checkpoint or summarize
- To monitor storage usage`,
      inputSchema: {
        conversationText: z.string().optional().describe('Current conversation text to estimate tokens')
      }
    },
    async ({ conversationText }) => {
      // Get context path from store
      const store = getStore();
      const basePath = store.getBasePath();
      
      // Get store statistics
      const storeStats = await getStoreStats(basePath);
      const backupStats = await getBackupStats(basePath);
      
      // Estimate tokens if conversation provided
      let tokenEstimate = null;
      if (conversationText) {
        const tokens = estimateTokens(conversationText);
        // Assume 128K context window (common for Claude)
        const maxTokens = 128000;
        const usagePercent = Math.round((tokens / maxTokens) * 100);
        
        tokenEstimate = {
          estimatedTokens: tokens,
          maxContextTokens: maxTokens,
          usagePercent,
          recommendation: usagePercent > 60 
            ? 'Consider using context_summarize to compress conversation'
            : usagePercent > 40
              ? 'Context usage moderate, checkpoint recommended if doing complex work'
              : 'Context usage healthy'
        };
      }
      
      const result = {
        storage: {
          path: basePath,
          totalSizeBytes: storeStats.totalSize,
          totalSizeKB: Math.round(storeStats.totalSize / 1024),
          fileCount: storeStats.fileCount,
          files: storeStats.files.slice(0, 20) // Limit to 20 files
        },
        backups: {
          count: backupStats.backupCount,
          totalSizeBytes: backupStats.totalBackupSize,
          totalSizeKB: Math.round(backupStats.totalBackupSize / 1024),
          oldest: backupStats.oldestBackup,
          newest: backupStats.newestBackup
        },
        tokenEstimate,
        config: {
          MCP_MAX_CHECKPOINTS: process.env.MCP_MAX_CHECKPOINTS || '50 (default)',
          MCP_MAX_SUMMARIES: process.env.MCP_MAX_SUMMARIES || '100 (default)',
          MCP_TRACKER_MAX_ENTRIES: process.env.MCP_TRACKER_MAX_ENTRIES || '1000 (default)'
        }
      };
      
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  server.registerTool(
    'context_prune_smart',
    {
      title: 'Smart Context Prune',
      description: `Smart context pruning with relevance scoring, optional summarization, and memory candidate extraction.
WHEN TO USE:
- After processing large batches of context/tool output
- When token pressure is rising and you need to keep only high-signal context
- To generate compact summaries before pruning noisy context`,
      inputSchema: {
        items: z.array(z.object({
          id: z.string().describe('Unique context item identifier'),
          text: z.string().describe('Context content text'),
          source: z.string().optional().describe('Context source (user/tool/system/assistant)'),
          timestamp: z.string().optional().describe('ISO timestamp for recency scoring'),
          pinned: z.boolean().optional().describe('Pinned items are always kept')
        })).describe('Context items to evaluate'),
        mode: z.enum(['hybrid', 'aggressive', 'conservative']).optional().describe('Prune strategy mode (default: hybrid)'),
        maxKeep: z.number().optional().describe('Maximum number of items to keep (default: 8)'),
        summaryMaxLength: z.number().optional().describe('Maximum summary length for compressed entries (default: 240)'),
        memoryCandidateLimit: z.number().optional().describe('Maximum extracted memory candidates (default: 8)')
      }
    },
    async ({ items, mode = 'hybrid', maxKeep = 8, summaryMaxLength = 240, memoryCandidateLimit = 8 }) => {
      if (items.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            mode,
            totalItems: 0,
            keep: [],
            prune: [],
            summaries: [],
            memoryCandidates: []
          }, null, 2) }]
        };
      }

      const now = Date.now();
      const normalizedItems: SmartContextItem[] = items.map((item) => ({
        id: item.id,
        text: item.text,
        source: item.source,
        timestamp: item.timestamp,
        pinned: item.pinned
      }));

      const scored = normalizedItems.map((item) => {
        const { score, signals } = scoreSmartContextItem(item, now);
        return { item, score, signals };
      }).sort((a, b) => b.score - a.score);

      const pinnedItems = scored.filter((entry) => entry.item.pinned);
      const keepBaseByMode = mode === 'aggressive'
        ? Math.max(3, Math.ceil(scored.length * 0.25))
        : mode === 'conservative'
          ? Math.max(5, Math.ceil(scored.length * 0.7))
          : Math.max(4, Math.ceil(scored.length * 0.45));
      const keepTarget = Math.min(scored.length, Math.max(pinnedItems.length, Math.min(maxKeep, keepBaseByMode)));

      const keepSet = new Set<string>();
      for (const pinned of pinnedItems) {
        keepSet.add(pinned.item.id);
      }
      for (const entry of scored) {
        if (keepSet.size >= keepTarget) break;
        keepSet.add(entry.item.id);
      }

      const keep = scored
        .filter((entry) => keepSet.has(entry.item.id))
        .map((entry) => ({
          id: entry.item.id,
          source: entry.item.source,
          score: entry.score,
          pinned: !!entry.item.pinned,
          signals: entry.signals,
          textPreview: summarizeForPrune(entry.item.text, 180)
        }));

      const prunedScored = scored
        .filter((entry) => !keepSet.has(entry.item.id));

      const prune = prunedScored
        .map((entry) => ({
          id: entry.item.id,
          source: entry.item.source,
          score: entry.score,
          signals: entry.signals,
          reason: entry.score < 8 ? 'low-signal' : 'lower-priority',
          textPreview: summarizeForPrune(entry.item.text, 120)
        }));

      const summaries = prunedScored
        .filter((entry) => entry.item.text.length > summaryMaxLength)
        .slice(0, 12)
        .map((entry) => ({
          id: entry.item.id,
          source: entry.item.source,
          originalLength: entry.item.text.length,
          summary: summarizeForPrune(entry.item.text, summaryMaxLength)
        }));

      const memoryCandidates = prunedScored
        .flatMap((entry) => extractPruneMemoryCandidates(entry.item.text))
        .slice(0, memoryCandidateLimit);

      const output = {
        mode,
        strategy: {
          totalItems: scored.length,
          keepTarget,
          kept: keep.length,
          pruned: prune.length
        },
        keep,
        prune,
        summaries,
        memoryCandidates,
        recommendation: prune.length > 0
          ? 'Prune listed low-signal items and persist memoryCandidates via memory_set or memory_capture_candidates'
          : 'No prune needed; current context is already high-signal'
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }]
      };
    }
  );

  server.registerTool(
    'store_health',
    {
      title: 'Store Health',
      description: `Check health of the context store - file integrity, backup status, and recommendations.
WHEN TO USE:
- Periodically to ensure data integrity
- After errors or crashes
- Before important operations`,
      inputSchema: {}
    },
    async () => {
      const store = getStore();
      const basePath = store.getBasePath();
      
      const issues: string[] = [];
      const recommendations: string[] = [];
      
      // Check main files exist and are valid JSON
      const mainFiles = ['memory.json', 'tracker.json'];
      for (const file of mainFiles) {
        const filePath = path.join(basePath, file);
        try {
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            JSON.parse(content);
          }
        } catch (error) {
          issues.push(`${file}: Invalid JSON or corrupted - ${(error as Error).message}`);
        }
      }
      
      // Check subdirectories
      const subdirs = ['checkpoints', 'summaries'];
      for (const subdir of subdirs) {
        const dirPath = path.join(basePath, subdir);
        try {
          if (fs.existsSync(dirPath)) {
            const indexPath = path.join(dirPath, 'index.json');
            if (fs.existsSync(indexPath)) {
              const content = fs.readFileSync(indexPath, 'utf-8');
              JSON.parse(content);
            }
          }
        } catch (error) {
          issues.push(`${subdir}/index.json: Invalid JSON - ${(error as Error).message}`);
        }
      }
      
      // Get stats
      const storeStats = await getStoreStats(basePath);
      const backupStats = await getBackupStats(basePath);
      
      // Generate recommendations
      if (storeStats.totalSize > 10 * 1024 * 1024) { // > 10MB
        recommendations.push('Store size is large (>10MB). Consider running tracker_cleanup and clearing old checkpoints.');
      }
      
      if (backupStats.backupCount === 0) {
        recommendations.push('No backups found. Backups are created automatically on writes.');
      } else if (backupStats.backupCount > 50) {
        recommendations.push(`Many backup files (${backupStats.backupCount}). This is normal but takes space.`);
      }
      
      const health = {
        status: issues.length === 0 ? 'healthy' : 'issues_found',
        issues,
        recommendations,
        stats: {
          totalSizeKB: Math.round(storeStats.totalSize / 1024),
          fileCount: storeStats.fileCount,
          backupCount: backupStats.backupCount,
          backupSizeKB: Math.round(backupStats.totalBackupSize / 1024)
        }
      };
      
      return {
        content: [{ type: 'text', text: JSON.stringify(health, null, 2) }]
      };
    }
  );
}
