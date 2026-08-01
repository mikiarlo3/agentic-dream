#!/usr/bin/env node
// npx agentic-dream — one command to a running memory gateway.
//
//   npx agentic-dream                     # start on :8082, store in ./dream-store
//   npx agentic-dream --port 9000 --store ~/dream --upstream https://api.anthropic.com
//   npx agentic-dream --token s3cret      # protect the dashboard
import { serve } from '@hono/node-server';
import { createServer } from './server.js';
import { loadConfig } from './config.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`agentic-dream — a memory gateway for LLM agents

Usage: agentic-dream [options]

Options:
  --port <n>        port to listen on            (default 8082, env PORT)
  --store <dir>     where memory lives on disk   (default ./dream-store, env DREAM_STORE_DIR)
  --upstream <url>  model API to forward to      (default https://api.anthropic.com, env UPSTREAM_BASE_URL)
  --token <t>       protect dashboard + admin    (env DREAM_ACCESS_TOKEN)
  --budget <n>      window budget in est. tokens (default 30000, env DREAM_WINDOW_BUDGET)

Then change ONE line in your app — point your SDK at the gateway:
  new Anthropic({ baseURL: "http://localhost:8082" })

Any provider that speaks the Anthropic Messages API works as --upstream,
including translation proxies (e.g. LiteLLM) that front OpenAI, Gemini,
Mistral, or local models.`);
  process.exit(0);
}

const env: NodeJS.ProcessEnv = { ...process.env };
if (flag('port')) env.PORT = flag('port');
if (flag('store')) env.DREAM_STORE_DIR = flag('store');
if (flag('upstream')) env.UPSTREAM_BASE_URL = flag('upstream');
if (flag('token')) env.DREAM_ACCESS_TOKEN = flag('token');
if (flag('budget')) env.DREAM_WINDOW_BUDGET = flag('budget');

const cfg = loadConfig(env);
const { app, scheduler } = createServer(env);
scheduler.start();

serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`
  🌙 Dream is awake.

  gateway    http://localhost:${info.port}/v1/messages
  dashboard  http://localhost:${info.port}/ui/
  store      ${cfg.storeDir}
  upstream   ${cfg.upstreamBaseUrl}
  auth       ${cfg.accessToken ? 'dashboard token required' : 'open (set --token for hosted use)'}

  Connect your app (one line):

    JS      new Anthropic({ baseURL: "http://localhost:${info.port}" })
    Python  Anthropic(base_url="http://localhost:${info.port}")

  Your API key passes straight through to the upstream — Dream never stores it.
`);
});
