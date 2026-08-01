---
name: install-dream
description: Install, run, deploy, and connect Dream — the memory gateway in this repo. Use when the user wants to set up Dream, try the demo, get it running locally or online, host/deploy it (Fly.io, Render, Docker), connect an app or agent to the gateway, add memory to their AI app, or fix a Dream setup problem (deploy errors, access token, machine limits, "nothing is compressing"). Also triggers on plain-language asks like "get this running", "put this online", or "help me install this".
---

# Install Dream

Dream is a memory gateway: apps point their Anthropic-SDK `baseURL` at it, and it remembers conversations, compresses old history, and feeds each model call only what it needs. Your job with this skill is to get the user from "cloned repo" to a working, verified setup — doing the steps for them wherever possible.

## First: pick the flow

Figure out which of these the user wants (ask with AskUserQuestion only if genuinely ambiguous):

1. **Try it / run locally** — "get it running", "try the demo", "start it"
2. **Deploy to hosting** — "put it online", "deploy", "host it", Fly/Render/Docker mentioned
3. **Connect an app** — "wire up my agent", "add memory to my app", "use it from my code"
4. **Troubleshoot** — an error message, or something isn't behaving

For flows 2 and 3, read `references/deploy.md` or `references/connect.md` before acting. Flows 1 and 4 are fully covered below.

## Calibrate your language

This skill gets used by non-technical people. Watch for cues: if the user doesn't sound like a developer, avoid jargon (say "web address" not "endpoint", "password" not "bearer token"), explain what each command does in one short sentence before running it, and never paste more than one command at a time at them — better yet, run the commands yourself and narrate the outcome.

## Flow 1 — Try it / run locally

**Fastest path (no API key needed):**

```bash
npm install
npm run demo
```

The demo boots Dream against a built-in fake model, feeds a seeded conversation through it, and runs a consolidation — then open **http://localhost:8082/ui/**. The dashboard lands on a "Get started" checklist; walk the user through it. The Playground works with any nonsense string as the API key (the fake model just echoes).

**Real use (their own API key):**

```bash
npm install && npm run build
node dist/cli.js            # flags: --port --store --upstream --token --budget
```

**Verify before declaring success** — all three, every time:
1. `curl -s http://localhost:8082/healthz` returns `{"ok":true,...}`
2. `http://localhost:8082/ui/` loads in a browser
3. If they have a real Anthropic key: send one message through the Playground (or curl `/v1/messages` with `x-api-key`) and confirm a reply plus `x-dream-*` response headers.

Common local gotcha: port already in use → rerun with `--port 8083` (or `PORT=8083`).

## Flow 2 — Deploy to hosting

Read `references/deploy.md` and follow it. Summary of the three paths so you can offer the right one:
- **Fly.io** — primary path, persistent volume, CLI required. Has two sharp edges (billing prerequisite; must use `fly deploy --ha=false`, never `fly launch`) — the reference covers both.
- **Render** — one-click button, no terminal, best for non-techies; needs the repo public or their GitHub connected.
- **Docker** — for their own server.

Non-negotiable after ANY deploy: confirm `DREAM_ACCESS_TOKEN` is set (fetch `/stats` — if it answers without auth and shows `"accessTokenSet":false`, the memory of everyone who uses the gateway is publicly readable; fix before moving on).

## Flow 3 — Connect an existing app

Read `references/connect.md` and follow it. The short version: find where their code constructs the Anthropic client (`Grep` for `new Anthropic(` / `Anthropic(`), add `baseURL`, recommend an `x-dream-conversation-id` header per conversation, and verify with one real request checking for `x-dream-*` response headers. For non-Anthropic models, the reference covers the translating-upstream (LiteLLM) pattern.

## Flow 4 — Troubleshoot

| Symptom | Cause → fix |
|---|---|
| `requested machine count exceeds organization limit` (Fly) | They ran `fly launch` (proposes 2 machines) and/or the org has no payment method. Fix: add a card at fly.io/dashboard → Billing, then `fly deploy --ha=false`. Never `fly launch`. |
| Dashboard shows a "no access token" warning, or `/stats` answers without auth | `DREAM_ACCESS_TOKEN` unset. `fly secrets set DREAM_ACCESS_TOKEN=<strong-token>` (Fly restarts it; memory survives). Locally: `--token` flag. |
| "It forgot everything" / dashboard shows `<id>-fork-1` namespaces | The client edited earlier messages, so Dream forked rather than corrupt memory. Expected. Pin identity with an `x-dream-conversation-id` header. |
| "Nothing is being compressed" (0 blocks) | Conversation hasn't outgrown the window budget yet (default 30k tokens). Working as designed; to see it sooner, restart with `--budget 2000`. |
| Someone scaled Fly to 2+ machines | Memory is SQLite on one local volume — multiple machines = split brain. `fly scale count 1` immediately. |
| Slow/blocked model replies through the proxy | Check upstream directly; Dream adds only file reads + string assembly. `GET /stats` shows recent request latencies. |
| Worried about search engines / AI crawlers | Already blocked three ways (robots.txt, `x-robots-tag` header, meta tag). Verify: `curl -s <url>/robots.txt` starts with `User-agent: *` / `Disallow: /`. |

## Things you must never do

- Never run `fly launch` for this repo, and never deploy without `--ha=false`.
- Never scale beyond one machine/instance.
- Never ask the user to paste a model API key into chat with you; keys go into the Playground (browser-only) or their own app's environment.
- Never leave a hosted deploy without confirming the access token is set and rejecting unauthenticated `/stats`.
