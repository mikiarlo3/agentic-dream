# Connecting an app to Dream

The change is one line: the app keeps its SDK, request shape, streaming, and API key — only the base URL moves to the gateway.

## Find and edit the client construction

Grep the user's codebase for the client:
- JS/TS: `new Anthropic(` → add `baseURL: "<gateway-url>"` to the options object.
- Python: `Anthropic(` / `AsyncAnthropic(` → add `base_url="<gateway-url>"`.
- Raw HTTP: change the host of `POST /v1/messages` to the gateway.
- Env-var-driven apps: many respect `ANTHROPIC_BASE_URL` — if the code reads it, setting that env var is the least invasive change.

`<gateway-url>` is `http://localhost:8082` locally or `https://<app>.fly.dev` / the Render URL when hosted. No trailing slash.

## Conversation identity (recommend this)

Dream keys memory per conversation. By default it anchors on the first message, which works but forks (`<id>-fork-1`) if the client ever edits earlier history. Explicit is better — one header per conversation:

```js
client.messages.create({...}, { headers: { "x-dream-conversation-id": conversationId } })
```

```python
client.messages.create(..., extra_headers={"x-dream-conversation-id": conversation_id})
```

Any stable string works (a session id, a user id + thread id, etc.).

## What the app gets back

Responses carry `x-dream-*` headers: `x-dream-raw-tokens` (full history size), `x-dream-sent-tokens` (what was actually sent), `x-dream-savings-pct`, `x-dream-blocks`, `x-dream-cache` (`stable` = provider prompt cache preserved this turn). Useful for logging/monitoring; safe to ignore.

Dream also injects two memory tools (`dream_recall`, `dream_unpack`) and resolves them server-side — the app never sees them, streaming included. Opt out per request with header `x-dream-tools: off` if the upstream rejects tools.

## Auth model (explain to the user)

- The app sends its own `x-api-key` / `Authorization` exactly as before; Dream forwards it and never writes it to disk (in-memory only, 24h, for background consolidation).
- If the operator set `DREAM_MODEL_KEY` on the server, background jobs use that instead.
- `DREAM_ACCESS_TOKEN` protects only the dashboard/admin API — apps calling `/v1/messages` don't need it.

## Non-Anthropic models (OpenAI, Gemini, Mistral, local)

Dream speaks the Anthropic Messages API on both sides. To front other providers, put a translating proxy behind it:

```bash
pip install 'litellm[proxy]' && litellm --port 4000    # speaks Anthropic API, fronts 100+ providers
node dist/cli.js --upstream http://localhost:4000
```

The app still talks to Dream unchanged; model names in requests follow LiteLLM's naming. Hosted: run LiteLLM as a second service and set `UPSTREAM_BASE_URL` on Dream to its URL.

## Connect Claude itself (claude.ai / desktop / mobile / Claude Code)

Dream doubles as an MCP connector. The dashboard's "Use with Claude" page shows the personal connector URL (`<gateway-url>/mcp/<access-token>`, or `/mcp` when no token is set). Activation:
- claude.ai / Claude apps: Settings → Connectors → Add custom connector → paste the URL. Then enable Dream in the chat tools menu.
- Claude Code: `claude mcp add --transport http dream <connector-url>`

Claude then has dream_recall / dream_unpack / dream_conversations / dream_stats / dream_consolidate / dream_guide. Remind the user: the URL embeds the token — share it like a password, and never add a token-less public instance as a connector.

## Verify

Send one real request through the changed app and check:
1. A normal reply arrives (streaming still streams).
2. Response headers include `x-dream-conversation-id`.
3. The conversation appears in the dashboard under Conversations within seconds.
