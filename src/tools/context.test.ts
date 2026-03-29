import test from 'node:test';
import assert from 'node:assert/strict';
import { __contextTestables } from './context.js';

test('summarizeForPrune respects max length and keeps key sentence', () => {
  const text = [
    'This is regular background sentence.',
    'Decision: use smart prune scoring for noisy outputs.',
    'Another long detail to fill space and trigger compression behavior.'
  ].join(' ');

  const summary = __contextTestables.summarizeForPrune(text, 80);
  assert.ok(summary.length <= 80);
  assert.ok(summary.toLowerCase().includes('decision'));
});

test('scoreSmartContextItem gives higher score for pinned/important content', () => {
  const now = Date.now();
  const high = __contextTestables.scoreSmartContextItem(
    {
      id: 'a',
      text: 'Important decision: must fix error in src/tools/context.ts',
      source: 'user',
      timestamp: new Date(now).toISOString(),
      pinned: true
    },
    now
  );

  const low = __contextTestables.scoreSmartContextItem(
    {
      id: 'b',
      text: 'ok thanks',
      source: 'assistant',
      timestamp: new Date(now - 1000 * 60 * 60 * 48).toISOString()
    },
    now
  );

  assert.ok(high.score > low.score);
  assert.ok(high.signals.includes('pinned'));
});

test('extractPruneMemoryCandidates extracts decision/todo/error/url signals', () => {
  const candidates = __contextTestables.extractPruneMemoryCandidates([
    'Decision: Use hybrid mode for prune.',
    'TODO: add tests for memory capture.',
    'Error: build failed in CI.',
    'Reference: https://example.com/docs'
  ].join('\n'));

  const reasons = candidates.map((c) => c.reason);
  assert.ok(reasons.includes('decision-signal'));
  assert.ok(reasons.includes('action-signal'));
  assert.ok(reasons.includes('error-signal'));
  assert.ok(reasons.includes('url-signal'));
});
