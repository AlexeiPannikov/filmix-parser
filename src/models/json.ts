/** Loose JSON readers mirroring the Go decoder's tolerance for mixed types. */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reads an integer that the API may encode as a number, a numeric string, or
 * omit entirely. Mirrors `models.parseLooseInt`; unparseable input yields 0.
 */
export function looseInt(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/**
 * Reads a boolean that the API may encode as a bool, `"0"`/`"1"`, `"true"`, or
 * a number. Mirrors `models.parseLooseBool`.
 */
export function looseBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === '1' || v === 'true';
  if (typeof v === 'number') return v !== 0;
  return false;
}

/** Reads a string field, defaulting to `''` for anything else. */
export function looseString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Reads an array of integers, skipping entries that are not numeric. */
export function intArray(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const item of v) {
    if (typeof item === 'number' && Number.isFinite(item)) out.push(Math.trunc(item));
    else if (typeof item === 'string') {
      const n = Number.parseInt(item, 10);
      if (!Number.isNaN(n)) out.push(n);
    }
  }
  return out;
}
