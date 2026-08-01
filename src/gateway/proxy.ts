import type { Context } from 'hono';
import type { DreamConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { Graph } from '../graph/graph.js';
import type { ConversationMeta, RequestLogEntry, Turn, WindowStats } from '../types.js';
import { Keyring } from './keyring.js';
import { resolveConversationId, syncConversation, appendAssistantTurn } from './conversation.js';
import { assembleWindow } from '../window/assemble.js';
import { readIndex } from '../graph/indexer.js';
import { SseParser, MessageAccumulator, formatSse, type SseEvent } from './sse.js';
import { injectTools, isDreamTool, executeDreamTool } from './toolInjection.js';

const FORWARD_HEADERS = ['x-api-key', 'authorization', 'anthropic-version', 'anthropic-beta', 'content-type', 'x-mock-script'];
const MAX_TOOL_HOPS = 3;

export interface ProxyDeps {
  cfg: DreamConfig;
  store: Store;
  graph: Graph;
  keyring: Keyring;
  requestLog: RequestLogEntry[];
  /** Called after a turn completes, to arm the consolidation idle timer. */
  onActivity?: (ns: string, convId: string) => void;
}

function upstreamHeaders(c: Context): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of FORWARD_HEADERS) {
    const v = c.req.header(h);
    if (v) out[h] = v;
  }
  return out;
}

function logEntry(deps: ProxyDeps, entry: RequestLogEntry): void {
  deps.requestLog.push(entry);
  if (deps.requestLog.length > 200) deps.requestLog.shift();
}

function dreamHeaders(convId: string, stats: WindowStats | null): Record<string, string> {
  if (!stats) return { 'x-dream-conversation-id': convId, 'x-dream-bypass': 'true' };
  return {
    'x-dream-conversation-id': convId,
    'x-dream-raw-tokens': String(stats.rawTokens),
    'x-dream-sent-tokens': String(stats.sentTokens),
    'x-dream-savings-pct': String(stats.savingsPct),
    'x-dream-blocks': String(stats.blocks),
    'x-dream-cache': stats.pressed ? 'pressed' : 'stable',
  };
}

export async function handleMessages(c: Context, deps: ProxyDeps): Promise<Response> {
  const { cfg, store, graph, keyring } = deps;
  const started = Date.now();

  const raw = await c.req.text();
  if (raw.length > cfg.maxBodyBytes) {
    return c.json({ type: 'error', error: { type: 'request_too_large', message: 'body exceeds gateway limit' } }, 413);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }, 400);
  }
  if (!Array.isArray(body.messages)) {
    return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages required' } }, 400);
  }

  const headers = upstreamHeaders(c);
  const incoming = body.messages as Turn[];
  const convId = resolveConversationId({ 'x-dream-conversation-id': c.req.header('x-dream-conversation-id') }, { system: body.system, messages: incoming });
  keyring.remember(convId, headers);

  const { meta, ns, replay } = syncConversation(store, convId, incoming);
  const allTurns = store.readTurns(ns) as Turn[];

  // Assemble the window (may press synchronously, mechanical only).
  const indexText = readIndex(store.root, ns);
  const { messages, stats } = await assembleWindow(store, meta, allTurns, indexText, cfg);
  body.messages = messages as unknown[];

  const toolsEnabled = c.req.header('x-dream-tools') !== 'off';
  if (toolsEnabled) injectTools(body);

  const stream = body.stream === true;
  const url = `${cfg.upstreamBaseUrl}/v1/messages`;
  const doFetch = (b: Record<string, unknown>) =>
    fetch(url, { method: 'POST', headers, body: JSON.stringify(b) });

  const finish = (status: number, usage?: { input_tokens?: number; output_tokens?: number }, hops?: number) => {
    logEntry(deps, {
      ts: started,
      convId,
      model: String(body.model ?? '?'),
      stream,
      status,
      latencyMs: Date.now() - started,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      dream: stats,
      dreamToolHops: hops,
    });
    deps.onActivity?.(ns, convId);
  };

  try {
    if (!stream) {
      return await handleNonStreaming(c, deps, { body, headers, doFetch, meta, ns, convId, stats, finish, replay });
    }
    return await handleStreaming(c, deps, { body, headers, doFetch, meta, ns, convId, stats, finish, replay });
  } catch (err) {
    finish(502);
    return c.json({ type: 'error', error: { type: 'api_error', message: `dream gateway: upstream unreachable (${String(err).slice(0, 120)})` } }, 502);
  }
}

interface HopCtx {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  doFetch: (b: Record<string, unknown>) => Promise<Response>;
  meta: ConversationMeta;
  ns: string;
  convId: string;
  stats: WindowStats;
  finish: (status: number, usage?: { input_tokens?: number; output_tokens?: number }, hops?: number) => void;
  /** Replayed request: reply already captured once, don't capture again. */
  replay: boolean;
}

