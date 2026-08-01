import type { Graph } from '../graph/graph.js';
import type { Store } from '../store/store.js';

const PROMOTION_SUCCESSES = 5;

/**
 * Promotion: a procedure with enough clean successes graduates from
 * remembered (graph node, costs recall tokens) to installed (skill file,
 * costs nothing). This is what makes the system improve rather than
 * merely accumulate.
 */
export function runPromotion(graph: Graph, store: Store, ns: string): { promoted: string[] } {
  const promoted: string[] = [];
  for (const node of graph.listNodes(ns).filter((n) => n.kind === 'procedure')) {
    const success = Number(node.data.success_count ?? 0);
    const fail = Number(node.data.fail_count ?? 0);
    const already = Boolean(node.data.promoted);
    if (already || success < PROMOTION_SUCCESSES || fail > 0) continue;

    const steps = Array.isArray(node.data.steps) ? (node.data.steps as string[]) : [];
    const name = String(node.data.trigger ?? node.id);
    const md = [
      `# ${name}`,
      '',
      `Promoted from procedure ${node.id} after ${success} clean successes.`,
      '',
      `**Trigger:** ${node.data.trigger}`,
      '',
      '## Steps',
      ...steps.map((s, i) => `${i + 1}. ${s}`),
      '',
      `_Source namespace: ${ns}. Last used: ${node.data.last_used ?? 'n/a'}._`,
    ].join('\n');
    store.putSkill(name, md);
    graph.updateNode(node.id, { data: { ...node.data, promoted: true } });
    promoted.push(name);
  }
  return { promoted };
}
