// The eval harness: press a session through every tier, quiz each tier using
// only that tier's text, report retention per tier and the cliff. The output
// curve is the regression test for the whole system.
import type { EvalCurve, EvalCurvePoint, EvalTruth } from '../types.js';
import { countTokens } from '../press/tokens.js';
import { mechanicalPress } from '../press/mechanical.js';
import { saliencePress } from '../press/salience.js';
import { semanticPress, type SemanticOpts } from '../press/semantic.js';
import { MIN_SHRINK } from '../press/press.js';

export interface EvaluateOpts {
  maxTiers?: number;
  semantic?: SemanticOpts; // when set, tier 1 uses the semantic backend
  date?: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A truth item survives a tier if ANY of its probe strings survive. */
export function probeRetention(text: string, truth: EvalTruth[]): { retention: number; lost: string[] } {
  const hay = normalize(text);
  const lost: string[] = [];
  let kept = 0;
  for (const t of truth) {
    if (t.probes.some((p) => hay.includes(normalize(p)))) kept++;
    else lost.push(t.question);
  }
  return { retention: truth.length === 0 ? 1 : kept / truth.length, lost };
}

export async function evaluate(sessionText: string, truth: EvalTruth[], opts: EvaluateOpts = {}): Promise<EvalCurve> {
  const maxTiers = opts.maxTiers ?? 6;
  const sessionTokens = countTokens(sessionText);
  const tiers: EvalCurvePoint[] = [];

  const t0 = probeRetention(sessionText, truth);
  tiers.push({ tier: 0, tokens: sessionTokens, ratio: 1, retention: t0.retention, lost: t0.lost });

  let text = sessionText;
  let backend = 'mechanical';
  for (let tier = 1; tier <= maxTiers; tier++) {
    let pressed: string;
    if (tier === 1 && opts.semantic) {
      pressed = await semanticPress(text, opts.semantic);
      backend = 'semantic';
    } else if (tier === 1) {
      pressed = mechanicalPress(text);
    } else {
      pressed = saliencePress(text);
    }

    const tokens = countTokens(pressed);
    const prevTokens = countTokens(text);
    if (tokens > prevTokens * (1 - MIN_SHRINK)) {
      // Incompressible: the measured depth limit. Stop pressing.
      break;
    }
    const { retention, lost } = probeRetention(pressed, truth);
    tiers.push({ tier, tokens, ratio: Math.round(sessionTokens / Math.max(1, tokens)), retention, lost });
    text = pressed;
  }

  const cliff = tiers.find((t) => t.retention < 0.5)?.tier ?? null;
  return {
    date: opts.date ?? new Date().toISOString().slice(0, 10),
    sessionTokens,
    backend,
    tiers,
    cliff,
  };
}