async function handleNonStreaming(c: Context, deps: ProxyDeps, hc: HopCtx): Promise<Response> {
  const { store, graph } = deps;
  let hops = 0;
  let workingMessages = hc.body.messages as unknown[];
  let res = await hc.doFetch(hc.body);

  while (res.ok && hops < MAX_TOOL_HOPS) {
    const data = (await res.json()) as Record<string, unknown>;
    const content = (data.content ?? []) as Array<Record<string, unknown>>;
    const toolUses = content.filter((b) => b.type === 'tool_use');
    const dreamUses = toolUses.filter((b) => isDreamTool(b.name));

    if (data.stop_reason === 'tool_use' && dreamUses.length > 0 && dreamUses.length === toolUses.length) {
      hops++;
      const results = dreamUses.map((tu) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: executeDreamTool(graph, store, hc.ns, String(tu.name), (tu.input ?? {}) as Record<string, unknown>),
      }));
      workingMessages = [...workingMessages, { role: 'assistant', content }, { role: 'user', content: results }];
      hc.body.messages = workingMessages;
      res = await hc.doFetch(hc.body);
      continue;
    }

    // Terminal response: capture and return.
    if (!hc.replay && data.role === 'assistant' && Array.isArray(data.content)) {
      appendAssistantTurn(store, hc.meta, data.content);
    }
    const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    hc.finish(200, usage, hops);
    return c.newResponse(JSON.stringify(data), 200, {
      'content-type': 'application/json',
      ...dreamHeaders(hc.convId, hc.stats),
    });
  }

  // Upstream error (or hop limit hit with an error response pending).
  const text = await res.text();
  hc.finish(res.status);
  return c.newResponse(text, res.status as 400, {
    'content-type': res.headers.get('content-type') ?? 'application/json',
    ...dreamHeaders(hc.convId, hc.stats),
  });
}

async function handleStreaming(c: Context, deps: ProxyDeps, hc: HopCtx): Promise<Response> {
  const { store, graph } = deps;
  const first = await hc.doFetch(hc.body);
  if (!first.ok || !first.body) {
    const text = await first.text();
    hc.finish(first.status);
    return c.newResponse(text, first.status as 400, {
      'content-type': first.headers.get('content-type') ?? 'application/json',
      ...dreamHeaders(hc.convId, hc.stats),
    });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const streamOut = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      let hops = 0;
      let upstreamBody: ReadableStream<Uint8Array> = first.body!;
      // Client-visible content block indexing (for renumbering continuations).
      let clientBlockCount = 0;
      let usage: { input_tokens?: number; output_tokens?: number } = {};

      try {
        for (;;) {
          const parser = new SseParser();
          const acc = new MessageAccumulator();
          const reader = upstreamBody.getReader();
          // index map for this hop: upstream index -> client index (-1 = swallowed)
          const indexMap = new Map<number, number>();
          let sawDreamTool = false;
          const heldTerminal: SseEvent[] = [];
          const isContinuation = hops > 0;

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
              acc.feedEvent(ev);
              const d = ev.data as Record<string, unknown>;

              if (ev.event === 'message_start') {
                if (!isContinuation) controller.enqueue(encoder.encode(ev.raw));
                continue;
              }
              if (ev.event === 'ping') {
                controller.enqueue(encoder.encode(ev.raw));
                continue;
              }
              if (ev.event === 'content_block_start') {
                const upIdx = Number(d.index ?? 0);
                const block = d.content_block as Record<string, unknown>;
                if (block?.type === 'tool_use' && isDreamTool(block.name)) {
                  indexMap.set(upIdx, -1);
                  sawDreamTool = true;
                  continue;
                }
                indexMap.set(upIdx, clientBlockCount++);
                const mapped = indexMap.get(upIdx)!;
                if (!isContinuation && mapped === upIdx) controller.enqueue(encoder.encode(ev.raw));
                else controller.enqueue(encoder.encode(formatSse(ev.event, { ...d, index: mapped })));
                continue;
              }
              if (ev.event === 'content_block_delta' || ev.event === 'content_block_stop') {
                const upIdx = Number(d.index ?? 0);
                const mapped = indexMap.get(upIdx);
                if (mapped === -1) continue; // swallowed dream tool block
                if (mapped === undefined) continue;
                if (!isContinuation && mapped === upIdx) controller.enqueue(encoder.encode(ev.raw));
                else controller.enqueue(encoder.encode(formatSse(ev.event, { ...d, index: mapped })));
                continue;
              }
              if (ev.event === 'message_delta' || ev.event === 'message_stop') {
                heldTerminal.push(ev);
                continue;
              }
              // Unknown events: forward untouched.
              controller.enqueue(encoder.encode(ev.raw));
            }
          }

          usage = { ...usage, ...acc.message.usage };
          const dreamUses = acc.message.content.filter((b) => b.type === 'tool_use' && isDreamTool(b.name));

          if (sawDreamTool && acc.message.stop_reason === 'tool_use' && dreamUses.length > 0 && hops < MAX_TOOL_HOPS) {
            // Run the dream tools, extend the upstream conversation, continue streaming.
            hops++;
            const results = dreamUses.map((tu) => ({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: executeDreamTool(graph, store, hc.ns, String(tu.name), (tu.input ?? {}) as Record<string, unknown>),
            }));
            hc.body.messages = [...(hc.body.messages as unknown[]), { role: 'assistant', content: acc.message.content }, { role: 'user', content: results }];
            const next = await hc.doFetch(hc.body);
            if (!next.ok || !next.body) {
              controller.enqueue(encoder.encode(formatSse('error', { type: 'error', error: { type: 'api_error', message: `dream tool continuation failed (${next.status})` } })));
              break;
            }
            upstreamBody = next.body;
            continue;
          }

          // Terminal hop: flush held terminal events (rewrite stop_reason if the
          // only tool_use blocks were dream tools that we resolved).
          for (const ev of heldTerminal) {
            controller.enqueue(encoder.encode(ev.raw));
          }
          // Capture: client-visible content only (dream tool blocks excluded).
          const visible = acc.message.content.filter((b) => !(b.type === 'tool_use' && isDreamTool(b.name)));
          if (!hc.replay && visible.length > 0) appendAssistantTurn(store, hc.meta, visible);
          hc.finish(200, usage, hops);
          break;
        }
      } catch (err) {
        controller.enqueue(encoder.encode(formatSse('error', { type: 'error', error: { type: 'api_error', message: String(err).slice(0, 200) } })));
        hc.finish(502);
      } finally {
        controller.close();
      }
    },
  });

  return c.newResponse(streamOut, 200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...dreamHeaders(hc.convId, hc.stats),
  });
}
