import { api, el, fmtBytes } from '../api.js';

export async function statsView(view) {
  const s = await api('/stats');
  const tierEntries = Object.entries(s.store.blocksByTier || {}).sort();

  view.replaceChildren(
    el('h2', {}, 'Overview'),
    el('p', { class: 'sub' }, `Proxying ${s.config.upstream} · window budget ${s.config.windowBudget.toLocaleString()} tokens`),
    s.store.namespaces === 0
      ? el('div', { class: 'panel', style: 'border-color:var(--series-1)' },
          el('h3', {}, '👋 Welcome to Dream'),
          el('p', { style: 'margin:0 0 8px' }, 'This gateway remembers conversations for any AI app, compresses old history, and feeds each model call only what it needs. Nothing has passed through yet. Two easy ways to try it:'),
          el('ol', { style: 'margin:0 0 4px;padding-left:22px' },
            el('li', {}, el('a', { href: '#/playground' }, 'Open the Playground'), ' — paste your model API key and just chat. Watch the memory stats appear as the conversation grows.'),
            el('li', {}, 'Connect an app: change one line so your SDK talks to this gateway instead of the provider (snippets below).'),
          ),
        )
      : '',
    el('div', { class: 'cards' },
      card(s.store.namespaces, 'conversations'),
      card(s.store.blocks, 'pressed blocks', tierEntries.map(([t, n]) => `${t}: ${n}`).join('  ') || 'none yet'),
      card(fmtBytes(s.store.diskBytes), 'archived text'),
      card(`${Math.round(s.store.cacheHitRate * 100)}%`, 'press cache hit rate', `${s.store.cacheHits} hits / ${s.store.cacheMisses} misses`),
      card(s.graph.nodes, 'graph nodes', Object.entries(s.graph.byKind || {}).map(([k, n]) => `${k}: ${n}`).join('  ') || 'none yet'),
      card(s.graph.edges, 'graph edges', `${s.graph.superseded} superseded kept`),
      card(`${s.requests.avgSavingsPct}%`, 'avg token savings', `${s.requests.total} recent requests`),
      card(s.keyring.conversations, 'keys in memory', 'never persisted'),
    ),
    el('div', { class: 'panel' },
      el('h3', {}, 'Connect your app — one line'),
      el('p', { class: 'muted', style: 'margin:0 0 10px;font-size:12.5px' },
        'Point any SDK that speaks the Anthropic Messages API at this gateway. Your API key passes through per request; Dream never stores it.'),
      snippet('JavaScript / TypeScript', `import Anthropic from "@anthropic-ai/sdk";\nconst client = new Anthropic({ baseURL: "${location.origin}" });`),
      snippet('Python', `from anthropic import Anthropic\nclient = Anthropic(base_url="${location.origin}")`),
      snippet('curl', `curl ${location.origin}/v1/messages \\\n  -H "x-api-key: $ANTHROPIC_API_KEY" \\\n  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \\\n  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":256,"messages":[{"role":"user","content":"hello"}]}'`),
      snippet('Any other LLM (OpenAI, Gemini, local, …)',
        `# Run a translating proxy (e.g. LiteLLM) as Dream's upstream:\n#   litellm --port 4000        (speaks Anthropic Messages API, fronts 100+ providers)\n#   agentic-dream --upstream http://localhost:4000\n# Your app still talks to Dream; Dream forwards to any model behind the translator.`),
      el('p', { class: 'muted', style: 'margin:8px 0 0;font-size:12.5px' },
        'Tip: send an x-dream-conversation-id header to pin memory identity explicitly (otherwise the first turn anchors it).'),
    ),
    el('div', { class: 'panel' },
      el('h3', {}, 'Configuration'),
      el('table', {},
        row('Upstream', s.config.upstream),
        row('Window budget', `${s.config.windowBudget.toLocaleString()} estimated tokens`),
        row('Semantic backend (server key)', s.config.semanticEnabled ? 'enabled via DREAM_MODEL_KEY' : 'disabled — falls back to per-conversation keys, then heuristic'),
        row('Access token', s.config.accessTokenSet ? 'required' : 'not set (open)'),
      ),
    ),
    el('div', { class: 'panel' },
      el('h3', {}, 'Recent dream runs'),
      s.dreamRuns.length === 0
        ? el('p', { class: 'empty' }, 'No consolidation runs yet. They fire automatically after a conversation goes idle.')
        : el('table', {},
            el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Namespace'), el('th', {}, 'Mode'), el('th', {}, 'Extracted'), el('th', {}, 'Actions')),
            s.dreamRuns.slice().reverse().map((r) =>
              el('tr', {},
                el('td', {}, new Date(r.ts).toLocaleTimeString()),
                el('td', { class: 'mono' }, r.ns),
                el('td', {}, el('span', { class: `pill ${r.mode === 'semantic' ? 'good' : ''}` }, r.mode)),
                el('td', {}, r.extracted),
                el('td', { class: 'mono' }, Object.entries(r.actions).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(' ')),
              ),
            ),
          ),
    ),
  );
}

function snippet(title, code) {
  const pre = el('pre', { class: 'mono', style: 'background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:6px 0' }, code);
  const btn = el('button', { class: 'secondary', style: 'font-size:11px;padding:2px 8px;margin-left:8px', onclick: () => { navigator.clipboard?.writeText(code); btn.textContent = 'copied'; setTimeout(() => (btn.textContent = 'copy'), 1200); } }, 'copy');
  return el('details', { open: title.startsWith('JavaScript') ? '' : undefined },
    el('summary', {}, title, btn),
    pre,
  );
}

function card(big, label, hint) {
  return el('div', { class: 'card' }, el('div', { class: 'big' }, big), el('div', { class: 'label' }, label), hint ? el('div', { class: 'hint' }, hint) : '');
}

function row(k, v) {
  return el('tr', {}, el('td', { class: 'muted' }, k), el('td', {}, v));
}
