import { AuthError, api, el, getToken, setToken } from './api.js';
import { statsView } from './views/stats.js';
import { conversationsView, conversationDetailView } from './views/conversations.js';
import { blockView } from './views/blocks.js';
import { graphView } from './views/graph.js';
import { recallView } from './views/recall.js';
import { evalView } from './views/evalcurves.js';
import { skillsView } from './views/skills.js';
import { requestsView } from './views/requests.js';
import { playgroundView } from './views/playground.js';
import { onboardingView } from './views/onboarding.js';

const routes = {
  '': onboardingView,
  welcome: onboardingView,
  stats: statsView,
  conversations: conversationsView,
  conversation: conversationDetailView, // #/conversation/<ns>
  block: blockView, // #/block/<id>
  graph: graphView,
  recall: recallView,
  eval: evalView,
  skills: skillsView,
  requests: requestsView,
  playground: playgroundView,
};

const view = document.getElementById('view');
let cleanup = null;

function loginForm(message) {
  const input = el('input', { type: 'password', placeholder: 'DREAM_ACCESS_TOKEN', value: getToken() });
  const form = el(
    'div',
    { class: 'panel', style: 'max-width:420px' },
    el('h3', {}, 'Access token required'),
    el('p', { class: 'sub' }, message || 'This Dream instance is protected. Enter the access token configured on the server.'),
    el('div', { class: 'row' }, input, el('button', {
      onclick: async () => {
        setToken(input.value.trim());
        try {
          await api('/api/auth/check');
          render();
        } catch {
          input.style.borderColor = 'var(--bad)';
        }
      },
    }, 'Unlock')),
  );
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') form.querySelector('button').click(); });
  return form;
}

async function render() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, ...args] = hash.split('/');
  const fn = routes[name] || onboardingView;

  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === `#/${name || 'welcome'}` ||
      (name === 'conversation' && a.getAttribute('href') === '#/conversations') ||
      (name === 'block' && a.getAttribute('href') === '#/conversations'));
  });

  view.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  try {
    const result = await fn(view, ...args.map(decodeURIComponent));
    if (typeof result === 'function') cleanup = result;
  } catch (err) {
    if (err instanceof AuthError) view.replaceChildren(loginForm());
    else view.replaceChildren(el('div', { class: 'error-box' }, String(err.message || err)));
  }
  renderAuthStatus();
}

function renderAuthStatus() {
  const box = document.getElementById('auth-status');
  const token = getToken();
  box.replaceChildren(
    el('div', {}, token ? '🔓 token set' : 'no token'),
    token ? el('button', { class: 'secondary', onclick: () => { setToken(''); render(); } }, 'Clear token') : '',
  );
}

window.addEventListener('hashchange', render);
render();
