// npm run eval -- --fixture test/fixtures/session-lorem.json [--semantic] [--out dream-store]
// Presses the session through every tier, quizzes each tier, prints the loss
// curve, writes eval/curve-<date>.json, and exits non-zero when retention
// falls below the regression thresholds (CI gate).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate } from './evaluate.js';
import { turnsToText } from '../window/assemble.js';
import type { EvalTruth, Turn } from '../types.js';

const THRESHOLDS: Record<number, number> = { 1: 0.9, 2: 0.6 };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const fixturePath = arg('fixture') ?? 'test/fixtures/session-lorem.json';
const outDir = arg('out') ?? process.env.DREAM_STORE_DIR ?? 'dream-store';
const useSemantic = process.argv.includes('--semantic');

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { truth: EvalTruth[]; turns: Turn[] };
const sessionText = turnsToText(fixture.turns);

const semantic = useSemantic
  ? {
      baseUrl: process.env.UPSTREAM_BASE_URL ?? 'https://api.anthropic.com',
      model: process.env.DREAM_PRESS_MODEL ?? 'claude-haiku-4-5-20251001',
      headers: { 'x-api-key': process.env.DREAM_MODEL_KEY ?? process.env.ANTHROPIC_API_KEY ?? '' },
    }
  : undefined;

if (useSemantic && !semantic?.headers['x-api-key']) {
  console.error('--semantic requires DREAM_MODEL_KEY or ANTHROPIC_API_KEY');
  process.exit(2);
}

const curve = await evaluate(sessionText, fixture.truth, { semantic });

console.log(`\nDream eval — ${fixturePath} (${curve.sessionTokens} est. tokens, backend: ${curve.backend})\n`);
console.log('| Tier | Tokens | Ratio | Retention | Lost |');
console.log('|------|--------|-------|-----------|------|');
for (const t of curve.tiers) {
  console.log(`| ${t.tier} | ${t.tokens} | ${t.ratio}x | ${(t.retention * 100).toFixed(0)}% | ${t.lost.length} |`);
}
console.log(`\ncliff: ${curve.cliff === null ? 'none within measured tiers' : `tier ${curve.cliff}`}`);
for (const t of curve.tiers) {
  if (t.lost.length > 0) console.log(`  tier ${t.tier} lost: ${t.lost.join(' | ')}`);
}

mkdirSync(join(outDir, 'eval'), { recursive: true });
const outPath = join(outDir, 'eval', `curve-${curve.date}.json`);
writeFileSync(outPath, JSON.stringify(curve, null, 2));
console.log(`\nwrote ${outPath}`);

let failed = false;
for (const [tier, min] of Object.entries(THRESHOLDS)) {
  const point = curve.tiers.find((t) => t.tier === Number(tier));
  if (point && point.retention < min) {
    console.error(`FAIL: tier ${tier} retention ${(point.retention * 100).toFixed(0)}% < required ${min * 100}%`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
