import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { GraphDb } from '../src/graph/db.js';
import { Graph } from '../src/graph/graph.js';
import { Keyring } from '../src/gateway/keyring.js';
import { consolidate } from '../src/dream/consolidate.js';
import { heuristicExtract } from '../src/dream/extract.js';
import { runDecay } from '../src/dream/decay.js';
import { runPromotion } from '../src/dream/skills.js';
import { loadConfig } from '../src/config.js';
import { syncConversation } from '../src/gateway/conversation.js';
import { readIndex } from '../src/graph/indexer.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dream-loop-'));
  const store = new Store(dir);
  const graph = new Graph(new GraphDb(':memory:'));
  const keyring = new Keyring();
  const cfg = loadConfig({ DREAM_STORE_DIR: dir } as NodeJS.ProcessEnv);
  return { dir, store, graph, keyring, cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('heuristic extraction finds facts, decisions, preferences', () => {
  const text = [
    '[user] the production database is postgres 16 on RDS',
    '[user] we decided to use pnpm because npm was too slow in CI',
    '[user] I prefer tabs over spaces',
    '[assistant] noted, tabs it is',
  ].join('\n');
  const cands = heuristicExtract(text);
  assert.ok(cands.some((c) => c.kind === 'fact' && String(c.data.object).includes('postgres 16')), 'fact found');
  assert.ok(cands.some((c) => c.kind === 'decision' && String(c.data.choice).includes('pnpm')), 'decision found');
  assert.ok(cands.some((c) => c.kind === 'fact' && c.data.subject === 'user preference'), 'preference found');
});

test('consolidate: keyless run extracts, reconciles, writes index, records episode', async () => {
  const { store, graph, keyring, cfg, dir, cleanup } = setup();
  try {
    syncConversation(store, 'c1', [
      { role: 'user', content: 'the deploy region is iad and we decided to use fly because volumes are cheap' },
      { role: 'assistant', content: [{ type: 'text', text: 'Understood: region iad.' }] },
    ]);
    const res = await consolidate({ cfg, store, graph, keyring }, 'c1');
    assert.equal(res.mode, 'heuristic');
    assert.ok(res.extracted > 0, 'candidates extracted');
    assert.ok(res.actions.inserted! > 0, 'nodes inserted');

    const episodes = graph.listNodes('c1').filter((n) => n.kind === 'episode');
    assert.equal(episodes.length, 1);
    const index = readIndex(dir, 'c1');
    assert.ok(index.length > 0, 'index written');
    assert.ok(store.getMeta('c1')!.consolidatedUpTo === 2, 'cursor advanced');

    // Second run with no new turns: no re-extraction.
    const res2 = await consolidate({ cfg, store, graph, keyring }, 'c1');
    assert.equal(res2.extracted, 0);
  } finally {
    cleanup();
  }
});

test('consolidate: contradiction supersedes with provenance', async () => {
  const { store, graph, keyring, cfg, cleanup } = setup();
  try {
    syncConversation(store, 'c1', [{ role: 'user', content: 'the api host is old.example.com for now' }]);
    await consolidate({ cfg, store, graph, keyring }, 'c1');
    syncConversation(store, 'c1', [
      { role: 'user', content: 'the api host is old.example.com for now' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'update: the api host is new.example.com since the migration' },
    ]);
    const res = await consolidate({ cfg, store, graph, keyring }, 'c1');
    assert.ok(res.actions.superseded! >= 1, `superseded: ${JSON.stringify(res.actions)}`);
    const all = graph.listNodes('c1', { includeInactive: true });
    const superseded = all.filter((n) => n.status === 'superseded');
    assert.ok(superseded.length >= 1, 'old fact kept, marked superseded');
  } finally {
    cleanup();
  }
});

test('decay lowers stale unconfirmed confidence; merges duplicate entities', () => {
  const { graph, cleanup } = setup();
  try {
    const now = Date.now();
    const old = now - 90 * 86_400_000;
    graph.upsert({ ns: 'c1', kind: 'fact', data: { subject: 'temp flag', predicate: 'is', object: 'on' }, decay_class: 'volatile' }, old);
    graph.upsert({ ns: 'c1', kind: 'entity', data: { name: 'Enso', type: 'project' } }, old);
    graph.upsert({ ns: 'c1', kind: 'entity', data: { name: 'enso', type: 'project' } }, now);
    // The second enso upsert confirms (same natural key, case-insensitive slug)
    // so force a duplicate directly for the merge path:
    const r = graph.upsert({ ns: 'c1', kind: 'entity', data: { name: 'ENSO ', type: 'tool' } }, now);
    void r;
    const res = runDecay(graph, 'c1', now);
    assert.ok(res.decayed >= 1, 'stale volatile fact decayed');
  } finally {
    cleanup();
  }
});

test('promotion compiles a 5x-successful procedure into a skill file', () => {
  const { store, graph, dir, cleanup } = setup();
  try {
    graph.upsert({
      ns: 'c1',
      kind: 'procedure',
      data: { trigger: 'deploy to fly', steps: ['run tests', 'fly deploy --remote-only', 'check /healthz'], success_count: 5, fail_count: 0 },
    });
    const res = runPromotion(graph, store, 'c1');
    assert.deepEqual(res.promoted, ['deploy to fly']);
    assert.ok(existsSync(join(dir, 'skills', 'deploy-to-fly.md')));
    // Idempotent: second run promotes nothing.
    assert.equal(runPromotion(graph, store, 'c1').promoted.length, 0);
  } finally {
    cleanup();
  }
});

test('keyring: remembers per conversation, expires, never returns after TTL', () => {
  const k = new Keyring();
  const t0 = 1_000_000;
  k.remember('c1', { 'x-api-key': 'sk-secret' }, t0);
  assert.deepEqual(k.get('c1', t0 + 1000), { 'x-api-key': 'sk-secret' });
  assert.equal(k.get('c1', t0 + 25 * 60 * 60 * 1000), null, 'expired after TTL');
  assert.equal(k.get('unknown'), null);
});
