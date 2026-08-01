// Mechanical press: model-free compression of repetitive machine output.
// Normalizes volatile parts of each line, fingerprints the result, and keeps
// at most two occurrences per fingerprint plus a count of what was dropped.

const NORMALIZERS: Array<[RegExp, string]> = [
  // ISO timestamps: 2026-08-01T12:34:56.789Z / 2026-08-01 12:34:56
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>'],
  // clock times
  [/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<TS>'],
  // uuids
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<UUID>'],
  // long hex identifiers (hashes, addresses, ids)
  [/\b(?:0x)?[0-9a-fA-F]{8,64}\b/g, '<HEX>'],
  // durations: 12ms, 3.4s, 250us
  [/\b\d+(?:\.\d+)?\s?(?:ms|us|µs|ns|s)\b/g, '<DUR>'],
  // sizes: 12KB, 3.4MiB
  [/\b\d+(?:\.\d+)?\s?(?:B|KB|MB|GB|KiB|MiB|GiB)\b/g, '<SIZE>'],
  // bare longish numbers (ports, pids, offsets) — small numbers usually carry meaning, keep them
  [/\b\d{5,}\b/g, '<N>'],
];

export function normalizeLine(line: string): string {
  let out = line;
  for (const [re, sub] of NORMALIZERS) out = out.replace(re, sub);
  return out.trim();
}

export function mechanicalPress(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim() !== '');

  const totals = new Map<string, number>();
  for (const line of lines) {
    const fp = normalizeLine(line);
    totals.set(fp, (totals.get(fp) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const line of lines) {
    const fp = normalizeLine(line);
    const n = (seen.get(fp) ?? 0) + 1;
    seen.set(fp, n);
    if (n > 2) continue;
    out.push(line);
    const total = totals.get(fp) ?? 0;
    const isLastKept = n === Math.min(2, total);
    if (isLastKept && total > 2) out.push(`  (+${total - 2} more similar lines)`);
  }
  return out.join('\n');
}
