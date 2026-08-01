import { api, el, getToken } from '../api.js';

// "Use with Claude": step-by-step activation guide for the MCP connector,
// with this instance's real URL (and token, if the user has unlocked the
// dashboard with one) filled into every snippet.

function copyRow(text) {
  const btn = el('button', { class: 'secondary', style: 'font-size:11px;padding:3px 10px', onclick: () => { navigator.clipboard?.writeText(text); btn.textContent = 'copied ✓'; setTimeout(() => (btn.textContent = 'copy'), 1200); } }, 'copy');
  return el('div', { class: 'row', style: 'gap:8px;align-items:center;margin:6px 0' },
    el('pre', { class: 'mono', style: 'flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:9px 12px;margin:0;overflow-x:auto;white-space:nowrap' }, text),
    btn,
  );
}

export async function claudeView(view) {
  let tokenSet = false;
  try {
    const s = await api('/stats');
    tokenSet = s.config.accessTokenSet;
  } catch { tokenSet = true; } // 401 → token is set but we're not unlocked

  const token = getToken();
  const mcpUrl = tokenSet && token ? `${location.origin}/mcp/${token}` : `${location.origin}/mcp`;
  const urlHidden = tokenSet && !token;

  view.replaceChildren(
    el('h2', {}, 'Use with Claude'),
    el('p', { class: 'sub' }, 'Turn this Dream instance into a Claude connector — Claude on the web, desktop, and mobile can then search this memory, expand history, and run consolidations from any chat.'),

    el('div', { class: 'panel' },
      el('h3', {}, 'Your connector URL'),
      urlHidden
        ? el('p', {}, '🔒 Unlock the dashboard first (enter the access token) — the connector URL embeds it, and it is only shown to someone who already has the token.')
        : copyRow(mcpUrl),
      !tokenSet
        ? el('p', { class: 'muted', style: 'font-size:12.5px' }, '⚠️ No access token is set on this server, so the connector is open. Fine locally; before sharing a public URL, set DREAM_ACCESS_TOKEN and come back — the URL will include the token automatically.')
        : el('p', { class: 'muted', style: 'font-size:12.5px' }, 'The token is part of the URL — treat the whole URL like a password.'),
    ),

    el('div', { class: 'panel' },
      el('h3', {}, 'Activate in Claude (web, desktop, mobile)'),
      el('ol', { style: 'margin:0;padding-left:22px;line-height:1.9' },
        el('li', {}, 'Open ', el('strong', {}, 'claude.ai'), ' (or the Claude desktop app) → ', el('strong', {}, 'Settings → Connectors'), '.'),
        el('li', {}, 'Click ', el('strong', {}, 'Add custom connector'), '.'),
        el('li', {}, 'Name it ', el('span', { class: 'mono' }, 'Dream'), ' and paste the connector URL above. No OAuth setup is needed.'),
        el('li', {}, 'Save. In any chat, open the tools menu (🔧) and make sure ', el('strong', {}, 'Dream'), ' is enabled.'),
        el('li', {}, 'Try it: ask Claude ', el('em', {}, '“What does Dream remember about …?”'), ' or ', el('em', {}, '“Search my Dream memory for the deploy decision.”')),
      ),
    ),

    el('div', { class: 'panel' },
      el('h3', {}, 'Activate in Claude Code'),
      urlHidden ? el('p', { class: 'muted' }, 'Unlock the dashboard to reveal the command.') : copyRow(`claude mcp add --transport http dream ${mcpUrl}`),
      el('p', { class: 'muted', style: 'font-size:12.5px' }, 'Works in the terminal, VS Code, and JetBrains. Claude Code then has the same memory tools in every session.'),
    ),

    el('div', { class: 'panel' },
      el('h3', {}, 'What Claude can do once connected'),
      el('table', {},
        el('tr', {}, el('th', {}, 'Tool'), el('th', {}, 'What it does')),
        [
          ['dream_recall', 'Search the knowledge graph + compressed history across all conversations'],
          ['dream_unpack', 'Expand any compressed block back to its verbatim original'],
          ['dream_conversations', 'List what conversations are in memory'],
          ['dream_stats', 'Health, compression, and savings numbers'],
          ['dream_consolidate', 'Run a dream (knowledge extraction) on demand'],
          ['dream_guide', 'A built-in guide Claude can read to explain the setup to you'],
        ].map(([name, what]) => el('tr', {}, el('td', { class: 'mono' }, name), el('td', {}, what))),
      ),
      el('p', { class: 'muted', style: 'font-size:12.5px;margin:8px 0 0' }, 'Claude picks these up automatically when relevant — you can just ask about past work in plain language. Note: the connector reads memory; conversations get INTO memory via apps that use the gateway as their base URL (see Get started).'),
    ),
  );
}
