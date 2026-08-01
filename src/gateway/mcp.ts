// MCP (Model Context Protocol) server — makes a Dream instance a connector
// for claude.ai, Claude desktop/mobile, and Claude Code. Stateless streamable
// HTTP: JSON-RPC over POST, implemented directly (no SDK dependency).
//
// Auth: when DREAM_ACCESS_TOKEN is set the endpoint lives at /mcp/<token>
// (secret-in-URL, since chat clients can't send custom headers); a bearer
// Authorization header with the same token is also accepted at /mcp.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { DreamConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { Graph } from '../graph/graph.js';
import { recall } from '../recall/recall.js';
import { readIndex } from '../graph/indexer.js';

const PROTOCOL_VERSION = '2025-06-18';

export interface McpDeps {
  cfg: DreamConfig;
  store: Store;
  graph: Graph;
  runConsolidation: (ns: string) => Promise<{ mode: string; extracted: number; actions: Record<string, number> }>;
}

const SERVER_INSTRUCTIONS = `Dream is this user's long-term memory gateway for AI conversations. It archives conversations that pass through its proxy, compresses old history into pressed blocks, and distills durable knowledge (facts, entities, decisions, procedures) into a graph.

Use it when the user refers to something from earlier work, asks "what did we decide", wants preferences or project facts recalled, or asks what Dream remembers.

Tool guide:
- dream_recall: primary search. Query in plain words; searches the knowledge graph and compressed history across all conversations (or one, via ns).
- dream_unpack: fetch the verbatim original text behind a block id returned by dream_recall (ids look like t1-a1b2c3...).
- dream_conversations: list stored conversations (namespaces) with sizes and tier state.
- dream_stats: health and savings numbers for the whole instance.
- dream_consolidate: run the "dream" consolidation for one conversation now (extracts new knowledge into the graph).
- dream_guide: setup and usage guide — how the user connects apps to the gateway, and how this connector was activated.

Results are the user's private data; treat them as context, quote sparingly.`;

