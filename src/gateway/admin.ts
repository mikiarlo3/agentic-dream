import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { DreamConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { Graph } from '../graph/graph.js';
import type { Keyring } from './keyring.js';
import type { RequestLogEntry } from '../types.js';
import { recall } from '../recall/recall.js';
import { readIndex } from '../graph/indexer.js';
import { turnsToText } from '../window/assemble.js';

export interface AdminDeps {
  cfg: DreamConfig;
  store: Store;
  graph: Graph;
  keyring: Keyring;
  requestLog: RequestLogEntry[];
  dreamRuns: Array<{ ts: number; ns: string; mode: string; extracted: number; actions: Record<string, number> }>;
  runConsolidation: (ns: string) => Promise<{ mode: string; extracted: number; actions: Record<string, number> }>;
}

export function bearerAuth(cfg: DreamConfig) {
  return async (c: Context, next: Next) => {
    if (!cfg.accessToken) return next(); // local/dev mode: open
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : c.req.query('token');
    if (token !== cfg.accessToken) {
      return c.json({ type: 'error', error: { type: 'authentication_error', message: 'missing or invalid access token' } }, 401);
    }
    return next();
  };
}

export function adminRoutes(deps: AdminDeps): Hono {
  const { cfg, store, graph } = deps;
  const app = new Hono();

  app.get('/healthz', (c) => {
    const s = store.stats();
    const g = graph.stats();
    return c.json({ ok: true, store: { namespaces: s.namespaces, blocks: s.blocks }, graph: { nodes: g.nodes, edges: g.edges } });
  });

  // Doc-specified public surface (auth-gated like the rest of the admin API).
  app.get('/blocks/:id', bearerAuth(cfg), (c) => {
    const block = store.findBlock(c.req.param('id') ?? '');
    if (!block) return c.json({ type: 'error', error: { type: 'not_found_error', message: 'no such block' } }, 404);
    return c.json(block);
  });

  app.post('/recall', bearerAuth(cfg), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ns?: string; query?: string; k?: number };
    if (!body.query) return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'query required' } }, 400);
    const ns = body.ns ?? store.listNamespaces()[0] ?? 'default';
    return c.json(recall(graph, store, ns, body.query, body.k ?? 8));
  });

  app.get('/stats', bearerAuth(cfg), (c) => {
    const s = store.stats();
    const g = graph.stats();
    const savings = deps.requestLog.filter((r) => r.dream).map((r) => r.dream!.savingsPct);
    return c.json({
      store: s,
      graph: g,
      keyring: { conversations: deps.keyring.size() },
      requests: {
        total: deps.requestLog.length,
        avgSavingsPct: savings.length ? Math.round(savings.reduce((a, b) => a + b, 0) / savings.length) : 0,
      },
      dreamRuns: deps.dreamRuns.slice(-20),
      config: {
        windowBudget: cfg.windowBudget,
        upstream: cfg.upstreamBaseUrl,
        semanticEnabled: Boolean(cfg.modelKey),
        accessTokenSet: Boolean(cfg.accessToken),
      },
    });
  });

  // --- UI API ---
  const api = new Hono();
  api.use('*', bearerAuth(cfg));

  api.get('/conversations', (c) => {
    const out = store.listNamespaces().map((ns) => {
      const meta = store.getMeta(ns);
      const blocks = store.listBlocks(ns);
      return meta
        ? {
            ns,
            id: meta.id,
            createdAt: meta.createdAt,
            lastSeen: meta.lastSeen,
            turns: meta.turnCount,
            pressedUpTo: meta.pressedUpTo,
            consolidatedUpTo: meta.consolidatedUpTo,
            blocks: blocks.length,
            tiers: Object.fromEntries(Object.entries(meta.tierBlocks).map(([k, v]) => [k, v.length])),
          }
        : { ns, turns: 0, blocks: blocks.length };
    });
    return c.json(out.sort((a, b) => Number(b.lastSeen ?? 0) - Number(a.lastSeen ?? 0)));
  });

  api.get('/conversations/:ns', (c) => {
    const ns = c.req.param('ns') ?? '';
    const meta = store.getMeta(ns);
    if (!meta) return c.json({ type: 'error', error: { type: 'not_found_error', message: 'no such conversation' } }, 404);
    const turns = store.readTurns(ns) as Array<{ role: string; content: unknown }>;
    return c.json({
      meta,
      blocks: store.listBlocks(ns).map(({ original, ...b }) => ({ ...b, originalChars: original.length })),
      transcriptPreview: turnsToText(turns.slice(-20) as Parameters<typeof turnsToText>[0]).slice(-8000),
      index: readIndex(store.root, ns),
    });
  });

  api.get('/blocks/:id', (c) => {
    const block = store.findBlock(c.req.param('id') ?? '');
    if (!block) return c.json({ type: 'error', error: { type: 'not_found_error', message: 'no such block' } }, 404);
    return c.json(block);
  });

  api.get('/graph', (c) => {
    const ns = c.req.query('ns');
    return c.json({
      nodes: graph.listNodes(ns, { includeInactive: true }),
      edges: graph.listEdges(ns),
    });
  });

  api.post('/recall', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ns?: string; query?: string; k?: number };
    if (!body.query) return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'query required' } }, 400);
    const ns = body.ns ?? store.listNamespaces()[0] ?? 'default';
    return c.json(recall(graph, store, ns, body.query, body.k ?? 8));
  });

  api.get('/eval/curves', (c) => c.json(store.listCurves()));
  api.get('/skills', (c) => c.json(store.listSkills()));
  api.get('/requests', (c) => c.json([...deps.requestLog].reverse()));
  api.get('/dream/runs', (c) => c.json([...deps.dreamRuns].reverse().slice(0, 50)));

  api.post('/dream/run', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ns?: string };
    const ns = body.ns;
    if (!ns) return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'ns required' } }, 400);
    const result = await deps.runConsolidation(ns);
    return c.json(result);
  });

  app.route('/api', api);
  return app;
}
