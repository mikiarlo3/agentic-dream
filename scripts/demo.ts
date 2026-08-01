// npm run demo — boots Dream against a built-in fake model and drives a
// conversation through it, so you can explore a populated dashboard without
// any API key. Ctrl+C to stop.
import { serve } from '@hono/node-server';
import { MockUpstream } from '../test/fixtures/mock-upstream.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const mock = new MockUpstream();
await mock.start();

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: process.env.PORT ?? '8082',
  DREAM_STORE_DIR: process.env.DREAM_STORE_DIR ?? 'dream-store-demo',
  UPSTREAM_BASE_URL: mock.baseUrl,
  DREAM_WINDOW_BUDGET: '2000',
};
const cfg = loadConfig(env);
const { app, scheduler } = createServer(env);
scheduler.start();
await new Promise<void>((resolve) => {
  serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0' }, () => resolve());
});

console.log(`seeding demo conversation through the gateway…`);
const history: Array<{ role: string; content: unknown }> = [];
const facts = [
  'the project codename is Starlight',
  'we decided to use Postgres 16 because RDS supports it',
  'deploy region is iad',
  'monthly infra budget is 4500 USD',
  'Priya Raman is the project lead',
  'launch date is 2026-10-15',
];
for (let i = 0; i < 24; i++) {
  const fact = facts[i % facts.length]!;
  history.push({
    role: 'user',
    content: `turn ${i}: ${fact}\n` + '2026-08-01T10:00:00Z INFO worker heartbeat ok latency=12ms seq=99999\n'.repeat(15),
  });
  const res = await fetch(`http://127.0.0.1:${cfg.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'demo-key', 'x-dream-conversation-id': 'demo-conversation' },
    body: JSON.stringify({ model: 'demo-model', max_tokens: 64, messages: history }),
  });
  if (!res.ok) throw new Error(`seed request failed: ${res.status} ${await res.text()}`);
  const d = (await res.json()) as { content: unknown };
  history.push({ role: 'assistant', content: d.content });
}
const run = await fetch(`http://127.0.0.1:${cfg.port}/api/dream/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ns: 'demo-conversation' }),
}).then((r) => r.json());
console.log(`dream run: ${JSON.stringify(run)}`);
console.log(`
  🌙 Demo running. Open the dashboard:

    http://localhost:${cfg.port}/ui/

  The Playground works too — the fake model just echoes, no API key needed
  (type anything as the key). Store: ${cfg.storeDir}. Ctrl+C to stop.
`);
