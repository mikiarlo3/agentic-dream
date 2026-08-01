# 🌙 Dream

**A memory system for agents. The model is the engine; Dream is everything that remembers.**

Dream sits between your app and any language model as a drop-in proxy. It keeps everything the agent has ever seen, compresses older history into tiers, distills what was *learned* into a knowledge graph, and feeds each model call the smallest set of tokens that call actually needs. Consolidation happens after the conversation goes idle — like sleep.

You change **one line** in your app. Everything else stays the same: same SDK, same request shape, same response.

```js
const client = new Anthropic({ baseURL: "http://localhost:8082" });
```

---

## Try it in 60 seconds (no API key needed)

```bash
git clone https://github.com/mikiarlo3/agentic-dream && cd agentic-dream
npm install
npm run demo
```

Then open **http://localhost:8082/ui/** — a demo conversation has already been proxied through a built-in fake model, so you can explore pressed blocks, the memory index, the knowledge graph, and the dashboard with real data in it.

## Install with Claude Code (easiest)

The repo ships a Claude Code skill. Clone it, open Claude Code inside, and just say what you want:

> **install dream** · *put this online* · *connect my app to dream* · *my fly deploy failed*

Claude runs the setup for you — local runs, cloud deploys (with the sharp edges pre-blunted), wiring your codebase to the gateway, and troubleshooting. Works for non-technical users too: it explains each step in plain language as it goes. You can also invoke it directly with `/install-dream`.

## Run it for real

```bash
npm install && npm run build
node dist/cli.js                 # or: npx agentic-dream (once published)
```

```
🌙 Dream is awake.
gateway    http://localhost:8082/v1/messages
dashboard  http://localhost:8082/ui/
```

Point your app at it — your API key passes straight through to the model provider on every request; **Dream never stores it**:

| Your app uses | Change |
|---|---|
| Anthropic SDK (JS) | `new Anthropic({ baseURL: "http://localhost:8082" })` |
| Anthropic SDK (Python) | `Anthropic(base_url="http://localhost:8082")` |
| Raw HTTP | POST to `http://localhost:8082/v1/messages` as usual |
| **Any other LLM** (OpenAI, Gemini, Mistral, local models) | Run a translating proxy such as [LiteLLM](https://github.com/BerriAI/litellm) and start Dream with `--upstream http://localhost:4000`. Your app talks to Dream; Dream forwards to any model behind the translator. |

Useful flags: `--port`, `--store <dir>`, `--upstream <url>`, `--token <dashboard-password>`, `--budget <tokens>`. Every flag is also an env var (`PORT`, `DREAM_STORE_DIR`, `UPSTREAM_BASE_URL`, `DREAM_ACCESS_TOKEN`, `DREAM_WINDOW_BUDGET`).

---

## Host it in the cloud

### Easiest — one click, no terminal

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/mikiarlo3/agentic-dream)

1. Click the button and sign in to (or create) a Render account.
2. Click **Deploy**. That's it — Render builds the app and gives you a URL like `https://agentic-dream.onrender.com`.
3. Open `<your URL>/ui/`. The dashboard asks for an access token: find it in your Render service under **Environment → DREAM_ACCESS_TOKEN** (Render generated a strong one for you).
4. Go to **Playground**, paste your model API key, and chat. Your key never leaves your browser except to pass through to the model provider.

> The config uses Render's Starter plan because memory needs a persistent disk — on the free tier everything Dream remembers would vanish on every restart.

### Fly.io (recommended for production)

Dream ships ready to deploy with a persistent volume:

```bash
# one-time setup — use `fly deploy`, not `fly launch` (launch re-plans the
# config and proposes 2 machines; Dream must run exactly one)
fly apps create <your-app-name>            # then put the name in fly.toml
fly volumes create dream_data --size 1 --region ams   # match primary_region in fly.toml
fly secrets set DREAM_ACCESS_TOKEN=<choose-a-strong-token>
fly deploy --ha=false
```

> Seeing `requested machine count exceeds organization limit`? Two causes, usually together: (1) you ran `fly launch`, which proposes a 2-machine HA setup — use `fly deploy --ha=false` instead; (2) a brand-new Fly organization can't place any machines until a payment method is added in the [billing dashboard](https://fly.io/dashboard).

**Continuous deploys:** add a `FLY_API_TOKEN` secret to the GitHub repo (Settings → Secrets → Actions) and every push deploys automatically after tests and the eval regression gate pass. Without the secret, CI still runs tests and skips the deploy step cleanly.

> ⚠️ **Run exactly one machine.** Memory is SQLite + files on a local volume. `fly scale count 2` would give each machine a different brain. The config pins `min_machines_running = 1` and disables auto-stop (the consolidation scheduler runs in-process).

### Docker (any server)

```bash
docker build -t dream .
docker run -d -p 8082:8082 -v dream-data:/data \
  -e DREAM_ACCESS_TOKEN=<choose-a-strong-token> dream
```

