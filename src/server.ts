import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { Store } from './store/store.js';
import { GraphDb } from './graph/db.js';
import { Graph } from './graph/graph.js';
import { Keyring } from './gateway/keyring.js';
import { handleMessages, type ProxyDeps } from './gateway/proxy.js';
import { adminRoutes, bearerAuth } from './gateway/admin.js';
import { Scheduler } from './dream/scheduler.js';
import type { RequestLogEntry } from './types.js';

export interface DreamServer {
  app: Hono;
  scheduler: Scheduler;
  store: Store;
  graph: Graph;
}

export function createServer(env: NodeJS.ProcessEnv = process.env): DreamServer {
  const cfg = loadConfig(env);
  const store = new Store(cfg.storeDir);
  const graph = new Graph(new GraphDb(join(cfg.storeDir, 'graph', 'nodes.sqlite')));
  const keyring = new Keyring();
  const requestLog: RequestLogEntry[] = [];
  const scheduler = new Scheduler({ cfg, store, graph, keyring }, cfg, store);

  const proxyDeps: ProxyDeps = {
    cfg,
    store,
    graph,
    keyring,
    requestLog,
    onActivity: (ns) => scheduler.onActivity(ns),
  };

  const app = new Hono();

  // The drop-in proxy surface.
  app.post('/v1/messages', (c) => handleMessages(c, proxyDeps));

  // Admin + UI API.
  app.route(
    '/',
    adminRoutes({
      cfg,
      store,
      graph,
      keyring,
      requestLog,
      dreamRuns: scheduler.runs,
      runConsolidation: (ns) => scheduler.enqueue(ns),
    }),
  );

  // Dashboard. Static files are public; every data endpoint they call is
  // bearer-gated, so an unauthenticated visitor sees only an empty shell.
  const uiRoot = existsSync(join(process.cwd(), 'ui')) ? 'ui' : './ui';
  app.get('/', (c) => c.redirect('/ui/'));
  app.get('/ui', (c) => c.redirect('/ui/'));
  app.use('/ui/*', serveStatic({ root: './', rewriteRequestPath: (p) => p.replace(/^\/ui\/?/, `${uiRoot}/`) || `${uiRoot}/index.html` }));

  // Auth probe for the UI login flow.
  app.get('/api/auth/check', bearerAuth(cfg), (c) => c.json({ ok: true }));

  return { app, scheduler, store, graph };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  const cfg = loadConfig();
  const { app, scheduler } = createServer();
  scheduler.start();
  serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0' }, (info) => {
    console.log(`dream gateway listening on :${info.port}`);
    console.log(`  store: ${cfg.storeDir}`);
    console.log(`  upstream: ${cfg.upstreamBaseUrl}`);
    console.log(`  ui: http://localhost:${info.port}/ui/  (access token ${cfg.accessToken ? 'REQUIRED' : 'not set — open'})`);
  });
}
