import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

// Safe glob pattern to regex - escapes special chars except *
function safeGlobToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regexPattern = '^' + escaped.replace(/\*/g, '.*') + '$';
  return new RegExp(regexPattern, 'i');
}

// Validate regex pattern to prevent ReDoS attacks
const MAX_PATTERN_LENGTH = 200;
const DANGEROUS_PATTERNS = [
  /(\+\+|\*\*|\{\d+,\d*\}\+|\{\d+,\d*\}\*)/,  // Nested quantifiers
  /\([^)]*\)\+\+|\([^)]*\)\*\*/,              // Grouped nested quantifiers
];

function validateRegexPattern(pattern: string): { valid: boolean; error?: string } {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, error: `Pattern too long (max ${MAX_PATTERN_LENGTH} chars)` };
  }
  
  for (const dangerous of DANGEROUS_PATTERNS) {
    if (dangerous.test(pattern)) {
      return { valid: false, error: 'Pattern contains potentially dangerous constructs' };
    }
  }
  
  // Test compile with timeout simulation (basic check)
  try {
    new RegExp(pattern);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: `Invalid regex: ${(e as Error).message}` };
  }
}

interface FileSection {
  startLine: number;
  endLine: number;
  content: string;
}

interface FileInfo {
  path: string;
  exists: boolean;
  size?: number;
  lines?: number;
  extension?: string;
  modifiedAt?: string;
}

function readFileLines(filePath: string, startLine: number, endLine: number): FileSection | null {
  if (!fs.existsSync(filePath)) return null;
  
  // Validate line range
  if (startLine < 1) startLine = 1;
  if (endLine < startLine) endLine = startLine;
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    
    return {
      startLine: start + 1,
      endLine: end,
      content: lines.slice(start, end).join('\n')
    };
  } catch (error) {
    console.error(`[Loader] Error reading file ${filePath}:`, (error as Error).message);
    return null;
  }
}

function getFileInfo(filePath: string): FileInfo {
  const info: FileInfo = {
    path: filePath,
    exists: fs.existsSync(filePath)
  };
  
  if (info.exists) {
    try {
      const stats = fs.statSync(filePath);
      info.size = stats.size;
      info.modifiedAt = stats.mtime.toISOString();
      info.extension = path.extname(filePath);
      
      // Only count lines for reasonably sized files (< 10MB)
      if (stats.size < 10 * 1024 * 1024) {
        const content = fs.readFileSync(filePath, 'utf-8');
        info.lines = content.split('\n').length;
      }
    } catch (error) {
      console.error(`[Loader] Error getting file info ${filePath}:`, (error as Error).message);
    }
  }
  
  return info;
}

// Extract code structure by reading line by line (memory efficient)
function extractCodeStructureEfficient(filePath: string, extension: string): string[] {
  const structures: string[] = [];
  
  const patterns: Record<string, RegExp[]> = {
    '.ts': [
      /^export\s+(async\s+)?function\s+(\w+)/,
      /^export\s+(const|let|var)\s+(\w+)/,
      /^export\s+(class|interface|type|enum)\s+(\w+)/,
      /^(class|interface|type|enum)\s+(\w+)/,
      /^(async\s+)?function\s+(\w+)/
    ],
    '.js': [
      /^export\s+(async\s+)?function\s+(\w+)/,
      /^export\s+(const|let|var)\s+(\w+)/,
      /^export\s+class\s+(\w+)/,
      /^class\s+(\w+)/,
      /^(async\s+)?function\s+(\w+)/,
      /^(const|let|var)\s+(\w+)\s*=/
    ],
    '.py': [
      /^def\s+(\w+)/,
      /^class\s+(\w+)/,
      /^async\s+def\s+(\w+)/
    ]
  };
  
  const applicablePatterns = patterns[extension] || patterns['.js'];
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      for (const pattern of applicablePatterns) {
        const match = line.match(pattern);
        if (match) {
          structures.push(`L${i + 1}: ${line.substring(0, 80)}${line.length > 80 ? '...' : ''}`);
          break;
        }
      }
    }
  } catch (error) {
    console.error(`[Loader] Error extracting structure from ${filePath}:`, (error as Error).message);
  }
  
  return structures;
}

function findRelevantSections(content: string, keywords: string[]): { line: number; text: string }[] {
  const lines = content.split('\n');
  const results: { line: number; text: string }[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    for (const keyword of keywords) {
      if (line.includes(keyword.toLowerCase())) {
        results.push({ line: i + 1, text: lines[i] });
        break;
      }
    }
  }
  
  return results;
}

