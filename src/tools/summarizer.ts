import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { getStore } from '../storage/file-store.js';

const STORAGE_VERSION = 1;
const MAX_SUMMARIES = parseInt(process.env.MCP_MAX_SUMMARIES || '100', 10);

// Generate unique ID
function generateSummaryId(prefix: string = 'sum'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

interface Summary {
  id: string;
  originalLength: number;
  summaryLength: number;
  keyPoints: string[];
  decisions: string[];
  actionItems: string[];
  context: string;
  createdAt: string;
  sessionId?: string;
}

interface SummaryStore {
  version: number;
  summaries: Summary[];
}

const SUMMARIES_DIR = 'summaries';

async function getSummaryStore(): Promise<SummaryStore> {
  const store = getStore().getSubStore(SUMMARIES_DIR);
  const data = await store.read<SummaryStore>('index.json', { version: STORAGE_VERSION, summaries: [] });
  if (!data.version) data.version = STORAGE_VERSION;
  return data;
}

async function saveSummaryStore(data: SummaryStore): Promise<void> {
  const store = getStore().getSubStore(SUMMARIES_DIR);
  data.version = STORAGE_VERSION;
  // Auto-cleanup old summaries
  if (data.summaries.length > MAX_SUMMARIES) {
    data.summaries = data.summaries.slice(-MAX_SUMMARIES);
  }
  await store.write('index.json', data);
}

function extractKeyPoints(text: string): string[] {
  const points: string[] = [];
  const lines = text.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.match(/^[-*•]\s+/) || trimmed.match(/^\d+\.\s+/)) {
      points.push(trimmed.replace(/^[-*•\d.]+\s*/, ''));
    }
    if (trimmed.toLowerCase().includes('important:') || 
        trimmed.toLowerCase().includes('note:') ||
        trimmed.toLowerCase().includes('key:')) {
      points.push(trimmed);
    }
  }
  
  return points.slice(0, 10);
}

function extractDecisions(text: string): string[] {
  const decisions: string[] = [];
  const patterns = [
    /decided to ([^.]+)/gi,
    /will use ([^.]+)/gi,
    /chose ([^.]+)/gi,
    /agreed on ([^.]+)/gi,
    /decision:\s*([^.\n]+)/gi
  ];
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      decisions.push(match[1].trim());
    }
  }
  
  return [...new Set(decisions)].slice(0, 5);
}

function extractActionItems(text: string): string[] {
  const actions: string[] = [];
  const patterns = [
    /todo:\s*([^.\n]+)/gi,
    /action:\s*([^.\n]+)/gi,
    /need to ([^.]+)/gi,
    /should ([^.]+)/gi,
    /must ([^.]+)/gi,
    /\[ \]\s*([^\n]+)/g
  ];
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      actions.push(match[1].trim());
    }
  }
  
  return [...new Set(actions)].slice(0, 10);
}

function compressText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const important: string[] = [];
  const normal: string[] = [];
  
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (lower.includes('important') || 
        lower.includes('key') || 
        lower.includes('must') ||
        lower.includes('error') ||
        lower.includes('decision')) {
      important.push(sentence.trim());
    } else {
      normal.push(sentence.trim());
    }
  }
  
  let result = important.join(' ');
  for (const sentence of normal) {
    if ((result + ' ' + sentence).length <= maxLength) {
      result += ' ' + sentence;
    }
  }
  
  return result.trim() || text.slice(0, maxLength) + '...';
}

