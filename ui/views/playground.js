import { el } from '../api.js';

// Chat playground: talks to /v1/messages through the gateway like any client
// would. The model API key lives in localStorage only and is sent straight to
// the gateway per request (which forwards it upstream, never storing it).

export async function playgroundView(view) {
  const apiKey = el('input', { type: 'password', placeholder: 'model API key (x-api-key) — stored in this browser only', value: localStorage.getItem('dream_pg_key') || '' });
  const model = el('input', { type: 'text', value: localStorage.getItem('dream_pg_model') || 'claude-haiku-4-5-20251001', style: 'max-width:260px' });
  const convId = el('input', { type: 'text', value: localStorage.getItem('dream_pg_conv') || `playground-${Math.random().toString(36).slice(2, 8)}`, style: 'max-width:220px' });
  const log = el('div', { class: 'chat-log' });
  const savings = el('div', { class: 'savings-bar' }, 'Memory stats appear here after the first reply.');
  const input = el('textarea', { rows: 3, placeholder: 'Say something… (Enter to send, Shift+Enter for newline)' });
  const sendBtn = el('button', {}, 'Send');
  const history = [];

  function persist() {
    localStorage.setItem('dream_pg_key', apiKey.value);
    localStorage.setItem('dream_pg_model', model.value);
    localStorage.setItem('dream_pg_conv', convId.value);
  }

  async function send() {
    const text = input.value.trim();
    if (!text || !apiKey.value.trim()) {
      if (!apiKey.value.trim()) apiKey.style.borderColor = 'var(--bad)';
      return;
    }
    persist();
    apiKey.style.borderColor = '';
    input.value = '';
    sendBtn.disabled = true;
    history.push({ role: 'user', content: text });
    log.append(el('div', { class: 'bubble user' }, text));
    const bubble = el('div', { class: 'bubble assistant' }, '…');
    log.append(bubble);
    bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });

    try {
      const res = await fetch('/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.value.trim(),
          'anthropic-version': '2023-06-01',
          'x-dream-conversation-id': convId.value.trim(),
        },
        body: JSON.stringify({ model: model.value.trim(), max_tokens: 1024, stream: true, messages: history }),
      });

      const h = (n) => res.headers.get(`x-dream-${n}`);
      if (h('raw-tokens')) {
        savings.textContent = `raw history ${Number(h('raw-tokens')).toLocaleString()} tokens → sent ${Number(h('sent-tokens')).toLocaleString()} (saved ${h('savings-pct')}%) · ${h('blocks')} memory blocks · prefix ${h('cache')}`;
      }

      if (!res.ok || !res.body) {
        const err = await res.text();
        bubble.textContent = `Error ${res.status}: ${err.slice(0, 400)}`;
        history.pop();
        return;
      }

      let acc = '';
      let buf = '';
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          try {
            const ev = JSON.parse(dataLine.slice(5));
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              acc += ev.delta.text;
              bubble.textContent = acc;
            }
            if (ev.type === 'error') bubble.textContent = `Error: ${ev.error?.message || 'stream error'}`;
          } catch { /* ignore partial */ }
        }
      }
      history.push({ role: 'assistant', content: [{ type: 'text', text: acc }] });
      bubble.append(el('div', { class: 'meta' }, `${model.value} · via dream gateway`));
    } catch (err) {
      bubble.textContent = `Request failed: ${err.message}`;
      history.pop();
    } finally {
      sendBtn.disabled = false;
      bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  view.replaceChildren(
    el('h2', {}, 'Playground'),
    el('p', { class: 'sub' }, 'Chat through the proxy exactly like an SDK would. Watch the memory stats shrink your context as the conversation grows.'),
    el('div', { class: 'chat' },
      el('div', { class: 'row' }, apiKey),
      el('div', { class: 'row' }, el('span', { class: 'muted' }, 'model'), model, el('span', { class: 'muted' }, 'conversation'), convId),
      savings,
      log,
      el('div', { class: 'row' }, input, sendBtn),
    ),
  );
}