function extractCodeStructure(content: string, extension: string): string[] {
  // Kept for backward compatibility, prefer extractCodeStructureEfficient for large files
  const structures: string[] = [];
  const lines = content.split('\n');
  
  const patterns: Record<string, RegExp[]> = {
    '.ts': [
      /^export\s+(async\s+)?function\s+(\w+)/,
      /^export\s+(const|let|var)\s+(\w+)/,
      /^export\s+(class|interface|type|enum)\s+(\w+)/,
      /^(class|interface|type|enum)\s+(\w+)/,
      /^(async\s+)?function\s+(\w+)/
    ],
    '.js': [
      /^export\s+(async\s+)?function\s+(\w+)/,
      /^export\s+(const|let|var)\s+(\w+)/,
      /^export\s+class\s+(\w+)/,
      /^class\s+(\w+)/,
      /^(async\s+)?function\s+(\w+)/,
      /^(const|let|var)\s+(\w+)\s*=/
    ],
    '.py': [
      /^def\s+(\w+)/,
      /^class\s+(\w+)/,
      /^async\s+def\s+(\w+)/
    ]
  };
  
  const applicablePatterns = patterns[extension] || patterns['.js'];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    for (const pattern of applicablePatterns) {
      const match = line.match(pattern);
      if (match) {
        structures.push(`L${i + 1}: ${line.substring(0, 80)}${line.length > 80 ? '...' : ''}`);
        break;
      }
    }
  }
  
  return structures;
}

// Check if path is a symlink and get real path
async function resolveSymlink(filePath: string): Promise<{ isSymlink: boolean; realPath: string }> {
  try {
    const stats = await fsp.lstat(filePath);
    if (stats.isSymbolicLink()) {
      const realPath = await fsp.realpath(filePath);
      return { isSymlink: true, realPath };
    }
    return { isSymlink: false, realPath: filePath };
  } catch {
    return { isSymlink: false, realPath: filePath };
  }
}

