// Salience extraction: model-free recursive compression. Mechanical dedupe
// can't be applied twice (deduplicated text has nothing left to dedupe), so
// deeper tiers score each line and keep the densest fraction.

const DECISION_WORDS =
  /\b(decided?|chose|chosen|choose|will|must|should|prefers?|preferred|agreed|conclusion|because|therefore|renamed?|fixed|failed|succeeded|outcome|result|instead|switch(?:ed)?|migrat\w+|deprecat\w+|password|secret|key|token|deadline|due)\b/i;
const STACK_FRAME = /^\s*(at\s+\S+\s*\(|File "|\s+\.\.\.|#\d+\s+0x|Traceback)/;
const PATH_ONLY = /^[\s]*[/\\][\w\-./\\]+:?\d*\s*$/;
const HAS_NUMBER = /\d/;
const ROLE_MARKER = /^\[(human|user)\]/i;
const ASSISTANT_MARKER = /^\[(assistant|ai)\]/i;

export function scoreLine(line: string): number {
  const t = line.trim();
  if (t === '') return -10;
  let score = 0;
  if (ROLE_MARKER.test(t)) score += 3;
  else if (ASSISTANT_MARKER.test(t)) score += 2;
  else score += 1; // machine output baseline
  if (HAS_NUMBER.test(t)) score += 1;
  if (DECISION_WORDS.test(t)) score += 2;
  if (STACK_FRAME.test(t) || PATH_ONLY.test(t)) score -= 2;
  if (t.length < 4) score -= 1;
  // Density bonus: proper nouns / identifiers suggest facts.
  if (/[A-Z][a-z]+\s[A-Z][a-z]+/.test(t) || /`[^`]+`/.test(t)) score += 1;
  return score;
}

/**
 * Keep the highest-scoring fraction of lines, preserving original order.
 * `keepFraction` of 0.4 keeps the top ~40% of lines by score.
 */
export function saliencePress(text: string, keepFraction = 0.45): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length <= 3) return lines.join('\n');

  const scored = lines.map((line, i) => ({ line, i, score: scoreLine(line) }));
  const target = Math.max(3, Math.ceil(lines.length * keepFraction));
  const keep = [...scored]
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, target)
    .sort((a, b) => a.i - b.i);
  return keep.map((k) => k.line).join('\n');
}
