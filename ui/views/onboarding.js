import { AuthError, api, el, getToken, setToken } from '../api.js';

// Guided onboarding: a live checklist computed from the server's real state.
// Works before authentication too — the "unlock" step embeds the token form.

function copyBtn(text) {
  const b = el('button', { class: 'secondary', style: 'font-size:11px;padding:2px 10px', onclick: () => { navigator.clipboard?.writeText(text); b.textContent = 'copied ✓'; setTimeout(() => (b.textContent = 'copy'), 1200); } }, 'copy');
  return b;
}

function code(text) {
  return el('div', { class: 'row', style: 'gap:8px;align-items:flex-start;margin:8px 0' },
    el('pre', { class: 'mono', style: 'flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:9px 12px;margin:0;overflow-x:auto;white-space:pre-wrap' }, text),
    copyBtn(text),
  );
}

function step(n, title, status, body) {
  // status: 'done' | 'current' | 'todo' | 'optional'
  const icon = status === 'done' ? '✅' : status === 'current' ? '👉' : status === 'optional' ? '✨' : '⬜';
  return el('div', { class: 'panel', style: status === 'current' ? 'border-color:var(--series-1)' : status === 'done' ? 'opacity:0.85' : '' },
    el('h3', { style: 'display:flex;gap:8px;align-items:center' }, `${icon} Step ${n} — ${title}`,
      status === 'done' ? el('span', { class: 'pill good' }, 'done') : status === 'current' ? el('span', { class: 'pill', style: 'background:color-mix(in srgb, var(--series-1) 15%, transparent);color:var(--series-1)' }, 'you are here') : ''),
    ...body,
  );
}

