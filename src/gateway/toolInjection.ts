import type { Graph } from '../graph/graph.js';
import type { Store } from '../store/store.js';
import { recall } from '../recall/recall.js';

export const DREAM_TOOLS = [
  {
    name: 'dream_recall',
    description:
      'Search this conversation\'s long-term memory (facts, entities, decisions, procedures, and compressed history). Use when you need details that are not in the visible context — earlier discussion, stated preferences, prior decisions, numbers, names.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up' },
        k: { type: 'integer', description: 'Max results (default 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'dream_unpack',
    description: 'Fetch the verbatim original text behind a compressed [block t1-...] reference from memory.',
    input_schema: {
      type: 'object',
      properties: { block_id: { type: 'string', description: 'Block id, e.g. t1-a1b2c3d4e5f60718' } },
      required: ['block_id'],
    },
  },
] as const;

export function isDreamTool(name: unknown): boolean {
  return name === 'dream_recall' || name === 'dream_unpack';
}

/** Add dream tools to a request body's tool list (idempotent). */
export function injectTools(body: Record<string, unknown>): void {
  const tools = Array.isArray(body.tools) ? [...(body.tools as Array<{ name?: string }>)] : [];
  for (const t of DREAM_TOOLS) {
    if (!tools.some((existing) => existing.name === t.name)) tools.push(t as unknown as { name: string });
  }
  body.tools = tools;
}

export function executeDreamTool(graph: Graph, store: Store, ns: string, name: string, input: Record<string, unknown>): string {
  if (name === 'dream_recall') {
    const query = String(input.query ?? '');
    const k = Number(input.k ?? 8);
    const res = recall(graph, store, ns, query, Number.isFinite(k) ? k : 8);
    if (res.nodes.length === 0 && res.blocks.length === 0) return `No memory found for "${query}".`;
    const parts: string[] = [];
    if (res.nodes.length > 0) {
      parts.push(res.nodes.map((n) => `[${n.id}] (${n.status}, conf ${n.confidence.toFixed(2)}) ${n.label}`).join('\n'));
    }
    if (res.blocks.length > 0) {
      parts.push('Matching compressed history blocks (fetch verbatim with dream_unpack):');
      parts.push(res.blocks.map((b) => `[block ${b.id}] ${b.pressed.slice(0, 300)}`).join('\n'));
    }
    return parts.join('\n');
  }
  if (name === 'dream_unpack') {
    const id = String(input.block_id ?? '').replace(/^block\s+/, '');
    const block = store.findBlock(id);
    return block ? block.original : `No block with id ${id}.`;
  }
  return `Unknown dream tool ${name}.`;
}
