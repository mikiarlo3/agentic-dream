import { api, el } from '../api.js';

// Simple line-based LCS diff, capped for very large blocks.
function lineDiff(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  if (A.length * B.length > 400_000) return null; // too big to diff cheaply
  const dp = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const left = [];
  const right = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { left.push(['kept', A[i]]); right.push(['kept', B[j]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { left.push(['dropped', A[i]]); i++; }
    else { right.push(['added', B[j]]); j++; }
  }
  while (i < A.length) left.push(['dropped', A[i++]]);
  while (j < B.length) right.push(['added', B[j++]]);
  return { left, right };
}

function pane(title, entries, plain) {
  const pre = el('pre', {});
  if (entries) for (const [cls, line] of entries) pre.append(el('span', { class: cls }, line + '\n'));
  else pre.textContent = plain;
  return el('div', {}, el('h3', {}, title), pre);
}

export async function blockView(view, id) {
  const b = await api(`/api/blocks/${encodeURIComponent(id)}`);
  const ratio = b.originalTokens > 0 ? Math.round((1 - b.pressedTokens / b.originalTokens) * 100) : 0;
  const diff = lineDiff(b.original, b.pressed);

  view.replaceChildren(
    el('h2', { class: 'mono' }, b.id),
    el('p', { class: 'sub' },
      `tier ${b.tier} · ${b.backend} press · ${b.originalTokens} → ${b.pressedTokens} tokens (${ratio}% smaller) · namespace `,
      el('a', { href: `#/conversation/${encodeURIComponent(b.ns)}`, class: 'mono' }, b.ns)),
    el('div', { class: 'panel' },
      el('div', { class: 'diff' },
        pane(`Original (tier ${b.tier - 1} text)`, diff?.left, b.original),
        pane('Pressed', diff?.right, b.pressed),
      ),
      diff ? el('p', { class: 'muted', style: 'font-size:12px;margin:8px 0 0' }, 'Red lines were dropped or collapsed by the press; green lines were rewritten or added.') : el('p', { class: 'muted' }, 'Block too large for inline diff — showing raw text.'),
    ),
  );
}
