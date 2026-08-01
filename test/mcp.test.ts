import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { createServer, type DreamServer } from '../src/server.js';

let dream: DreamServer;
let server: ServerType;
let base: string;
let storeDir: string;

before(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'dream-mcp-'));
  dream = createServer({
    DREAM_STORE_DIR: storeDir,
    DREAM_ACCESS_TOKEN: 'sekret',
    DREAM_IDLE_CONSOLIDATE_MS: '999999',
    DREAM_SWEEP_INTERVAL_MS: '999999',
  } as NodeJS.ProcessEnv);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: dream.app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
  // Seed memory.
  dream.store.appendTurns('proj', [{ role: 'user', content: 'the volume name is dream_data' }]);
  dream.store.putMeta({ id: 'proj', ns: 'proj', createdAt: 1, lastSeen: 2, turnCount: 1, turnHashes: ['x'], pressedUpTo: 0, consolidatedUpTo: 0, tierBlocks: {} });
  dream.graph.upsert({ ns: 'proj', kind: 'decision', data: { choice: 'use fly volumes', rationale: 'persistence' } });
});

after(() => {
  server.close();
  rmSync(storeDir, { recursive: true, force: true });
});

async function rpc(pathOrAuth: { path?: string; bearer?: string }, method: string, params?: unknown, id: number | undefined = 1) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (pathOrAuth.bearer) headers.authorization = `Bearer ${pathOrAuth.bearer}`;
  const res = await fetch(`${base}${pathOrAuth.path ?? '/mcp'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) }),
  });
  return res;
}

test('mcp requires the token (path or bearer)', async () => {
  assert.equal((await rpc({}, 'initialize')).status, 401);
  assert.equal((await rpc({ path: '/mcp/wrong' }, 'initialize')).status, 401);
  assert.equal((await rpc({ path: '/mcp/sekret' }, 'initialize')).status, 200);
  assert.equal((await rpc({ bearer: 'sekret' }, 'initialize')).status, 200);
});

test('initialize returns protocol, server info, and instructions', async () => {
  const res = await rpc({ path: '/mcp/sekret' }, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const body = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string }; instructions: string } };
  assert.equal(body.result.serverInfo.name, 'dream');
  assert.ok(body.result.protocolVersion);
  assert.match(body.result.instructions, /dream_recall/);
});

test('notifications get 202 with no body', async () => {
  const res = await fetch(`${base}/mcp/sekret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(res.status, 202);
});

test('tools/list exposes the six dream tools', async () => {
  const res = await rpc({ path: '/mcp/sekret' }, 'tools/list');
  const body = (await res.json()) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
  const names = body.result.tools.map((t) => t.name);
  for (const n of ['dream_recall', 'dream_unpack', 'dream_conversations', 'dream_stats', 'dream_consolidate', 'dream_guide']) {
    assert.ok(names.includes(n), `${n} present`);
  }
  assert.ok(body.result.tools.every((t) => t.inputSchema));
});

test('tools/call dream_recall finds seeded memory across namespaces', async () => {
  const res = await rpc({ path: '/mcp/sekret' }, 'tools/call', { name: 'dream_recall', arguments: { query: 'fly volumes' } });
  const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  assert.ok(!body.result.isError);
  assert.match(body.result.content[0]!.text, /use fly volumes/);
});

test('tools/call dream_conversations and dream_stats work', async () => {
  const conv = (await (await rpc({ path: '/mcp/sekret' }, 'tools/call', { name: 'dream_conversations', arguments: {} })).json()) as { result: { content: Array<{ text: string }> } };
  assert.match(conv.result.content[0]!.text, /proj: 1 turns/);
  const stats = (await (await rpc({ path: '/mcp/sekret' }, 'tools/call', { name: 'dream_stats', arguments: {} })).json()) as { result: { content: Array<{ text: string }> } };
  assert.match(stats.result.content[0]!.text, /Graph: \d+ nodes/);
});

test('tools/call dream_guide returns the activation guide', async () => {
  const res = await rpc({ path: '/mcp/sekret' }, 'tools/call', { name: 'dream_guide', arguments: {} });
  const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
  assert.match(body.result.content[0]!.text, /Add custom connector/);
});

test('unknown method returns JSON-RPC error, GET returns 405', async () => {
  const res = await rpc({ path: '/mcp/sekret' }, 'no/such');
  const body = (await res.json()) as { error: { code: number } };
  assert.equal(body.error.code, -32601);
  assert.equal((await fetch(`${base}/mcp/sekret`)).status, 405);
});
