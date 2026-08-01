import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate, probeRetention } from '../src/eval/evaluate.js';
import { turnsToText } from '../src/window/assemble.js';
import type { EvalTruth, Turn } from '../src/types.js';

test('probeRetention: any surviving probe counts, case/whitespace-insensitive', () => {
  const truth: EvalTruth[] = [
    { question: 'q1', probes: ['Postgres 16', 'pg16'] },
    { question: 'q2', probes: ['gone entirely'] },
  ];
  const r = probeRetention('we use   POSTGRES 16 in prod', truth);
  assert.equal(r.retention, 0.5);
  assert.deepEqual(r.lost, ['q2']);
});

test('evaluate on the fixture: retention is monotone-ish and passes thresholds', async () => {
  const fixture = JSON.parse(readFileSync('test/fixtures/session-lorem.json', 'utf8')) as { truth: EvalTruth[]; turns: Turn[] };
  const curve = await evaluate(turnsToText(fixture.turns), fixture.truth, { date: '2026-01-01' });

  assert.equal(curve.tiers[0]!.retention, 1, 'tier 0 retains everything');
  const t1 = curve.tiers.find((t) => t.tier === 1)!;
  const t2 = curve.tiers.find((t) => t.tier === 2)!;
  assert.ok(t1.retention >= 0.9, `tier 1 retention ${t1.retention}`);
  assert.ok(t2.retention >= 0.6, `tier 2 retention ${t2.retention}`);
  assert.ok(t1.tokens < curve.sessionTokens * 0.85, 'tier 1 actually compressed');
  assert.ok(t2.tokens < t1.tokens, 'tiers shrink');
  // Deeper tiers never gain retention back.
  for (let i = 1; i < curve.tiers.length; i++) {
    assert.ok(curve.tiers[i]!.retention <= curve.tiers[i - 1]!.retention + 0.001, 'no retention resurrection');
  }
});
