import type { Block, ConversationMeta, Turn, WindowStats } from '../types.js';
import type { Store } from '../store/store.js';
import type { DreamConfig } from '../config.js';
import { countTokensOf, countTokens } from '../press/tokens.js';
import { press } from '../press/press.js';
import { saliencePress } from '../press/salience.js';

/**
 * Render a run of turns as plain text for pressing. Tool blocks are
 * flattened; the goal is a transcript a press can compact.
 */
export function turnsToText(turns: Turn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    const tag = t.role === 'user' ? '[user]' : '[assistant]';
    if (typeof t.content === 'string') {
      lines.push(`${tag} ${t.content}`);
      continue;
    }
    for (const block of t.content as Array<Record<string, unknown>>) {
      switch (block.type) {
        case 'text':
          lines.push(`${tag} ${block.text}`);
          break;
        case 'tool_use':
          lines.push(`${tag} [tool_use ${block.name}] ${JSON.stringify(block.input ?? {})}`);
          break;
        case 'tool_result': {
          const c = block.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: Record<string, unknown>) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n') : '';
          lines.push(`[tool_result] ${text}`);
          break;
        }
        case 'thinking':
          break; // never archive thinking into pressed memory
        default:
          lines.push(`${tag} [${block.type}]`);
      }
    }
  }
  return lines.join('\n');
}

