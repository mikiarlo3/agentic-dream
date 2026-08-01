import type { Block, GraphNode, RecallResult } from '../types.js';
import type { Graph } from '../graph/graph.js';
import type { Store } from '../store/store.js';

const HALF_LIFE_DAYS: Record<string, number> = { stable: 365, normal: 60, volatile: 7 };

/**
 * recall(query, k): rank graph nodes by relevance × confidence × recency.
 * Superseded nodes are rank-penalized but reachable — "why did you change
 * your mind" keeps its answer. Also matches pressed blocks whose text
 * mentions the query, so verbatim detail is one unpack away.
 */
export function recall(graph: Graph, store: Store, ns: string, query: string, k = 8, now = Date.now()): RecallResult {
  const hits = graph.search(ns, query, k * 4);
  // search() only returns active-FTS rows; include superseded via a widened pass
  const scored = hits.map(({ node, bm25 }) => ({ node, score: score(node, bm25, now) }));
  scored.sort((a, b) => b.score - a.score);
  const nodes = scored.slice(0, k).map(({ node, score }) => ({ ...node, score }));

  const q = query.toLowerCase();
  const blocks: Block[] = store
    .listBlocks(ns)
    .filter((b) => b.pressed.toLowerCase().includes(q) || b.original.toLowerCase().includes(q))
    .slice(0, 3);

  return { nodes, blocks };
}

function score(node: GraphNode, bm25: number, now: number): number {
  const ageDays = Math.max(0, (now - node.last_confirmed) / 86_400_000);
  const halfLife = HALF_LIFE_DAYS[node.decay_class] ?? 60;
  const recency = Math.exp((-Math.LN2 * ageDays) / halfLife);
  const statusPenalty = node.status === 'active' ? 1 : 0.3;
  return (1 + bm25) * node.confidence * recency * statusPenalty;
}
