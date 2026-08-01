import type { Block } from '../types.js';
import { Store } from '../store/store.js';
import { countTokens } from './tokens.js';
import { mechanicalPress } from './mechanical.js';
import { saliencePress } from './salience.js';
import { semanticPress, type SemanticOpts } from './semantic.js';

export interface PressOpts {
  ns: string;
  /** Semantic backend config; when absent, model-free backends are used. */
  semantic?: SemanticOpts;
  /** Segment range covered by this block, for provenance. */
  fromTurn?: number;
  toTurn?: number;
  now?: number;
}

export interface PressResult {
  block: Block;
  cached: boolean;
  /** True when the press failed to shrink the text ≥15% — material is incompressible. */
  stopped: boolean;
}

export const MIN_SHRINK = 0.15;

/**
 * press(text, tier, opts) — compress `text` into a tier-`tier` block.
 * Content-addressed: the same (tier, text) presses once and only once.
 *
 * Backend policy: tier 1 uses mechanical (or semantic when a key is
 * available); tier 2+ uses salience extraction, since mechanical dedupe
 * cannot be applied twice.
 */
export async function press(store: Store, text: string, tier: number, opts: PressOpts): Promise<PressResult> {
  const cached = store.getByContent(opts.ns, tier, text);
  if (cached) return { block: cached, cached: true, stopped: false };

  let pressed: string;
  let backend: Block['backend'];
  if (opts.semantic) {
    try {
      pressed = await semanticPress(text, opts.semantic);
      backend = 'semantic';
    } catch {
      pressed = tier <= 1 ? mechanicalPress(text) : saliencePress(text);
      backend = tier <= 1 ? 'mechanical' : 'salience';
    }
  } else if (tier <= 1) {
    pressed = mechanicalPress(text);
    backend = 'mechanical';
  } else {
    pressed = saliencePress(text);
    backend = 'salience';
  }

  const originalTokens = countTokens(text);
  const pressedTokens = countTokens(pressed);
  const stopped = pressedTokens > originalTokens * (1 - MIN_SHRINK);

  const block: Block = {
    id: Store.blockId(tier, text),
    tier,
    ns: opts.ns,
    pressed,
    original: text,
    at: opts.now ?? Date.now(),
    backend,
    originalTokens,
    pressedTokens,
    fromTurn: opts.fromTurn,
    toTurn: opts.toTurn,
  };
  store.put(block);
  return { block, cached: false, stopped };
}
