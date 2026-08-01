import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphDb } from '../src/graph/db.js';
import { Graph } from '../src/graph/graph.js';
import { regenerateIndex, readIndex } from '../src/graph/indexer.js';
import { recall } from '../src/recall/recall.js';
import { Store } from '../src/store/store.js';

function makeGraph() {
  return new Graph(new GraphDb(':memory:'));
}

test('upsert inserts, confirms, supersedes', () => {
  const g = makeGraph();
  const t0 = 1_000_000;

  const a = g.upsert({ ns: 'c1', kind: 'fact', data: { subject: 'deploy target', predicate: 'is', object: 'fly.io' } }, t0);
  assert.equal(a.action, 'inserted');
  assert.equal(a.node.confidence, 0.5);

  const b = g.upsert({ ns: 'c1', kind: 'fact', data: { subject: 'deploy target', predicate: 'is', object: 'Fly.io' } }, t0 + 1000);
  assert.equal(b.action, 'confirmed');
  assert.ok(b.node.confidence > 0.5);
  assert.equal(b.node.last_confirmed, t0 + 1000);

  const c = g.upsert({ ns: 'c1', kind: 'fact', data: { subject: 'deploy target', predicate: 'is', object: 'railway' } }, t0 + 2000);
  assert.equal(c.action, 'superseded');
  assert.equal(c.supersededId, a.node.id);

  const old = g.getNode(a.node.id)!;
  assert.equal(old.status, 'superseded');
  const edges = g.edges(c.node.id);
  assert.ok(edges.some((e) => e.rel === 'supersedes' && e.dst === a.node.id), 'supersedes edge exists');

  // superseded stays reachable, active list excludes it
  assert.equal(g.listNodes('c1').length, 1);
  assert.equal(g.listNodes('c1', { includeInactive: true }).length, 2);
});

test('namespaces are isolated', () => {
  const g = makeGraph();
  g.upsert({ ns: 'c1', kind: 'entity', data: { name: 'Mickey', type: 'person' } });
  g.upsert({ ns: 'c2', kind: 'entity', data: { name: 'Mickey', type: 'person' } });
  assert.equal(g.listNodes('c1').length, 1);
  assert.equal(g.search('c1', 'Mickey').length, 1);
});

test('fts search finds nodes by data content', () => {
  const g = makeGraph();
  g.upsert({ ns: 'c1', kind: 'decision', data: { choice: 'use SQLite', rationale: 'zero native deps in docker' } });
  g.upsert({ ns: 'c1', kind: 'fact', data: { subject: 'budget', predicate: 'is', object: '4500 USD' } });
  const hits = g.search('c1', 'docker deps');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.node.kind, 'decision');
  // query with FTS-hostile characters must not throw
  assert.doesNotThrow(() => g.search('c1', 'what "about" (this) AND that?'));
});

test('index regenerates one line per node and drops low-confidence', () => {
  const g = makeGraph();
  const dir = mkdtempSync(join(tmpdir(), 'dream-idx-'));
  try {
    const r = g.upsert({ ns: 'c1', kind: 'fact', data: { subject: 'color', predicate: 'is', object: 'blue' } });
    g.upsert({ ns: 'c1', kind: 'entity', data: { name: 'Enso', type: 'project', one_liner: 'agentic growth lab' } });
    let text = regenerateIndex(g, dir, 'c1');
    assert.equal(text.split('\n').length, 2);
    assert.ok(text.includes(r.node.id));

    g.updateNode(r.node.id, { confidence: 0.1 });
    text = regenerateIndex(g, dir, 'c1');
    assert.equal(text.split('\n').length, 1, 'low-confidence node dropped from index');
    assert.equal(readIndex(dir, 'c1'), text);
    // idempotent
    assert.equal(regenerateIndex(g, dir, 'c1'), readFileSync(join(dir, 'graph', 'index-c1.txt'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recall ranks by relevance x confidence x recency, penalizes superseded', () => {
  const g = makeGraph();
  const dir = mkdtempSync(join(tmpdir(), 'dream-rec-'));
  const store = new Store(dir);
  try {
    const now = Date.now();
    const oldFact = g.upsert({ ns: 'c1', kind: 'fact', data: { subject: 'api host', predicate: 'is', object: 'old.example.com' } }, now - 90 * 86_400_000);
    const newFact = g.upsert({ ns: 'c1', kind: 'fact', data: { subject: 'api host', predicate: 'is', object: 'new.example.com' } }, now);
    assert.equal(newFact.action, 'superseded');
    void oldFact;

    const res = recall(g, store, 'c1', 'api host', 5, now);
    assert.ok(res.nodes.length >= 2, 'both versions reachable');
    assert.equal(res.nodes[0]!.data.object, 'new.example.com', 'active version ranks first');
    assert.ok(res.nodes[0]!.score > res.nodes[1]!.score);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recall surfaces matching pressed blocks', async () => {
  const g = makeGraph();
  const dir = mkdtempSync(join(tmpdir(), 'dream-rec2-'));
  const store = new Store(dir);
  try {
    const { press } = await import('../src/press/press.js');
    await press(store, 'the volume name is dream_data\nfiller\nfiller', 1, { ns: 'c1' });
    const res = recall(g, store, 'c1', 'dream_data');
    assert.equal(res.blocks.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
