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
      const basePath = (store as unknown as { basePath: string }).basePath;
      
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
      const basePath = (store as unknown as { basePath: string }).basePath;
      
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
