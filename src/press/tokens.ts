// Token estimation. No public exact Claude tokenizer exists; chars/4 is a
// serviceable approximation for mixed English/code. All budgets keep ~20%
// headroom to absorb the error. Swap this implementation to calibrate.

export function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function countTokensOf(value: unknown): number {
  if (typeof value === 'string') return countTokens(value);
  return countTokens(JSON.stringify(value));
}
