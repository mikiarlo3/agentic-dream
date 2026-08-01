import { api, el, fmtAgo } from '../api.js';

const KIND_ORDER = ['fact', 'entity', 'decision', 'procedure', 'episode'];

export async function graphView(view) {
  const conversations = await api('/api/conversations');
  const nsSelect = el('select', {},
    el('option', { value: '' }, 'all namespaces'),
    conversations.map((c) => el('option', { value: c.ns }, c.ns)),
  );
  const kindSelect = el('select', {},
    el('option', { value: '' }, 'all kinds'),
    KIND_ORDER.map((k) => el('option', { value: k }, k)),
  );
  const showInactive = el('input', { type: 'checkbox', id: 'show-inactive' });
  const container = el('div', {});

  async function load() {
    const ns = nsSelect.value;
    const g = await api(`/api/graph${ns ? `?ns=${encodeURIComponent(ns)}` : ''}`);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const kind = kindSelect.value;
    let nodes = g.nodes;
    if (kind) nodes = nodes.filter((n) => n.kind === kind);
    if (!showInactive.checked) nodes = nodes.filter((n) => n.status === 'active');
    nodes.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.confidence - a.confidence);

    const edgesBySrc = new Map();
    for (const e of g.edges) edgesBySrc.set(e.src, [...(edgesBySrc.get(e.src) || []), e]);

    container.replaceChildren(
      el('div', { class: 'panel' },
        nodes.length === 0
          ? el('p', { class: 'empty' }, 'No graph nodes yet. Dream consolidation builds the graph after conversations go idle (or run it from a conversation page).')
          : el('table', {},
              el('tr', {}, el('th', {}, 'Node'), el('th', {}, 'Kind'), el('th', {}, 'Confidence'), el('th', {}, 'Status'), el('th', {}, 'Confirmed'), el('th', {}, 'Edges')),
              nodes.map((n) => {
                const out = (edgesBySrc.get(n.id) || []).map((e) => {
                  const dst = byId.get(e.dst);
                  return `${e.rel} → ${dst ? dst.label.slice(0, 60) : e.dst}`;
                });
                return el('tr', {},
                  el('td', {},
                    el('div', {}, n.label),
                    el('div', { class: 'mono muted', style: 'font-size:11px' }, n.id),
                  ),
                  el('td', {}, el('span', { class: 'pill' }, n.kind)),
                  el('td', {}, n.confidence.toFixed(2)),
                  el('td', {}, el('span', { class: `pill ${n.status === 'active' ? 'good' : n.status === 'superseded' ? 'warn' : ''}` }, n.status)),
                  el('td', {}, fmtAgo(n.last_confirmed)),
                  el('td', { class: 'mono', style: 'font-size:11px' }, out.length ? out.map((o) => el('div', {}, o)) : '—'),
                );
              }),
            ),
      ),
    );
  }

  nsSelect.addEventListener('change', load);
  kindSelect.addEventListener('change', load);
  showInactive.addEventListener('change', load);

  view.replaceChildren(
    el('h2', {}, 'Knowledge graph'),
    el('p', { class: 'sub' }, 'Structured memory: what was learned, independent of any transcript. Superseded nodes stay reachable with provenance.'),
    el('div', { class: 'row' }, nsSelect, kindSelect, el('label', { for: 'show-inactive', style: 'display:flex;gap:6px;align-items:center' }, showInactive, 'show superseded/merged')),
    container,
  );
  await load();
}
