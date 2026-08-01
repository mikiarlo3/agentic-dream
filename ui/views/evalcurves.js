import { api, el } from '../api.js';

// Retention-per-tier line chart, hand-rolled SVG. Series = eval runs (≤3
// shown, per the all-pairs series cap); x = tier, y = retention %.
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];

function chart(curves) {
  const W = 640, H = 300, PAD = { l: 46, r: 16, t: 14, b: 34 };
  const maxTier = Math.max(...curves.flatMap((c) => c.curve.tiers.map((t) => t.tier)));
  const x = (tier) => PAD.l + (tier / Math.max(1, maxTier)) * (W - PAD.l - PAD.r);
  const y = (r) => PAD.t + (1 - r) * (H - PAD.t - PAD.b);
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.style.maxWidth = `${W}px`;

  const mk = (tag, attrs, text) => {
    const n = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text) n.textContent = text;
    return n;
  };

  // Recessive grid + axes.
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(mk('line', { x1: PAD.l, x2: W - PAD.r, y1: y(r), y2: y(r), stroke: 'var(--border)', 'stroke-width': 1 }));
    svg.append(mk('text', { x: PAD.l - 8, y: y(r) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--text-muted)' }, `${r * 100}%`));
  }
  for (let t = 0; t <= maxTier; t++) {
    svg.append(mk('text', { x: x(t), y: H - 12, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--text-muted)' }, `t${t}`));
  }
  svg.append(mk('text', { x: (W + PAD.l - PAD.r) / 2, y: H - 0.5, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--text-secondary)' }, 'compression tier'));

  curves.slice(0, 3).forEach((c, si) => {
    const pts = c.curve.tiers.map((t) => [x(t.tier), y(t.retention)]);
    svg.append(mk('path', { d: 'M' + pts.map((p) => p.join(',')).join(' L'), fill: 'none', stroke: SERIES[si], 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    c.curve.tiers.forEach((t, i) => {
      const dot = mk('circle', { cx: pts[i][0], cy: pts[i][1], r: 4, fill: SERIES[si], stroke: 'var(--surface-1)', 'stroke-width': 2 });
      dot.append(mk('title', {}, `${c.date} · tier ${t.tier}: ${(t.retention * 100).toFixed(0)}% retained at ${t.tokens} tokens (${t.ratio}x)${t.lost.length ? ` · lost ${t.lost.length}` : ''}`));
      svg.append(dot);
    });
    if (c.curve.cliff !== null) {
      const cx = x(c.curve.cliff);
      svg.append(mk('line', { x1: cx, x2: cx, y1: PAD.t, y2: H - PAD.b, stroke: SERIES[si], 'stroke-width': 1, 'stroke-dasharray': '4 4', opacity: 0.6 }));
    }
  });
  return svg;
}

export async function evalView(view) {
  const curves = await api('/api/eval/curves');
  const recent = curves.slice(-3).reverse();

  view.replaceChildren(
    el('h2', {}, 'Eval curves'),
    el('p', { class: 'sub' }, 'Retention per compression tier — the regression test for the whole system. Dashed line marks the cliff (retention < 50%).'),
    curves.length === 0
      ? el('p', { class: 'empty' }, 'No curves recorded. Run `npm run eval` (or the CI job) to measure one.')
      : el('div', {},
          el('div', { class: 'panel chart-wrap' },
            chart(recent),
            recent.length >= 2
              ? el('div', { class: 'legend' }, recent.map((c, i) =>
                  el('span', {}, el('span', { class: 'swatch', style: `background:${SERIES[i]}` }), `${c.date} (${c.curve.backend})`)))
              : el('div', { class: 'legend' }, el('span', { class: 'muted' }, `${recent[0].date} · ${recent[0].curve.backend} backend · ${recent[0].curve.sessionTokens.toLocaleString()} tokens`)),
          ),
          recent.map((c) =>
            el('div', { class: 'panel' },
              el('h3', {}, `${c.date} — ${c.curve.backend} backend`),
              el('table', {},
                el('tr', {}, el('th', {}, 'Tier'), el('th', {}, 'Tokens'), el('th', {}, 'Ratio'), el('th', {}, 'Retention'), el('th', {}, 'Facts lost')),
                c.curve.tiers.map((t) =>
                  el('tr', {},
                    el('td', {}, `t${t.tier}`),
                    el('td', {}, t.tokens.toLocaleString()),
                    el('td', {}, `${t.ratio}×`),
                    el('td', {}, el('span', { class: `pill ${t.retention >= 0.9 ? 'good' : t.retention >= 0.5 ? 'warn' : 'bad'}` }, `${(t.retention * 100).toFixed(0)}%`)),
                    el('td', {}, t.lost.length === 0 ? '—' : el('details', {}, el('summary', {}, `${t.lost.length} lost`), el('div', { class: 'muted', style: 'font-size:12px' }, t.lost.map((q) => el('div', {}, q))))),
                  ),
                ),
              ),
            ),
          ),
        ),
  );
}
