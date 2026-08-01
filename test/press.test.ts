import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mechanicalPress, normalizeLine } from '../src/press/mechanical.js';
import { saliencePress, scoreLine } from '../src/press/salience.js';
import { press } from '../src/press/press.js';
import { Store } from '../src/store/store.js';
import { countTokens } from '../src/press/tokens.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dream-test-'));
  return { store: new Store(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('normalizeLine strips volatile parts', () => {
  const a = normalizeLine('2026-08-01T10:00:00.123Z GET /api/x 200 12ms id=deadbeefcafebabe');
  const b = normalizeLine('2026-08-01T10:05:33.987Z GET /api/x 200 340ms id=0123456789abcdef');
  assert.equal(a, b);
});

test('mechanical press collapses repetitive logs >90%', () => {
  const lines: string[] = [];
  for (let i = 0; i < 500; i++) {
    lines.push(`2026-08-01T10:00:${String(i % 60).padStart(2, '0')}.000Z INFO worker heartbeat ok latency=${i}ms seq=${100000 + i}`);
  }
  lines.push('ERROR disk full on /var/data');
  const text = lines.join('\n');
  const pressed = mechanicalPress(text);
  assert.ok(pressed.length < text.length * 0.1, `expected >90% shrink, got ${pressed.length}/${text.length}`);
  assert.ok(pressed.includes('ERROR disk full'), 'unique line must survive');
  assert.ok(/\(\+498 more similar lines\)/.test(pressed), 'suppression count present');
});

test('mechanical press is deterministic', () => {
  const text = 'a 1ms\nb 2ms\na 3ms\na 4ms\nc';
  assert.equal(mechanicalPress(text), mechanicalPress(text));
});

test('salience keeps decision and human lines over stack frames', () => {
  assert.ok(scoreLine('[user] we decided to use SQLite because of the volume') > scoreLine('    at Object.<anonymous> (/app/x.js:1:1)'));
  const text = [
    '[user] the deadline is 2026-09-01 and the budget is 4500 USD',
    '    at foo (/app/node_modules/x.js:10:5)',
    '    at bar (/app/node_modules/y.js:22:8)',
    '    at baz (/app/node_modules/z.js:31:2)',
    '[assistant] I chose approach B instead of A because of memory limits',
    'random filler line without much going on here at all',
    '    at qux (/app/node_modules/w.js:44:4)',
    '    at quux (/app/node_modules/v.js:50:1)',
  ].join('\n');
  const pressed = saliencePress(text, 0.3);
  assert.ok(pressed.includes('deadline'));
  assert.ok(pressed.includes('chose approach B'));
  assert.ok(!pressed.includes('at qux'));
});

test('press caches by content: same text presses once', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const text = Array.from({ length: 50 }, (_, i) => `log line ${i}ms repeated stuff`).join('\n');
    const r1 = await press(store, text, 1, { ns: 'c1' });
    const r2 = await press(store, text, 1, { ns: 'c1' });
    assert.equal(r1.cached, false);
    assert.equal(r2.cached, true);
    assert.equal(r1.block.id, r2.block.id);
    assert.equal(r1.block.id, `t1-${r1.block.id.split('-')[1]}`);
  } finally {
    cleanup();
  }
});

test('press reports stopped when shrink < 15%', async () => {
  const { store, cleanup } = tmpStore();
  try {
    // Unique high-salience lines: nothing to dedupe, salience keeps most.
    const text = Array.from({ length: 10 }, (_, i) => `fact ${i}: user prefers option ${String.fromCharCode(65 + i)} because reason ${i}`).join('\n');
    const r = await press(store, text, 1, { ns: 'c1' });
    // Mechanical can't shrink unique lines much; expect stopped signal.
    assert.equal(r.stopped, countTokens(r.block.pressed) > countTokens(text) * 0.85);
  } finally {
    cleanup();
  }
});

test('store round-trips blocks and finds by id', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const r = await press(store, 'hello world\nhello world\nhello world\nunique line', 1, { ns: 'convA' });
    const found = store.findBlock(r.block.id);
    assert.ok(found);
    assert.equal(found.original, r.block.original);
    assert.equal(store.findBlock('t1-0000000000000000'), null);
    assert.equal(store.findBlock('../../etc/passwd'), null);
  } finally {
    cleanup();
  }
});

test('store meta and transcript round-trip', () => {
  const { store, cleanup } = tmpStore();
  try {
    store.appendTurns('c1', [{ role: 'user', content: 'hi' }]);
    store.appendTurns('c1', [{ role: 'assistant', content: 'hello' }]);
    const turns = store.readTurns('c1');
    assert.equal(turns.length, 2);
    store.putMeta({
      id: 'c1', ns: 'c1', createdAt: 1, lastSeen: 2, turnCount: 2, turnHashes: ['a', 'b'],
      pressedUpTo: 0, consolidatedUpTo: 0, tierBlocks: {},
    });
    assert.equal(store.getMeta('c1')?.turnCount, 2);
  } finally {
    cleanup();
  }
});
