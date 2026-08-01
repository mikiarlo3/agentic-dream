import { api, el } from '../api.js';

export async function requestsView(view) {
  const table = el('div', {});
  let timer = null;

  async function load() {
    const reqs = await api('/api/requests');
    table.replaceChildren(
      el('div', { class: 'panel' },
        reqs.length === 0
          ? el('p', { class: 'empty' }, 'No proxied requests yet.')
          : el('table', {},
              el('tr', {},
                el('th', {}, 'Time'), el('th', {}, 'Conversation'), el('th', {}, 'Model'), el('th', {}, 'Status'),
                el('th', {}, 'Latency'), el('th', {}, 'Raw → sent'), el('th', {}, 'Saved'), el('th', {}, 'Blocks'), el('th', {}, 'Hops')),
              reqs.map((r) =>
                el('tr', {},
                  el('td', {}, new Date(r.ts).toLocaleTimeString()),
                  el('td', {}, el('a', { href: `#/conversation/${encodeURIComponent(r.convId)}`, class: 'mono' }, r.convId), r.stream ? el('span', { class: 'pill', style: 'margin-left:6px' }, 'stream') : ''),
                  el('td', { class: 'mono' }, r.model),
                  el('td', {}, el('span', { class: `pill ${r.status === 200 ? 'good' : 'bad'}` }, r.status)),
                  el('td', {}, `${r.latencyMs} ms`),
                  el('td', {}, r.dream ? `${r.dream.rawTokens.toLocaleString()} → ${r.dream.sentTokens.toLocaleString()}` : '—'),
                  el('td', {}, r.dream ? el('span', { class: `pill ${r.dream.savingsPct > 30 ? 'good' : ''}` }, `${r.dream.savingsPct}%`) : '—'),
                  el('td', {}, r.dream?.blocks ?? '—'),
                  el('td', {}, r.dreamToolHops || '—'),
                ),
              ),
            ),
      ),
    );
  }

  view.replaceChildren(
    el('h2', {}, 'Request log'),
    el('p', { class: 'sub' }, 'Live view of proxied traffic (last 200 requests, refreshes every 2s).'),
    table,
  );
  await load();
  timer = setInterval(() => load().catch(() => {}), 2000);
  return () => clearInterval(timer);
}