export function registerLoaderTools(server: McpServer): void {
  server.registerTool(
    'file_smart_read',
    {
      title: 'Smart File Read',
      description: `Read a file with smart options: specific lines, keyword search, or structure extraction.
WHEN TO USE:
- For large files (>200 lines): use structureOnly:true first to see outline
- To find specific code: use keywords:["functionName", "className"]
- For partial reads: use startLine/endLine
- Saves context vs reading entire file`,
      inputSchema: {
        path: z.string().describe('File path to read'),
        startLine: z.number().optional().describe('Start line (1-indexed)'),
        endLine: z.number().optional().describe('End line'),
        keywords: z.array(z.string()).optional().describe('Only return lines containing these keywords'),
        structureOnly: z.boolean().optional().describe('Return only code structure (functions, classes, etc.)'),
        maxLines: z.number().optional().describe('Maximum lines to return (default: 500)')
      }
    },
    async ({ path: filePath, startLine, endLine, keywords, structureOnly, maxLines = 500 }) => {
      const info = getFileInfo(filePath);
      
      if (!info.exists) {
        return {
          content: [{ type: 'text', text: `File not found: ${filePath}` }]
        };
      }
      
      // For structureOnly, use efficient extraction without loading full content
      if (structureOnly && info.extension) {
        const structure = extractCodeStructureEfficient(filePath, info.extension);
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              file: filePath,
              totalLines: info.lines,
              structure: structure
            }, null, 2)
          }]
        };
      }
      
      const content = fs.readFileSync(filePath, 'utf-8');
      
      if (keywords && keywords.length > 0) {
        const sections = findRelevantSections(content, keywords);
        const limited = sections.slice(0, maxLines);
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              file: filePath,
              totalLines: info.lines,
              matchedLines: sections.length,
              matches: limited
            }, null, 2)
          }]
        };
      }
      
      if (startLine || endLine) {
        const start = startLine || 1;
        const end = endLine || (info.lines || 1000);
        const section = readFileLines(filePath, start, Math.min(end, start + maxLines - 1));
        
        if (section) {
          return {
            content: [{ 
              type: 'text', 
              text: `File: ${filePath} (lines ${section.startLine}-${section.endLine} of ${info.lines})\n\n${section.content}`
            }]
          };
        }
      }
      
      const lines = content.split('\n');
      const limitedContent = lines.slice(0, maxLines).join('\n');
      const truncated = lines.length > maxLines;
      
      return {
        content: [{ 
          type: 'text', 
          text: `File: ${filePath} (${info.lines} lines${truncated ? `, showing first ${maxLines}` : ''})\n\n${limitedContent}${truncated ? '\n\n... [truncated]' : ''}`
        }]
      };
    }
  );

  server.registerTool(
    'file_info',
    {
      title: 'File Info',
      description: `Get file metadata without reading content.
WHEN TO USE:
- Before reading to check if file exists
- To check file size before deciding read strategy
- To see modification time`,
      inputSchema: {
        paths: z.array(z.string()).describe('File paths to check')
      }
    },
    async ({ paths }) => {
      const infos = paths.map(p => getFileInfo(p));
      
      return {
        content: [{ type: 'text', text: JSON.stringify(infos, null, 2) }]
      };
    }
  );

  server.registerTool(
    'file_search_content',
    {
      title: 'Search File Content',
      description: 'Search for patterns in a file and return matching lines with context.',
      inputSchema: {
        path: z.string().describe('File path to search'),
        pattern: z.string().describe('Search pattern (supports regex)'),
        contextLines: z.number().optional().describe('Number of context lines before/after match (default: 2)')
      }
    },
    async ({ path: filePath, pattern, contextLines = 2 }) => {
      try {
        await fsp.access(filePath);
      } catch {
        return {
          content: [{ type: 'text', text: `File not found: ${filePath}` }]
        };
      }
      
      const content = await fsp.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      
      // Validate regex pattern for security
      const validation = validateRegexPattern(pattern);
      if (!validation.valid) {
        return {
          content: [{ type: 'text', text: `Invalid pattern: ${validation.error}` }]
        };
      }
      
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'gi');
      } catch {
        return {
          content: [{ type: 'text', text: `Invalid regex pattern: "${pattern}"` }]
        };
      }
      
      const matches: { line: number; match: string; context: string[] }[] = [];
      
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length, i + contextLines + 1);
          const context = lines.slice(start, end).map((l, idx) => 
            `${start + idx + 1}${start + idx === i ? '>' : ':'} ${l}`
          );
          
          matches.push({
            line: i + 1,
            match: lines[i],
            context
          });
          
          regex.lastIndex = 0;
        }
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: matches.length > 0
            ? JSON.stringify({ file: filePath, matches }, null, 2)
            : `No matches found for pattern "${pattern}" in ${filePath}`
        }]
      };
    }
  );

  server.registerTool(
    'file_list_dir',
    {
      title: 'List Directory',
      description: 'List files in a directory with optional filtering.',
      inputSchema: {
        path: z.string().describe('Directory path'),
        pattern: z.string().optional().describe('File name pattern (e.g., "*.ts")'),
        recursive: z.boolean().optional().describe('Include subdirectories (default: false)')
      }
    },
    async ({ path: dirPath, pattern, recursive = false }) => {
      try {
        await fsp.access(dirPath);
      } catch {
        return {
          content: [{ type: 'text', text: `Directory not found: ${dirPath}` }]
        };
      }
      
      const results: string[] = [];
      const patternRegex = pattern ? safeGlobToRegex(pattern) : null;
      const visitedPaths = new Set<string>(); // Track visited paths to prevent cycles
      const MAX_DEPTH = 20; // Prevent excessive recursion
      
      async function walkDir(dir: string, depth: number = 0) {
        if (depth > MAX_DEPTH) {
          console.warn(`[Loader] Max depth reached at ${dir}`);
          return;
        }
        
        // Resolve symlinks and check for cycles
        const resolved = await resolveSymlink(dir);
        if (visitedPaths.has(resolved.realPath)) {
          return; // Skip already visited paths (cycle detection)
        }
        visitedPaths.add(resolved.realPath);
        
        try {
          const items = await fsp.readdir(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            
            try {
              const stat = await fsp.stat(fullPath);
              
              if (stat.isDirectory() && recursive) {
                await walkDir(fullPath, depth + 1);
              } else if (stat.isFile()) {
                if (patternRegex) {
                  if (patternRegex.test(item)) {
                    results.push(fullPath);
                  }
                } else {
                  results.push(fullPath);
                }
              }
            } catch (error) {
              // Skip files/dirs we can't access
              console.warn(`[Loader] Cannot access ${fullPath}:`, (error as Error).message);
            }
          }
        } catch (error) {
          console.error(`[Loader] Error reading directory ${dir}:`, (error as Error).message);
        }
      }
      
      await walkDir(dirPath);
      
      return {
        content: [{ 
          type: 'text', 
          text: results.length > 0 
            ? results.join('\n')
            : 'No files found'
        }]
      };
    }
  );
}