export async function onboardingView(view) {
  const origin = location.origin;
  let stats = null;
  let locked = false;
  try {
    stats = await api('/stats');
  } catch (err) {
    if (err instanceof AuthError) locked = true;
    else throw err;
  }

  const hasTraffic = stats && (stats.store.namespaces > 0 || stats.requests.total > 0);
  const hasBlocks = stats && stats.store.blocks > 0;
  const hasGraph = stats && (stats.graph.nodes > 0 || stats.dreamRuns.length > 0);
  const tokenSet = stats ? stats.config.accessTokenSet : true; // if locked we know it's set

  // Determine the current step.
  const statuses = {
    unlock: locked ? 'current' : 'done',
    chat: locked ? 'todo' : hasTraffic ? 'done' : 'current',
    press: locked || !hasTraffic ? 'todo' : hasBlocks ? 'done' : 'current',
    dream: locked || !hasTraffic ? 'todo' : hasGraph ? 'done' : hasBlocks ? 'current' : 'todo',
    connect: 'optional',
  };

  // --- Step 1: unlock ---
  const tokenInput = el('input', { type: 'password', placeholder: 'paste the access token', value: getToken() });
  const unlockMsg = el('span', { class: 'muted' });
  const unlockBody = locked
    ? [
        el('p', {}, 'This dashboard is protected so strangers can’t read your conversations. The token was chosen when the server was set up.'),
        el('ul', { style: 'margin:0 0 8px;padding-left:20px' },
          el('li', {}, el('strong', {}, 'Deployed on Fly.io?'), ' It’s whatever you passed to ', el('span', { class: 'mono' }, 'fly secrets set DREAM_ACCESS_TOKEN=…')),
          el('li', {}, el('strong', {}, 'Deployed on Render?'), ' Find it in your service under Environment → DREAM_ACCESS_TOKEN.'),
          el('li', {}, el('strong', {}, 'Running locally?'), ' If you didn’t set a token, the dashboard is already open and this step won’t appear.'),
        ),
        el('div', { class: 'row' }, tokenInput, el('button', {
          onclick: async () => {
            setToken(tokenInput.value.trim());
            try {
              await api('/api/auth/check');
              location.reload();
            } catch {
              unlockMsg.textContent = 'That token was rejected — check for typos.';
              tokenInput.style.borderColor = 'var(--bad)';
            }
          },
        }, 'Unlock'), unlockMsg),
      ]
    : tokenSet
      ? [el('p', {}, 'Done — you’re signed in with the access token. Your dashboard and memory are protected.')]
      : [
          el('p', {}, el('strong', { style: 'color:var(--warn)' }, 'Heads up: no access token is set on this server. '), 'Anyone with the URL can read everything it remembers. If this instance is reachable from the internet, protect it now:'),
          code('fly secrets set DREAM_ACCESS_TOKEN=<choose-a-strong-password>'),
          el('p', { class: 'muted' }, 'The server restarts automatically with the token applied; memory is kept. Then reload this page and it will ask you to unlock.'),
        ];

  // --- Step 2: first chat ---
  const chatBody = [
    el('p', {}, 'Dream sits between an app and an AI model, like a smart middleman. The quickest way to see it work is the built-in chat:'),
    el('ol', { style: 'margin:0 0 8px;padding-left:20px' },
      el('li', {}, 'Open the ', el('a', { href: '#/playground' }, 'Playground'), ' (left menu).'),
      el('li', {}, 'Paste your model API key (e.g. an Anthropic key from ', el('span', { class: 'mono' }, 'console.anthropic.com'), '). It stays in your browser and passes straight through to the model — Dream never stores it.'),
      el('li', {}, 'Chat! Each reply shows a small stats bar: how big the full history is, how few tokens Dream actually sent, and how much was saved.'),
    ),
    hasTraffic ? el('p', { class: 'muted' }, `✓ This server has already proxied ${stats.requests.total || 'some'} request(s) across ${stats.store.namespaces} conversation(s).`) : '',
  ];

  // --- Step 3: watch compression happen ---
  const pressBody = [
    el('p', {}, 'Dream keeps recent messages at full detail and squeezes older ones into compact "pressed blocks". Nothing is lost — every block can be expanded back to the original wording.'),
    el('p', {}, hasBlocks
      ? `✓ It’s already happening: ${stats.store.blocks} block(s) exist. See them under `
      : 'This kicks in once a conversation outgrows the window budget — keep chatting in the Playground (long messages help) and watch the stats bar flip from "0 memory blocks" to more. Then look under '),
    el('p', {}, el('a', { href: '#/conversations' }, 'Conversations'), ' → click one → click any block to see the original next to the pressed version, with what was dropped highlighted.'),
  ];

  // --- Step 4: dreaming ---
  const nsForDream = stats?.store.namespaces > 0 ? el('span', {}) : null;
  const dreamBtn = el('button', {
    onclick: async () => {
      dreamBtn.disabled = true;
      dreamBtn.textContent = 'Dreaming…';
      try {
        const convs = await api('/api/conversations');
        if (convs.length === 0) { dreamBtn.textContent = 'No conversations yet — chat first'; return; }
        const r = await api('/api/dream/run', { method: 'POST', body: JSON.stringify({ ns: convs[0].ns }) });
        dreamBtn.textContent = `Done — ${r.extracted} things learned (${r.mode} mode)`;
      } catch (e) {
        dreamBtn.textContent = `Failed: ${e.message}`;
      }
    },
  }, 'Run a dream now');
  const dreamBody = [
    el('p', {}, 'After a conversation goes quiet for a few minutes, Dream "sleeps on it": it re-reads what happened and files away durable knowledge — facts, decisions, people, procedures — into a knowledge graph. That’s what survives even when the raw text is compressed away.'),
    el('p', {}, 'It runs automatically, but you don’t have to wait:'),
    el('div', { class: 'row' }, dreamBtn),
    el('p', {}, 'Then explore the ', el('a', { href: '#/graph' }, 'Graph'), ' (what it knows), and try ', el('a', { href: '#/recall' }, 'Recall'), ' — type a question like "what did we decide about the database?" and see what comes back. The model can do the same mid-conversation via a built-in memory tool.'),
    hasGraph ? el('p', { class: 'muted' }, `✓ The graph already holds ${stats.graph.nodes} node(s).`) : '',
  ];

  // --- Step 5: connect a real app ---
  const connectBody = [
    el('p', {}, 'When you’re ready, point your own app or agent at this gateway instead of the provider — it’s a one-line change, everything else (SDK, request shape, streaming) stays identical:'),
    code(`new Anthropic({ baseURL: "${origin}" })   // JavaScript`),
    code(`Anthropic(base_url="${origin}")           # Python`),
    el('p', {}, 'Using OpenAI, Gemini, or a local model instead? Run a translating proxy such as LiteLLM and set it as Dream’s upstream — your app still talks to Dream, and Dream forwards to any model behind it.'),
    el('p', {}, el('strong', {}, 'Tip:'), ' send an ', el('span', { class: 'mono' }, 'x-dream-conversation-id'), ' header per conversation so memory identity is explicit. Without it, Dream anchors identity to the first message, which also works.'),
  ];

  view.replaceChildren(
    el('h2', {}, 'Get started'),
    el('p', { class: 'sub' }, 'Five short steps. The checklist updates itself as your Dream instance comes alive.'),
    el('div', { class: 'panel', style: 'background:var(--surface-1)' },
      el('h3', {}, 'What is this?'),
      el('p', { style: 'margin:0 0 6px' },
        'AI models have no memory — every request must re-send the whole conversation, which gets slow, expensive, and eventually stops fitting. ',
        el('strong', {}, 'Dream is a memory layer that sits between your app and the model.'),
        ' It remembers everything, sends the model only what matters, and learns durable facts while conversations are idle — like sleep.'),
      el('pre', { class: 'mono muted', style: 'margin:6px 0 0;background:transparent;border:0;padding:0;font-size:12px' },
        'your app  ──►  🌙 Dream (remembers, compresses, recalls)  ──►  AI model'),
    ),
    step(1, 'Unlock the dashboard', statuses.unlock, unlockBody),
    step(2, 'Have your first conversation', statuses.chat, chatBody),
    step(3, 'Watch memory compression', statuses.press, pressBody),
    step(4, 'Let it dream — and ask it questions', statuses.dream, dreamBody),
    step(5, 'Connect your own app', statuses.connect, connectBody),
    el('p', { class: 'muted', style: 'margin-top:4px' }, 'You can reopen this guide any time from "Get started" in the menu. The ', el('a', { href: '#/stats' }, 'Overview'), ' shows the live health of everything.'),
  );
}