### Hosted-mode security model

- `/v1/messages` is open passthrough: callers bring their own model API key, exactly like talking to the provider directly. Dream holds keys **in memory only** (24 h TTL, never written to disk or logs) so background consolidation can reuse the caller's key; set `DREAM_MODEL_KEY` instead to give background jobs a dedicated key, or set neither — consolidation then falls back to model-free heuristics and says so in `/stats`.
- The dashboard and every `/api/*` endpoint require `DREAM_ACCESS_TOKEN` when set. Set it for anything reachable from the internet — the store contains full transcripts, the most sensitive artifact the system produces.
- `/healthz` is unauthenticated (for load-balancer checks) and reveals only counts.

---

## Use it from Claude (claude.ai, desktop, mobile) — it's a connector

Every Dream instance is also an **MCP connector**. Add it to Claude once, and Claude can search your memory, expand compressed history, and run consolidations from any chat — "what does Dream remember about the deploy decision?" just works.

**Activate it (2 minutes):**
1. Open your Dream dashboard → **Use with Claude** — it shows your personal connector URL (your access token embedded, so treat the URL like a password).
2. In claude.ai (or the Claude desktop app): **Settings → Connectors → Add custom connector** → name it `Dream`, paste the URL, save. No OAuth setup needed.
3. In a chat, enable Dream in the tools menu and ask away.

Claude Code works too: `claude mcp add --transport http dream <your-connector-url>`.

Connected Claude gets six tools — `dream_recall`, `dream_unpack`, `dream_conversations`, `dream_stats`, `dream_consolidate`, and `dream_guide` (a built-in guide Claude reads to explain your setup back to you). The connector *reads* memory; conversations get *into* memory through apps that use the gateway as their base URL.

## What you get

| Component | What it does |
|---|---|
| **Gateway** | Speaks the Anthropic Messages API. Intercepts `POST /v1/messages`, swaps the message history for an assembled window (raw recent tail + pressed tiers + graph index), forwards upstream, streams back untouched. Adds `x-dream-*` headers reporting raw vs sent tokens. |
| **Press** | Compression. Mechanical (normalize + fingerprint + dedupe — free, no model), semantic (a cheap model rewrites as telegraphic notes), salience extraction for tier 2+ recursion. Stops automatically when a tier fails to shrink ≥15%. |
| **Store** | Content-addressed archive: a block is pressed once, ever. Any pressed block expands back to its original wording via `GET /blocks/:id` — compression is non-destructive. |
| **Graph** | Facts, entities, decisions, procedures, episodes; `about`/`derived_from`/`supersedes`/`used_in` edges. Nothing is deleted — "why did you change your mind?" always has an answer with provenance. |
| **Dream loop** | After a conversation goes idle: extract → reconcile (confirm / insert / supersede) → reindex → decay → promote. Procedures with 5 clean successes compile to skill files. |
| **Recall** | `dream_recall` and `dream_unpack` are injected as tools (opt out with `x-dream-tools: off`). The model can search its own memory mid-task and fetch verbatim originals; the gateway resolves these server-side — your app never sees them, in streaming mode too. |
| **Eval** | `npm run eval` presses a session through every tier, quizzes each tier against ground-truth probes, writes the retention curve, and **fails CI** if tier 1 drops below 90% or tier 2 below 60%. |
| **Dashboard** | `/ui/` — stats, conversations, block diffs, graph explorer, recall playground, eval curves, skills, live request log, and a chat playground. |

### Measured loss curve (synthetic 100-turn session, 25 planted facts, mechanical backend)

| Tier | Tokens | Ratio | Retention |
|---|---|---|---|
| 0 | 8,803 | 1× | 100% |
| 1 | 3,654 | 2× | 100% |
| 2 | 1,785 | 5× | 100% |
| 3 | 838 | 11× | 72% |
| 4 | 395 | 22× | 52% |
| 5 | 197 | 45× | 36% — the cliff |

Usable depth without a model: tier 2–3. The eval harness re-measures this on every CI run.

## HTTP surface

```
POST /v1/messages        the proxy (Anthropic Messages API, streaming supported)
GET  /blocks/:id         original text behind any pressed block
POST /recall             {ns, query, k} → ranked graph nodes + matching blocks
GET  /stats              store size, tier distribution, cache hit rate, dream runs
GET  /healthz            liveness (unauthenticated)
GET  /ui/                dashboard
POST /api/dream/run      {ns} → run consolidation now
```

Send `x-dream-conversation-id: <your-id>` to pin memory identity explicitly (recommended). Otherwise the first turn anchors it; if a client edits history, Dream forks the namespace rather than corrupting memory.

## Development

```bash
npm run dev     # gateway with hot reload
npm test        # unit + e2e against a built-in mock upstream (no API key)
npm run eval    # retention regression
npm run demo    # populated instance against a fake model
```

The architecture document lives in [`docs/architecture.md`](docs/architecture.md).
