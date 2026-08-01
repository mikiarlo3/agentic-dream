import { api, el, fmtAgo } from '../api.js';

export async function conversationsView(view) {
  const list = await api('/api/conversations');
  view.replaceChildren(
    el('h2', {}, 'Conversations'),
    el('p', { class: 'sub' }, 'Every conversation the gateway has proxied, with its memory state.'),
    list.length === 0
      ? el('p', { class: 'empty' }, 'Nothing proxied yet. Point a client at /v1/messages or use the Playground.')
      : el('div', { class: 'panel' },
          el('table', {},
            el('tr', {}, el('th', {}, 'Namespace'), el('th', {}, 'Turns'), el('th', {}, 'Pressed up to'), el('th', {}, 'Blocks'), el('th', {}, 'Tiers'), el('th', {}, 'Last seen')),
            list.map((c) =>
              el('tr', { class: 'clickable', onclick: () => (location.hash = `#/conversation/${encodeURIComponent(c.ns)}`) },
                el('td', { class: 'mono' }, c.ns),
                el('td', {}, c.turns),
                el('td', {}, `turn ${c.pressedUpTo ?? 0}`),
                el('td', {}, c.blocks),
                el('td', {}, Object.entries(c.tiers || {}).map(([t, n]) => `${t}×${n}`).join(' ') || '—'),
                el('td', {}, fmtAgo(c.lastSeen)),
              ),
            ),
          ),
        ),
  );
}

export async function conversationDetailView(view, ns) {
  const d = await api(`/api/conversations/${encodeURIComponent(ns)}`);
  const dreamBtn = el('button', {
    onclick: async () => {
      dreamBtn.disabled = true;
      dreamBtn.textContent = 'Dreaming…';
      try {
        const r = await api('/api/dream/run', { method: 'POST', body: JSON.stringify({ ns }) });
        dreamBtn.textContent = `Done (${r.mode}: ${r.extracted} extracted)`;
      } catch (e) {
        dreamBtn.textContent = `Failed: ${e.message}`;
      }
    },
  }, 'Run dream consolidation now');

  view.replaceChildren(
    el('h2', { class: 'mono' }, ns),
    el('p', { class: 'sub' }, `${d.meta.turnCount} turns · pressed up to turn ${d.meta.pressedUpTo} · consolidated up to turn ${d.meta.consolidatedUpTo}`),
    el('div', { class: 'row' }, dreamBtn),
    el('div', { class: 'panel' },
      el('h3', {}, `Pressed blocks (${d.blocks.length})`),
      d.blocks.length === 0
        ? el('p', { class: 'empty' }, 'No pressing yet — the raw tail still fits the window budget.')
        : el('table', {},
            el('tr', {}, el('th', {}, 'Block'), el('th', {}, 'Tier'), el('th', {}, 'Backend'), el('th', {}, 'Turns'), el('th', {}, 'Tokens'), el('th', {}, 'Ratio')),
            d.blocks.map((b) =>
              el('tr', { class: 'clickable', onclick: () => (location.hash = `#/block/${encodeURIComponent(b.id)}`) },
                el('td', { class: 'mono' }, b.id),
                el('td', {}, el('span', { class: 'pill' }, `t${b.tier}`)),
                el('td', {}, b.backend),
                el('td', {}, b.fromTurn != null ? `${b.fromTurn}–${b.toTurn}` : '—'),
                el('td', {}, `${b.originalTokens} → ${b.pressedTokens}`),
                el('td', {}, `${b.originalTokens > 0 ? Math.round((1 - b.pressedTokens / b.originalTokens) * 100) : 0}%`),
              ),
            ),
          ),
    ),
    el('div', { class: 'panel' },
      el('h3', {}, 'Memory index (loads at session start)'),
      d.index ? el('pre', { class: 'mono', style: 'white-space:pre-wrap;margin:0' }, d.index) : el('p', { class: 'empty' }, 'No graph nodes indexed yet. Run a dream consolidation.'),
    ),
    el('div', { class: 'panel' },
      el('h3', {}, 'Recent transcript (rendered)'),
      el('pre', { class: 'mono', style: 'white-space:pre-wrap;margin:0;max-height:400px;overflow-y:auto' }, d.transcriptPreview || '(empty)'),
    ),
  );
}