/** True if a boundary may be placed BEFORE turn i (never inside a tool loop). */
function isBoundary(turns: Turn[], i: number): boolean {
  if (i <= 0 || i >= turns.length) return false;
  const prev = turns[i - 1]!;
  const cur = turns[i]!;
  if (prev.role !== 'assistant' || cur.role !== 'user') return false;
  if (Array.isArray(prev.content) && (prev.content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_use')) return false;
  if (Array.isArray(cur.content) && (cur.content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_result')) return false;
  return true;
}

export interface AssembledWindow {
  messages: Turn[];
  stats: WindowStats;
}

/**
 * assembleWindow: raw tail at full detail + tier summaries + graph index,
 * inside a fixed token budget. Presses whole segments with hysteresis so the
 * assembled prefix stays byte-identical between molts (provider prompt cache
 * survives). Mechanical/salience only — this runs on the request path.
 */
export async function assembleWindow(
  store: Store,
  meta: ConversationMeta,
  allTurns: Turn[],
  indexText: string,
  cfg: DreamConfig,
): Promise<AssembledWindow> {
  const budget = cfg.windowBudget;
  const rawBudget = budget * 0.5;
  const t1Budget = budget * 0.25;
  const t2Budget = budget * 0.15;
  const indexBudget = budget * 0.1;

  const rawTokens = countTokensOf(allTurns);
  let pressedNow = false;

  // Hysteresis: press only when the raw tail overflows its budget by >25%,
  // and then press whole segments (large steps → stable prefix between molts).
  let tail = allTurns.slice(meta.pressedUpTo);
  if (countTokensOf(tail) > rawBudget * (1 + cfg.pressHysteresis)) {
    const pairTarget = cfg.segmentTurnPairs * 2;
    while (countTokensOf(tail) > rawBudget && tail.length > pairTarget) {
      // Find the furthest valid boundary within one segment of turns.
      let cut = -1;
      const from = meta.pressedUpTo;
      const maxCut = Math.min(from + pairTarget, allTurns.length - 2);
      for (let i = from + 2; i <= maxCut; i++) {
        if (isBoundary(allTurns, i)) cut = i;
      }
      if (cut === -1) {
        for (let i = maxCut; i < allTurns.length - 1; i++) {
          if (isBoundary(allTurns, i)) {
            cut = i;
            break;
          }
        }
      }
      if (cut === -1 || cut <= from) break;

      const segment = allTurns.slice(from, cut);
      const text = turnsToText(segment);
      const r = await press(store, text, 1, { ns: meta.ns, fromTurn: from, toTurn: cut - 1 });
      meta.tierBlocks.t1 = [...(meta.tierBlocks.t1 ?? []), r.block.id];
      meta.pressedUpTo = cut;
      pressedNow = true;
      tail = allTurns.slice(meta.pressedUpTo);
    }
  }

  // Load tier blocks; molt oldest t1 → t2 when tier-1 overflows its budget.
  let t1Blocks = (meta.tierBlocks.t1 ?? []).map((id) => store.get(meta.ns, id)).filter((b): b is Block => b !== null);
  const t2Ids = new Set(meta.tierBlocks.t2 ?? []);
  // Molt when tier-1 overflows; a lone block is molted too once it is more
  // than double the budget (otherwise it could pin the window forever).
  while (
    t1Blocks.reduce((s, b) => s + b.pressedTokens, 0) > t1Budget &&
    (t1Blocks.length > 1 || (t1Blocks[0]?.pressedTokens ?? 0) > t1Budget * 2)
  ) {
    const oldest = t1Blocks.shift()!;
    const r = await press(store, oldest.pressed, 2, { ns: meta.ns, fromTurn: oldest.fromTurn, toTurn: oldest.toTurn });
    meta.tierBlocks.t1 = (meta.tierBlocks.t1 ?? []).filter((id) => id !== oldest.id);
    if (!t2Ids.has(r.block.id)) {
      meta.tierBlocks.t2 = [...(meta.tierBlocks.t2 ?? []), r.block.id];
      t2Ids.add(r.block.id);
    }
    pressedNow = true;
  }
  let t2Blocks = (meta.tierBlocks.t2 ?? []).map((id) => store.get(meta.ns, id)).filter((b): b is Block => b !== null);
  // Tier-2 overflow: recursively salience-press the oldest half into tier 3.
  while (t2Blocks.reduce((s, b) => s + b.pressedTokens, 0) > t2Budget && t2Blocks.length > 2) {
    const oldest = t2Blocks.shift()!;
    const r = await press(store, oldest.pressed, 3, { ns: meta.ns, fromTurn: oldest.fromTurn, toTurn: oldest.toTurn });
    meta.tierBlocks.t2 = (meta.tierBlocks.t2 ?? []).filter((id) => id !== oldest.id);
    meta.tierBlocks.t3 = [...(meta.tierBlocks.t3 ?? []), r.block.id];
    pressedNow = true;
  }
  const t3Blocks = (meta.tierBlocks.t3 ?? []).map((id) => store.get(meta.ns, id)).filter((b): b is Block => b !== null);

  store.putMeta(meta);

  // Build the memory prelude.
  let index = indexText;
  if (countTokens(index) > indexBudget && index.length > 0) {
    index = saliencePress(index, (indexBudget * 4) / Math.max(1, index.length));
  }

  const sections: string[] = [];
  if (index.trim() !== '') sections.push(`## Known facts and decisions (memory index)\n${index}`);
  if (t3Blocks.length + t2Blocks.length > 0) {
    const older = [...t3Blocks, ...t2Blocks]
      .sort((a, b) => (a.fromTurn ?? 0) - (b.fromTurn ?? 0))
      .map((b) => `[block ${b.id}]\n${b.pressed}`)
      .join('\n');
    sections.push(`## Older history (heavily compressed)\n${older}`);
  }
  if (t1Blocks.length > 0) {
    sections.push(`## Earlier in this conversation (compressed)\n${t1Blocks.map((b) => `[block ${b.id}]\n${b.pressed}`).join('\n')}`);
  }

  const blocksUsed = t1Blocks.length + t2Blocks.length + t3Blocks.length;
  let messages: Turn[];
  if (sections.length === 0) {
    messages = tail;
  } else {
    const memory =
      `<dream-memory>\nThis conversation has prior history, compressed below. Recent turns follow at full detail.\n\n` +
      sections.join('\n\n') +
      `\n\nVerbatim originals of any [block ...] are available via the dream_unpack tool (or GET /blocks/:id).\n</dream-memory>`;
    messages = [{ role: 'user', content: memory }, { role: 'assistant', content: 'Acknowledged. Continuing with full awareness of the prior context.' }, ...tail];
  }

  const sentTokens = countTokensOf(messages);
  return {
    messages,
    stats: {
      rawTokens,
      sentTokens,
      savingsPct: rawTokens === 0 ? 0 : Math.max(0, Math.round((1 - sentTokens / rawTokens) * 100)),
      blocks: blocksUsed,
      indexTokens: countTokens(index),
      tailTurns: tail.length,
      pressed: pressedNow,
    },
  };
}
