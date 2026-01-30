#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { initStore } from './storage/file-store.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerSummarizerTools } from './tools/summarizer.js';
import { registerTrackerTools } from './tools/tracker.js';
import { registerCheckpointTools } from './tools/checkpoint.js';
import { registerLoaderTools } from './tools/loader.js';
import { registerSessionTools } from './tools/session.js';
import { registerContextTools } from './tools/context.js';
import { registerPrompts } from './prompts.js';

const SERVER_NAME = 'mcp-context-manager';

function getPackageVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const packagePath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

const SERVER_VERSION = getPackageVersion();

async function main() {
  const contextPath = process.env.MCP_CONTEXT_PATH || path.join(process.cwd(), '.context');
  initStore(contextPath);

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  registerMemoryTools(server);
  registerSummarizerTools(server);
  registerTrackerTools(server);
  registerCheckpointTools(server);
  registerLoaderTools(server);
  registerSessionTools(server);
  registerContextTools(server);
  registerPrompts(server);

  // Log before connecting (MCP uses stdio after connect)
  console.error(`${SERVER_NAME} v${SERVER_VERSION} starting...`);
  console.error(`Context path: ${contextPath}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
