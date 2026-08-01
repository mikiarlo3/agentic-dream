// Extraction: mine an episode's text for candidate knowledge. Two paths —
// a cheap model (when a key is available) and a heuristic fallback that
// works keyless, so consolidation never silently stops.
import type { NodeKind } from '../types.js';
import { scoreLine } from '../press/salience.js';

export interface Candidate {
  kind: NodeKind;
  data: Record<string, unknown>;
  confidence?: number;
}

export interface ExtractResult {
  mode: 'semantic' | 'heuristic';
  candidates: Candidate[];
}

const FACT_PATTERNS: Array<{ re: RegExp; map: (m: RegExpMatchArray) => Candidate | null }> = [
  {
    // "X is/are/was/= Y" — subject up to 6 words, object to end of clause
    re: /\b((?:[A-Za-z0-9_`./-]+\s){0,5}[A-Za-z0-9_`./-]+)\s+(is|are|was|equals|=)\s+([^.;,\n]{2,80})/g,
    map: (m) => {
      const subject = m[1]!.trim();
      const object = m[3]!.trim();
      if (subject.length < 3 || /^(it|this|that|there|which|what|who)$/i.test(subject)) return null;
      return { kind: 'fact', data: { subject, predicate: 'is', object } };
    },
  },
  {
    re: /\b(?:decided|chose|agreed|will go with|picked)\s+(?:to\s+)?([^.;,\n]{3,80})(?:\s+because\s+([^.;\n]{3,120}))?/gi,
    map: (m) => ({ kind: 'decision', data: { choice: m[1]!.trim(), rationale: m[2]?.trim() ?? '', status: 'active' } }),
  },
  {
    re: /\b(?:prefers?|preference for|always use[s]?)\s+([^.;,\n]{3,80})/gi,
    map: (m) => ({ kind: 'fact', data: { subject: 'user preference', predicate: 'is', object: m[1]!.trim() }, confidence: 0.6 }),
  },
];

/** Keyless extraction over salience-ranked lines. */
export function heuristicExtract(text: string): Candidate[] {
  const lines = text.split('\n').filter((l) => scoreLine(l) >= 3);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    for (const { re, map } of FACT_PATTERNS) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const c = map(m);
        if (!c) continue;
        const key = JSON.stringify(c.data).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
        if (out.length >= 40) return out;
      }
    }
  }
  return out;
}

const EXTRACT_PROMPT = `Read this transcript excerpt and extract durable knowledge as JSON.
Return ONLY a JSON array. Each element is one of:
  {"kind":"fact","data":{"subject":"...","predicate":"...","object":"..."}}
  {"kind":"entity","data":{"name":"...","type":"person|project|tool","one_liner":"..."}}
  {"kind":"decision","data":{"choice":"...","rationale":"...","status":"active"}}
  {"kind":"procedure","data":{"trigger":"...","steps":["..."]}}
Extract facts, names, numbers, decisions, preferences, and outcomes. Skip trivia and pleasantries. Max 30 items.`;

export interface SemanticExtractOpts {
  baseUrl: string;
  model: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export async function semanticExtract(text: string, opts: SemanticExtractOpts): Promise<Candidate[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...opts.headers },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: `${EXTRACT_PROMPT}\n\n<transcript>\n${text.slice(0, 60_000)}\n</transcript>` }],
    }),
  });
  if (!res.ok) throw new Error(`extract upstream ${res.status}`);
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const textOut = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const jsonMatch = textOut.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('no JSON array in extraction output');
  const arr = JSON.parse(jsonMatch[0]) as Candidate[];
  return arr.filter((c) => c && typeof c === 'object' && ['fact', 'entity', 'decision', 'procedure'].includes(c.kind) && c.data);
}