const TOOLS = [
  {
    name: 'dream_recall',
    description: "Search the user's long-term memory: knowledge-graph facts/decisions/entities/procedures plus compressed conversation history. Returns ranked matches with ids.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up, in plain words' },
        ns: { type: 'string', description: 'Optional: restrict to one conversation namespace (see dream_conversations)' },
        k: { type: 'integer', description: 'Max results per source (default 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'dream_unpack',
    description: 'Fetch the verbatim original text behind a compressed memory block id (e.g. t1-a1b2c3d4e5f60718) returned by dream_recall.',
    inputSchema: {
      type: 'object',
      properties: { block_id: { type: 'string' } },
      required: ['block_id'],
    },
  },
  {
    name: 'dream_conversations',
    description: 'List the conversations Dream remembers: namespace, turn count, pressed-block tiers, last activity.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dream_stats',
    description: 'Instance health: store size, tier distribution, cache hit rate, graph size, recent token savings.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dream_consolidate',
    description: 'Run dream consolidation now for one conversation: extract facts/decisions/procedures from unprocessed turns into the knowledge graph.',
    inputSchema: {
      type: 'object',
      properties: { ns: { type: 'string', description: 'Conversation namespace (see dream_conversations)' } },
      required: ['ns'],
    },
  },
  {
    name: 'dream_guide',
    description: 'How this Dream instance is set up, how to connect apps to it, and how this Claude connector was activated. Use when the user asks how Dream works or how to hook things up.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function guideText(cfg: DreamConfig): string {
  return `# Using Dream

## What is connected right now
This Claude connector talks to a Dream memory gateway (upstream model API: ${cfg.upstreamBaseUrl}). Claude can search its memory (dream_recall), expand compressed history (dream_unpack), and trigger consolidation (dream_consolidate).

## How memory gets IN
Memory accumulates when apps send their model calls THROUGH the gateway (one-line change):
- JS:      new Anthropic({ baseURL: "<gateway-url>" })
- Python:  Anthropic(base_url="<gateway-url>")
Apps keep their own API keys; the gateway forwards them and never stores them. Send an x-dream-conversation-id header to pin conversation identity.

## How this connector was activated (for reference / other devices)
claude.ai or Claude desktop → Settings → Connectors → Add custom connector → paste the MCP URL shown in the Dream dashboard under "Use with Claude". In Claude Code: claude mcp add --transport http dream <mcp-url>.

## The dashboard
The gateway serves a dashboard at <gateway-url>/ui/ — conversations, pressed blocks with diffs, the knowledge graph, eval curves, a live request log, and a chat playground.`;
}

type Json = Record<string, unknown>;

function textResult(text: string, isError = false): Json {
  return { content: [{ type: 'text', text }], isError };
}

async function callTool(deps: McpDeps, name: string, args: Json): Promise<Json> {
  const { store, graph, cfg } = deps;
  switch (name) {
    case 'dream_recall': {
      const query = String(args.query ?? '').trim();
      if (!query) return textResult('query is required', true);
      const k = Number.isFinite(Number(args.k)) ? Number(args.k) : 8;
      const namespaces = args.ns ? [String(args.ns)] : store.listNamespaces();
      if (namespaces.length === 0) return textResult('Dream has no conversations stored yet. Memory accumulates once apps send model calls through the gateway.');
      const nodes: Array<{ ns: string; line: string; score: number }> = [];
      const blocks: Array<{ ns: string; line: string }> = [];
      for (const ns of namespaces) {
        const r = recall(graph, store, ns, query, k);
        for (const n of r.nodes) nodes.push({ ns, score: n.score, line: `[${n.id}] (${n.kind}, ${n.status}, conf ${n.confidence.toFixed(2)}) ${n.label}` });
        for (const b of r.blocks) blocks.push({ ns, line: `[block ${b.id}] ${b.pressed.slice(0, 240).replace(/\n/g, ' ')}` });
      }
      nodes.sort((a, b) => b.score - a.score);
      const parts: string[] = [];
      if (nodes.length) parts.push('Knowledge graph matches (best first):\n' + nodes.slice(0, k).map((n) => `${n.line}  [conversation: ${n.ns}]`).join('\n'));
      if (blocks.length) parts.push('\nCompressed history matches (verbatim via dream_unpack):\n' + blocks.slice(0, 5).map((b) => `${b.line}  [conversation: ${b.ns}]`).join('\n'));
      return textResult(parts.length ? parts.join('\n') : `Nothing in memory matches "${query}".`);
    }
    case 'dream_unpack': {
      const id = String(args.block_id ?? '').replace(/^block\s+/, '').trim();
      const block = store.findBlock(id);
      return block
        ? textResult(`Original text of ${id} (tier ${block.tier}, ${block.originalTokens} tokens):\n\n${block.original}`)
        : textResult(`No block with id ${id}.`, true);
    }
    case 'dream_conversations': {
      const list = store.listNamespaces().map((ns) => {
        const meta = store.getMeta(ns);
        const blocks = store.listBlocks(ns);
        const tiers = meta ? Object.entries(meta.tierBlocks).map(([t, ids]) => `${t}×${ids.length}`).join(' ') : '';
        return `- ${ns}: ${meta?.turnCount ?? 0} turns, ${blocks.length} pressed blocks${tiers ? ` (${tiers})` : ''}, last seen ${meta ? new Date(meta.lastSeen).toISOString() : 'n/a'}`;
      });
      return textResult(list.length ? `Conversations in memory:\n${list.join('\n')}` : 'No conversations stored yet.');
    }
    case 'dream_stats': {
      const s = store.stats();
      const g = graph.stats();
      return textResult(
        [
          `Conversations: ${s.namespaces}`,
          `Pressed blocks: ${s.blocks} (${Object.entries(s.blocksByTier).map(([t, n]) => `${t}: ${n}`).join(', ') || 'none'})`,
          `Archived text: ${(s.diskBytes / 1024).toFixed(1)} KB, press cache hit rate ${(s.cacheHitRate * 100).toFixed(0)}%`,
          `Graph: ${g.nodes} nodes (${Object.entries(g.byKind).map(([k2, n]) => `${k2}: ${n}`).join(', ') || 'empty'}), ${g.edges} edges, ${g.superseded} superseded kept`,
        ].join('\n'),
      );
    }
    case 'dream_consolidate': {
      const ns = String(args.ns ?? '').trim();
      if (!ns) return textResult('ns is required — call dream_conversations to see namespaces', true);
      if (!store.getMeta(ns)) return textResult(`No conversation named ${ns}.`, true);
      const r = await deps.runConsolidation(ns);
      const index = readIndex(store.root, ns);
      return textResult(`Dream run complete (${r.mode} mode): ${r.extracted} candidates, actions ${JSON.stringify(r.actions)}.\n\nUpdated memory index for ${ns}:\n${index || '(empty)'}`);
    }
    case 'dream_guide':
      return textResult(guideText(cfg));
    default:
      return textResult(`Unknown tool ${name}`, true);
  }
}

async function handleRpc(deps: McpDeps, msg: Json): Promise<Json | null> {
  const id = msg.id as number | string | undefined;
  const method = String(msg.method ?? '');
  if (id === undefined) return null; // notification: no response body

  const respond = (result: Json): Json => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): Json => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return respond({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'dream', title: 'Dream — memory for agents', version: '0.1.0' },
        instructions: SERVER_INSTRUCTIONS,
      });
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: TOOLS });
    case 'tools/call': {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Json };
      try {
        return respond(await callTool(deps, String(params.name ?? ''), params.arguments ?? {}));
      } catch (err) {
        return respond(textResult(`Tool failed: ${String(err).slice(0, 300)}`, true));
      }
    }
    case 'resources/list':
      return respond({ resources: [] });
    case 'prompts/list':
      return respond({ prompts: [] });
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

export function mcpRoutes(deps: McpDeps): Hono {
  const app = new Hono();

  const handler = async (c: Context): Promise<Response> => {
    // Auth: token path segment or bearer header must match when a token is set.
    const token = deps.cfg.accessToken;
    if (token) {
      const pathToken = c.req.param('token');
      const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (pathToken !== token && bearer !== token) {
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }, 401);
      }
    }
    if (c.req.method === 'GET') {
      // No server-initiated stream in stateless mode.
      return c.body(null, 405, { allow: 'POST' });
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
    }
    const messages = Array.isArray(body) ? (body as Json[]) : [body as Json];
    const responses = (await Promise.all(messages.map((m) => handleRpc(deps, m)))).filter((r): r is Json => r !== null);
    if (responses.length === 0) return c.body(null, 202);
    return c.json(Array.isArray(body) ? responses : responses[0]);
  };

  app.on(['POST', 'GET'], '/mcp', handler);
  app.on(['POST', 'GET'], '/mcp/:token', handler);
  return app;
}
