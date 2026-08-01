// Standalone smoke test against a RUNNING Dream gateway (local process or
// docker container). Boots its own mock upstream unless UPSTREAM_BASE_URL
// points elsewhere, then drives a conversation and checks the memory
// endpoints end to end.
//
//   GATEWAY_URL=http://localhost:8082 npm run smoke
import { MockUpstream } from '../test/fixtures/mock-upstream.js';

const gateway = process.env.GATEWAY_URL ?? 'http://localhost:8082';
const token = process.env.DREAM_ACCESS_TOKEN ?? '';
const authHeaders: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

let mock: MockUpstream | null = null;
if (!process.env.SMOKE_NO_MOCK) {
  mock = new MockUpstream();
  const port = await mock.start(Number(process.env.SMOKE_MOCK_PORT ?? 0));
  console.log(`mock upstream on :${port} — the gateway must have UPSTREAM_BASE_URL pointing at it`);
}

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

const health = await fetch(`${gateway}/healthz`).then((r) => r.json()) as { ok: boolean };
check('healthz', health.ok === true);

const history: Array<{ role: string; content: unknown }> = [];
let lastHeaders: Headers | null = null;
for (let i = 0; i < 12; i++) {
  history.push({ role: 'user', content: `turn ${i}: budget is ${1000 + i} USD\n` + 'INFO heartbeat ok 12ms\n'.repeat(10) });
  const res = await fetch(`${gateway}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'smoke-key', 'x-dream-conversation-id': 'smoke-conv' },
    body: JSON.stringify({ model: 'smoke-model', max_tokens: 32, messages: history }),
  });
  if (res.status !== 200) {
    check(`proxy turn ${i}`, false, `status ${res.status}: ${(await res.text()).slice(0, 120)}`);
    break;
  }
  lastHeaders = res.headers;
  const d = (await res.json()) as { content: unknown };
  history.push({ role: 'assistant', content: d.content });
}
check('12 proxied turns', history.length === 24);
check('x-dream headers present', Boolean(lastHeaders?.get('x-dream-raw-tokens')));

const stream = await fetch(`${gateway}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'smoke-key', 'x-dream-conversation-id': 'smoke-conv' },
  body: JSON.stringify({ model: 'smoke-model', max_tokens: 32, stream: true, messages: [...history, { role: 'user', content: 'stream check' }] }),
});
const streamText = await stream.text();
check('streaming round-trip', stream.status === 200 && streamText.includes('message_stop'));

const stats = await fetch(`${gateway}/stats`, { headers: authHeaders }).then((r) => r.json()) as { store: { blocks: number } };
check('stats reachable', typeof stats.store?.blocks === 'number', `${stats.store?.blocks} blocks`);

const dream = await fetch(`${gateway}/api/dream/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...authHeaders },
  body: JSON.stringify({ ns: 'smoke-conv' }),
}).then((r) => r.json()) as { mode: string; extracted: number };
check('dream consolidation runs', typeof dream.mode === 'string', `mode=${dream.mode} extracted=${dream.extracted}`);

const recallRes = await fetch(`${gateway}/recall`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...authHeaders },
  body: JSON.stringify({ ns: 'smoke-conv', query: 'budget' }),
}).then((r) => r.json()) as { nodes: unknown[]; blocks: unknown[] };
check('recall finds memory', (recallRes.nodes?.length ?? 0) + (recallRes.blocks?.length ?? 0) > 0);

const ui = await fetch(`${gateway}/ui/`);
check('dashboard served', ui.status === 200 && (await ui.text()).includes('Dream'));

await mock?.stop();
console.log(failed === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
