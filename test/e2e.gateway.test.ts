import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { MockUpstream } from './fixtures/mock-upstream.js';
import { createServer, type DreamServer } from '../src/server.js';

let mock: MockUpstream;
let dream: DreamServer;
let server: ServerType;
let base: string;
let storeDir: string;

before(async () => {
  mock = new MockUpstream();
  await mock.start();
  storeDir = mkdtempSync(join(tmpdir(), 'dream-e2e-'));
  dream = createServer({
    PORT: '0',
    DREAM_STORE_DIR: storeDir,
    UPSTREAM_BASE_URL: mock.baseUrl,
    DREAM_WINDOW_BUDGET: '2000', // small budget so pressing kicks in fast
    DREAM_IDLE_CONSOLIDATE_MS: '999999',
    DREAM_SWEEP_INTERVAL_MS: '999999',
  } as NodeJS.ProcessEnv);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: dream.app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

after(async () => {
  server.close();
  await mock.stop();
  rmSync(storeDir, { recursive: true, force: true });
});

function msg(role: 'user' | 'assistant', content: unknown) {
  return { role, content };
}

async function send(messages: unknown[], opts: { convId?: string; stream?: boolean; script?: string; tools?: 'off' } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': 'test-key-123' };
  if (opts.convId) headers['x-dream-conversation-id'] = opts.convId;
  if (opts.script) headers['x-mock-script'] = opts.script;
  if (opts.tools) headers['x-dream-tools'] = opts.tools;
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'mock-model', max_tokens: 100, messages, ...(opts.stream ? { stream: true } : {}) }),
  });
}

