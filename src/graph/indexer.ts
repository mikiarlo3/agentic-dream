import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Graph } from './graph.js';

/**
 * The index layer: one line per active node, regenerated whenever the graph
 * changes. This is what loads at the start of a session — a few hundred
 * tokens for thousands of nodes. Detail is fetched via recall.
 */
export function regenerateIndex(graph: Graph, storeRoot: string, ns: string): string {
  const nodes = graph.listNodes(ns).filter((n) => n.confidence >= 0.2);
  const lines = nodes.map((n) => `[${n.id}] ${n.label} (conf ${n.confidence.toFixed(2)})`);
  const text = lines.join('\n');
  const dir = join(storeRoot, 'graph');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `index-${ns}.txt`), text);
  return text;
}

export function readIndex(storeRoot: string, ns: string): string {
  const p = join(storeRoot, 'graph', `index-${ns}.txt`);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