export function registerSummarizerTools(server: McpServer): void {
  server.registerTool(
    'context_summarize',
    {
      title: 'Context Summarize',
      description: `Summarize and compress context/conversation. Extracts key points, decisions, and action items.
WHEN TO USE:
- When context is getting long (>60% used)
- Before checkpoint_save to compress conversation
- To extract key decisions and action items from long text
- When you need to free up context space`,
      inputSchema: {
        text: z.string().describe('Text to summarize'),
        maxLength: z.number().optional().describe('Maximum length for compressed summary (default: 2000)'),
        sessionId: z.string().optional().describe('Session identifier for grouping summaries')
      }
    },
    async ({ text, maxLength = 2000, sessionId }) => {
      const keyPoints = extractKeyPoints(text);
      const decisions = extractDecisions(text);
      const actionItems = extractActionItems(text);
      const compressed = compressText(text, maxLength);
      
      const summary: Summary = {
        id: generateSummaryId('sum'),
        originalLength: text.length,
        summaryLength: compressed.length,
        keyPoints,
        decisions,
        actionItems,
        context: compressed,
        createdAt: new Date().toISOString(),
        sessionId
      };
      
      const store = await getSummaryStore();
      store.summaries.push(summary);
      await saveSummaryStore(store);
      
      const output = {
        id: summary.id,
        compression: `${summary.originalLength} -> ${summary.summaryLength} chars (${Math.round((1 - summary.summaryLength / summary.originalLength) * 100)}% reduced)`,
        keyPoints,
        decisions,
        actionItems,
        summary: compressed
      };
      
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }]
      };
    }
  );

  server.registerTool(
    'context_get_summary',
    {
      title: 'Get Summary',
      description: 'Retrieve a previously saved summary by ID.',
      inputSchema: {
        id: z.string().describe('Summary ID to retrieve')
      }
    },
    async ({ id }) => {
      const store = await getSummaryStore();
      const summary = store.summaries.find(s => s.id === id);
      
      if (!summary) {
        return {
          content: [{ type: 'text', text: `Summary not found: ${id}` }]
        };
      }
      
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }]
      };
    }
  );

  server.registerTool(
    'context_list_summaries',
    {
      title: 'List Summaries',
      description: 'List all saved summaries with metadata.',
      inputSchema: {
        sessionId: z.string().optional().describe('Filter by session ID'),
        limit: z.number().optional().describe('Maximum number of summaries to return (default: 10)')
      }
    },
    async ({ sessionId, limit = 10 }) => {
      const store = await getSummaryStore();
      let summaries = store.summaries;
      
      if (sessionId) {
        summaries = summaries.filter(s => s.sessionId === sessionId);
      }
      
      summaries = summaries.slice(-limit);
      
      const list = summaries.map(s => ({
        id: s.id,
        createdAt: s.createdAt,
        originalLength: s.originalLength,
        summaryLength: s.summaryLength,
        keyPointsCount: s.keyPoints.length,
        decisionsCount: s.decisions.length,
        actionItemsCount: s.actionItems.length,
        sessionId: s.sessionId
      }));
      
      return {
        content: [{ 
          type: 'text', 
          text: list.length > 0 
            ? JSON.stringify(list, null, 2)
            : 'No summaries found'
        }]
      };
    }
  );

  server.registerTool(
    'context_merge_summaries',
    {
      title: 'Merge Summaries',
      description: 'Merge multiple summaries into a single consolidated summary. Useful for combining session history.',
      inputSchema: {
        ids: z.array(z.string()).describe('Summary IDs to merge'),
        maxLength: z.number().optional().describe('Max length for merged summary (default: 4000)')
      }
    },
    async ({ ids, maxLength = 4000 }) => {
      const store = await getSummaryStore();
      const summaries = store.summaries.filter(s => ids.includes(s.id));
      
      if (summaries.length === 0) {
        return {
          content: [{ type: 'text', text: 'No summaries found with provided IDs' }]
        };
      }
      
      const allKeyPoints = [...new Set(summaries.flatMap(s => s.keyPoints))];
      const allDecisions = [...new Set(summaries.flatMap(s => s.decisions))];
      const allActionItems = [...new Set(summaries.flatMap(s => s.actionItems))];
      const combinedContext = summaries.map(s => s.context).join('\n\n---\n\n');
      const compressedContext = compressText(combinedContext, maxLength);
      
      const merged: Summary = {
        id: generateSummaryId('merged'),
        originalLength: summaries.reduce((acc, s) => acc + s.originalLength, 0),
        summaryLength: compressedContext.length,
        keyPoints: allKeyPoints.slice(0, 15),
        decisions: allDecisions.slice(0, 10),
        actionItems: allActionItems.slice(0, 15),
        context: compressedContext,
        createdAt: new Date().toISOString()
      };
      
      store.summaries.push(merged);
      await saveSummaryStore(store);
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            id: merged.id,
            mergedCount: summaries.length,
            compression: `${merged.originalLength} -> ${merged.summaryLength} chars`,
            keyPoints: merged.keyPoints,
            decisions: merged.decisions,
            actionItems: merged.actionItems,
            summary: merged.context
          }, null, 2)
        }]
      };
    }
  );
}
