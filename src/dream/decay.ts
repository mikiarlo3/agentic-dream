import type { Graph } from '../graph/graph.js';

const DECAY_WINDOW_DAYS: Record<string, number> = { stable: 365, normal: 45, volatile: 7 };
const DECAY_STEP = 0.1;

/**
 * Decay pass: low-confidence facts that were never reconfirmed age out of the
 * index (confidence drops; below 0.2 the indexer stops listing them — the
 * node itself is never deleted). Duplicate entities merge.
 */
export function runDecay(graph: Graph, ns: string, now = Date.now()): { decayed: number; merged: number } {
  let decayed = 0;
  for (const node of graph.listNodes(ns)) {
    const windowDays = DECAY_WINDOW_DAYS[node.decay_class] ?? 45;
    const staleDays = (now - node.last_confirmed) / 86_400_000;
    if (staleDays > windowDays && node.confidence > 0.05) {
      graph.updateNode(node.id, { confidence: Math.max(0.05, node.confidence - DECAY_STEP), last_confirmed: node.last_confirmed });
      decayed++;
    }
  }

  // Merge duplicate entities (same lowercase name, both active).
  let merged = 0;
  const entities = graph.listNodes(ns).filter((n) => n.kind === 'entity');
  const byName = new Map<string, typeof entities>();
  for (const e of entities) {
    const key = String(e.data.name ?? '').toLowerCase().trim();
    byName.set(key, [...(byName.get(key) ?? []), e]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = group.sort((a, b) => b.confidence - a.confidence);
    for (const dup of rest) {
      const aliases = new Set([...(keep!.data.aliases as string[] ?? []), ...((dup.data.aliases as string[]) ?? []), String(dup.data.name)]);
      aliases.delete(String(keep!.data.name));
      graph.updateNode(keep!.id, { data: { ...keep!.data, aliases: [...aliases] } });
      graph.updateNode(dup.id, { status: 'merged' });
      graph.addEdge(keep!.id, dup.id, 'supersedes', now);
      merged++;
    }
  }
  return { decayed, merged };
}
