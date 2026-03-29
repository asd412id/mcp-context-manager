import test from 'node:test';
import assert from 'node:assert/strict';
import { __memoryTestables } from './memory.js';

test('slugify normalizes and trims tokens safely', () => {
  const result = __memoryTestables.slugify('  Decision: Add New Feature!  ');
  assert.equal(result, 'decision-add-new-feature');
});

test('buildMemoryCandidates extracts high-signal candidates with tags', () => {
  const text = [
    'Decision: use memory capture as default.',
    'TODO: improve context pruning.',
    'ERROR: request failed with timeout.',
    'MCP_CONTEXT_PATH=/tmp/context',
    'See docs: https://example.dev/mcp'
  ].join('\n');

  const candidates = __memoryTestables.buildMemoryCandidates(text, 'llm', ['test']);
  const keys = candidates.map((item) => item.key);

  assert.ok(keys.some((key) => key.startsWith('decision.')));
  assert.ok(keys.some((key) => key.startsWith('todo.')));
  assert.ok(keys.some((key) => key.startsWith('error.')));
  assert.ok(keys.some((key) => key.startsWith('config.')));
  assert.ok(keys.some((key) => key.startsWith('reference.url.')));

  for (const candidate of candidates) {
    assert.ok(candidate.tags.includes('test'));
    assert.ok(candidate.tags.includes('llm'));
  }
});
