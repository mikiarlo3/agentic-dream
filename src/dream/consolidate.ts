// The namesake loop: extract → reconcile → index → decay → promote.
// Runs off the request path, after a task completes or on a schedule.
import type { DreamConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { Graph } from '../graph/graph.js';
import type { Keyring } from '../gateway/keyring.js';
import type { Turn } from '../types.js';
import { heuristicExtract, semanticExtract, type Candidate } from './extract.js';
import { runDecay } from './decay.js';
import { runPromotion } from './skills.js';
import { regenerateIndex } from '../graph/indexer.js';
import { turnsToText } from '../window/assemble.js';

export interface ConsolidationResult {
  ns: string;
  mode: 'semantic' | 'heuristic' | 'noop';
  extracted: number;
  actions: Record<string, number>;
}

export interface ConsolidateDeps {
  cfg: DreamConfig;
  store: Store;
  graph: Graph;
  keyring: Keyring;
}

export async function consolidate(deps: ConsolidateDeps, ns: string): Promise<ConsolidationResult> {
  const { cfg, store, graph, keyring } = deps;
  const meta = store.getMeta(ns);
  if (!meta) return { ns, mode: 'noop', extracted: 0, actions: {} };

  const allTurns = store.readTurns(ns) as Turn[];
  const newTurns = allTurns.slice(meta.consolidatedUpTo);
  const actions: Record<string, number> = { inserted: 0, confirmed: 0, superseded: 0, discarded: 0 };
  let mode: ConsolidationResult['mode'] = 'noop';
  let candidates: Candidate[] = [];

  if (newTurns.length > 0) {
    const text = turnsToText(newTurns);

    // Register the episode itself.
    const episode = graph.upsert({
      ns,
      kind: 'episode',
      data: {
        summary: text.slice(0, 200).replace(/\n/g, ' '),
        transcript_ref: `${ns}:${meta.consolidatedUpTo}-${allTurns.length}`,
        outcome: 'completed',
        tokens_spent: Math.ceil(text.length / 4),
      },
    });

    // Key resolution: operator env key → conversation keyring → keyless.
    const auth = cfg.modelKey ? { 'x-api-key': cfg.modelKey } : keyring.get(meta.id);
    if (auth) {
      try {
        candidates = await semanticExtract(text, { baseUrl: cfg.upstreamBaseUrl, model: cfg.extractModel, headers: auth });
        mode = 'semantic';
      } catch {
        candidates = heuristicExtract(text);
        mode = 'heuristic';
      }
    } else {
      candidates = heuristicExtract(text);
      mode = 'heuristic';
    }

    // Reconcile each candidate against the graph.
    for (const c of candidates) {
      const dataStr = JSON.stringify(c.data);
      if (dataStr.length < 15) {
        actions.discarded!++;
        continue;
      }
      const r = graph.upsert({
        ns,
        kind: c.kind,
        data: c.data,
        confidence: c.confidence,
        source_episode: episode.node.id,
      });
      actions[r.action] = (actions[r.action] ?? 0) + 1;
    }

    meta.consolidatedUpTo = allTurns.length;
    store.putMeta(meta);
  }

  const decayRes = runDecay(graph, ns);
  actions.decayed = decayRes.decayed;
  actions.entityMerged = decayRes.merged;
  const promoRes = runPromotion(graph, store, ns);
  actions.promoted = promoRes.promoted.length;

  regenerateIndex(graph, store.root, ns);
  return { ns, mode, extracted: candidates.length, actions };
}