test('non-streaming passthrough round-trip with x-dream headers', async () => {
  const res = await send([msg('user', 'hello')], { convId: 'e2e-basic' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-dream-conversation-id'), 'e2e-basic');
  assert.ok(res.headers.get('x-dream-raw-tokens'));
  const data = (await res.json()) as { content: Array<{ text: string }>; role: string };
  assert.equal(data.role, 'assistant');
  assert.match(data.content[0]!.text, /mock reply/);
  // upstream saw the api key and injected dream tools
  const up = mock.lastRequest()!;
  assert.equal(up.headers['x-api-key'], 'test-key-123');
  const tools = up.body.tools as Array<{ name: string }>;
  assert.ok(tools.some((t) => t.name === 'dream_recall'));
  assert.ok(tools.some((t) => t.name === 'dream_unpack'));
});

test('tools opt-out leaves body clean', async () => {
  await send([msg('user', 'no tools please')], { convId: 'e2e-notools', tools: 'off' });
  assert.equal(mock.lastRequest()!.body.tools, undefined);
});

test('streaming passthrough delivers identical SSE and captures transcript', async () => {
  const res = await send([msg('user', 'stream me')], { convId: 'e2e-stream', stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: content_block_delta/);
  assert.match(text, /event: message_stop/);
  assert.match(text, /mock reply/);

  // server captured the assistant turn: next request with the full history must not fork
  const turns = dream.store.readTurns('e2e-stream');
  assert.equal(turns.length, 2);
  const captured = turns[1] as { role: string; content: Array<{ type: string; text: string }> };
  assert.equal(captured.role, 'assistant');
  assert.match(captured.content[0]!.text, /mock reply/);
});

test('multi-turn conversation: prefix extension, no fork, savings appear after pressing', async () => {
  const convId = 'e2e-long';
  const history: unknown[] = [];
  let lastSavings = 0;
  // Drive 30 round trips with chunky user turns so the 2k budget overflows.
  for (let i = 0; i < 30; i++) {
    // Realistic agent traffic: a fact plus repetitive tool/log output that
    // the mechanical press can collapse.
    const filler = `turn ${i}: value=${i * 7}\n` + `2026-08-01T10:00:00Z INFO worker heartbeat ok latency=12ms seq=99999\n`.repeat(20);
    history.push(msg('user', filler));
    const res = await send(history, { convId });
    assert.equal(res.status, 200, `turn ${i} ok`);
    const data = (await res.json()) as { content: unknown };
    history.push(msg('assistant', data.content));
    lastSavings = Number(res.headers.get('x-dream-savings-pct'));
  }
  const meta = dream.store.getMeta(convId)!;
  assert.ok(meta.pressedUpTo > 0, 'history was pressed');
  assert.ok((meta.tierBlocks.t1 ?? []).length + (meta.tierBlocks.t2 ?? []).length > 0, 'tier blocks exist');
  assert.ok(lastSavings > 30, `expected >30% savings, got ${lastSavings}`);

  // upstream-received payload stayed within reason: memory prelude + tail
  const up = mock.lastRequest()!;
  const upMsgs = up.body.messages as Array<{ role: string; content: unknown }>;
  assert.ok(JSON.stringify(upMsgs).length < JSON.stringify(history).length * 0.7, 'window smaller than raw history');
  const first = upMsgs[0]!;
  assert.match(String(first.content), /dream-memory/);

  // No fork happened.
  assert.ok(!dream.store.listNamespaces().some((n) => n.startsWith(`${convId}-fork`)));
});

test('assembled prefix is byte-stable between molts (prompt-cache friendly)', async () => {
  const convId = 'e2e-long'; // continue prior conversation
  const history = [...(dream.store.readTurns(convId) as unknown[])];
  history.push(msg('user', 'short question?'));
  // First send may press (tail could be over budget). Subsequent sends of the
  // same history must not press and must produce a byte-identical prelude.
  await send(history, { convId });
  const r2 = await send(history, { convId });
  const a = JSON.stringify((mock.lastRequest()!.body.messages as unknown[])[0]);
  const r3 = await send(history, { convId });
  const b = JSON.stringify((mock.lastRequest()!.body.messages as unknown[])[0]);
  assert.equal(r2.headers.get('x-dream-cache'), 'stable');
  assert.equal(r3.headers.get('x-dream-cache'), 'stable');
  assert.equal(a, b, 'memory prelude byte-identical across requests');
});

test('client history edit forks the namespace instead of corrupting memory', async () => {
  const convId = 'e2e-fork';
  await send([msg('user', 'original first message')], { convId });
  const res = await send([msg('user', 'REWRITTEN first message')], { convId });
  assert.equal(res.status, 200);
  const namespaces = dream.store.listNamespaces();
  assert.ok(namespaces.includes('e2e-fork'));
  assert.ok(namespaces.includes('e2e-fork-fork-1'), `fork namespace created: ${namespaces.join(',')}`);
});

test('non-streaming dream tool loop: gateway resolves recall server-side', async () => {
  // Seed the graph so recall has something to find.
  dream.graph.upsert({ ns: 'e2e-tool', kind: 'fact', data: { subject: 'volume name', predicate: 'is', object: 'dream_data' } });
  const res = await send([msg('user', 'what is the volume name?')], {
    convId: 'e2e-tool',
    script: 'tool_use:dream_recall:{"query":"volume name"}',
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  assert.match(text, /dream_data/, 'final answer contains the recalled fact');
  assert.ok(!data.content.some((b) => b.type === 'tool_use'), 'no tool_use leaks to client');
});

test('streaming dream tool loop: spliced stream, zero dream_* events client-side', async () => {
  dream.graph.upsert({ ns: 'e2e-tool-s', kind: 'fact', data: { subject: 'deploy region', predicate: 'is', object: 'iad' } });
  const res = await send([msg('user', 'which region?')], {
    convId: 'e2e-tool-s',
    stream: true,
    script: 'tool_use:dream_recall:{"query":"deploy region"}',
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('dream_recall'), 'dream tool events suppressed');
  assert.match(text, /iad/, 'answer streamed with recalled fact');
  const stops = text.match(/event: message_stop/g) ?? [];
  assert.equal(stops.length, 1, 'exactly one terminal message_stop');
  const starts = text.match(/event: message_start/g) ?? [];
  assert.equal(starts.length, 1, 'exactly one message_start');
});

test('GET /blocks/:id serves original text; /stats reports store state', async () => {
  const blocks = dream.store.listBlocks('e2e-long');
  assert.ok(blocks.length > 0);
  const res = await fetch(`${base}/blocks/${blocks[0]!.id}`);
  assert.equal(res.status, 200);
  const b = (await res.json()) as { original: string; pressed: string };
  assert.ok(b.original.length >= b.pressed.length);

  const stats = (await (await fetch(`${base}/stats`)).json()) as { store: { blocks: number }; requests: { total: number } };
  assert.ok(stats.store.blocks > 0);
  assert.ok(stats.requests.total > 0);
});

test('upstream auth errors pass through', async () => {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' }, // no key
    body: JSON.stringify({ model: 'mock-model', max_tokens: 10, messages: [msg('user', 'hi')] }),
  });
  assert.equal(res.status, 401);
});
