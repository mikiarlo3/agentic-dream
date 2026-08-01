import { api, el } from '../api.js';

export async function recallView(view) {
  const conversations = await api('/api/conversations');
  const nsSelect = el('select', {}, conversations.map((c) => el('option', { value: c.ns }, c.ns)));
  const query = el('input', { type: 'text', placeholder: 'what was the deploy region?' });
  const results = el('div', {});

  async function run() {
    if (!query.value.trim()) return;
    results.replaceChildren(el('p', { class: 'muted' }, 'Searching…'));
    const r = await api('/api/recall', { method: 'POST', body: JSON.stringify({ ns: nsSelect.value, query: query.value, k: 10 }) });
    results.replaceChildren(
      el('div', { class: 'panel' },
        el('h3', {}, `Graph nodes (ranked by relevance × confidence × recency)`),
        r.nodes.length === 0
          ? el('p', { class: 'empty' }, 'No matching nodes.')
          : r.nodes.map((n) =>
              el('div', { class: 'node-detail' },
                el('div', {}, el('strong', {}, n.label), ' ', el('span', { class: `pill ${n.status === 'active' ? 'good' : 'warn'}` }, n.status)),
                el('div', { class: 'muted', style: 'font-size:12px' }, `score ${n.score.toFixed(3)} · confidence ${n.confidence.toFixed(2)} · `, el('span', { class: 'mono' }, n.id)),
              ),
            ),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, 'Matching compressed blocks'),
        r.blocks.length === 0
          ? el('p', { class: 'empty' }, 'No matching blocks.')
          : r.blocks.map((b) =>
              el('div', { class: 'node-detail' },
                el('a', { href: `#/block/${encodeURIComponent(b.id)}`, class: 'mono' }, b.id),
                el('pre', { class: 'mono', style: 'white-space:pre-wrap;font-size:12px;margin:4px 0 0;max-height:120px;overflow:hidden' }, b.pressed.slice(0, 400)),
              ),
            ),
      ),
    );
  }

  query.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  view.replaceChildren(
    el('h2', {}, 'Recall playground'),
    el('p', { class: 'sub' }, 'The same query the model runs via the dream_recall tool.'),
    conversations.length === 0
      ? el('p', { class: 'empty' }, 'No conversations yet.')
      : el('div', {}, el('div', { class: 'row' }, nsSelect, query, el('button', { onclick: run }, 'Recall')), results),
  );
}
