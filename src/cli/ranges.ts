/**
 * Caps how many integers {@link parseRange} will materialise. Without a limit,
 * an input like `1-2147483647` would allocate billions of entries and exhaust
 * memory. 10000 is well above any plausible season length while still bounding
 * the worst case.
 */
const MAX_RANGE_SIZE = 10_000;

/**
 * Parses a range expression like `1`, `2-3`, `1,3,5` or `1,3,7-9` into a
 * sorted, deduplicated list of positive integers. Whitespace around tokens is
 * tolerated; an empty input yields an empty list.
 */
export function parseRange(input: string): number[] {
  const s = input.trim();
  if (s === '') return [];

  const seen = new Set<number>();
  for (const rawToken of s.split(',')) {
    const token = rawToken.trim();
    if (token === '') throw new Error(`empty range token in ${JSON.stringify(s)}`);

    const dash = token.indexOf('-');
    if (dash >= 0) {
      const { lo, hi } = parseRangeBounds(token, dash);
      if (hi - lo + 1 > MAX_RANGE_SIZE - seen.size) {
        throw new Error(
          `range ${JSON.stringify(token)} expands beyond ${MAX_RANGE_SIZE} values; refusing to allocate`,
        );
      }
      for (let i = lo; i <= hi; i++) seen.add(i);
      continue;
    }
    if (!/^\d+$/.test(token)) throw new Error(`invalid range token ${JSON.stringify(token)}`);
    const n = Number.parseInt(token, 10);
    if (n < 1) throw new Error(`range value must be >= 1, got ${n}`);
    seen.add(n);
  }

  return [...seen].sort((a, b) => a - b);
}

function parseRangeBounds(token: string, dash: number): { lo: number; hi: number } {
  const loStr = token.slice(0, dash).trim();
  const hiStr = token.slice(dash + 1).trim();
  if (loStr === '' || hiStr === '') throw new Error(`incomplete range ${JSON.stringify(token)}`);
  if (!/^\d+$/.test(loStr)) throw new Error(`invalid range low bound in ${JSON.stringify(token)}`);
  if (!/^\d+$/.test(hiStr)) throw new Error(`invalid range high bound in ${JSON.stringify(token)}`);
  const lo = Number.parseInt(loStr, 10);
  const hi = Number.parseInt(hiStr, 10);
  if (lo < 1 || hi < 1) throw new Error(`range values must be >= 1 in ${JSON.stringify(token)}`);
  if (lo > hi) throw new Error(`range ${JSON.stringify(token)} has low > high`);
  return { lo, hi };
}
