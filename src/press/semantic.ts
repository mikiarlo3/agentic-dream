import { countTokens } from './tokens.js';

export interface SemanticOpts {
  baseUrl: string; // e.g. https://api.anthropic.com
  model: string;
  headers: Record<string, string>; // auth headers (x-api-key or authorization)
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

const PRESS_PROMPT = `Rewrite the following transcript excerpt as telegraphic notes.
Rules:
- Preserve EVERY fact, name, number, decision, preference, and outcome.
- Collapse repeated log lines to one example plus a count.
- Drop pleasantries, filler, and formatting noise.
- One note per line. No commentary, no preamble, notes only.`;

/**
 * Semantic press: a cheap model rewrites a block as telegraphic notes.
 * Throws on any upstream failure — callers fall back to mechanical/salience.
 */
export async function semanticPress(text: string, opts: SemanticOpts): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...opts.headers,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? Math.min(4096, Math.max(512, Math.ceil(countTokens(text) / 2))),
      messages: [{ role: 'user', content: `${PRESS_PROMPT}\n\n<excerpt>\n${text}\n</excerpt>` }],
    }),
  });
  if (!res.ok) throw new Error(`semantic press upstream ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const out = data.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (out.length === 0) throw new Error('semantic press returned empty text');
  return out;
}
