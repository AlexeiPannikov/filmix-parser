import { CannotDecodeError, FilmixError } from '../errors.js';

/**
 * The fixed 24-character base64 strings that the Filmix backend interleaves
 * into the real base64 payload to obfuscate it. They are constant across
 * translations and across requests; if they ever rotate, this list needs
 * updating (or to be derived dynamically by cross-translation comparison).
 *
 * Each chunk may be **split** at an arbitrary position in the encoded string,
 * so the decoder handles both the contiguous and the prefix+suffix cases.
 *
 * Derived empirically on 2026-05-11 by reverse-engineering the player session.
 */
export const GARBAGE_CHUNKS: readonly string[] = [
  'MTluMWlLQnI4OXVic2tTNXpU',
  'Mm93S0RVb0d6c3VMTkV5aE54',
  'SURhQnQwOEM5V2Y3bFlyMGVI',
  'bE5qSTlWNVUxZ01uc3h0NFFy',
  'bzl3UHQwaWk0MkdXZVM3TDdB',
];

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strips the `#2` prefix, removes the `:<:` separators (pure visual
 * obfuscation), removes each known garbage chunk — contiguous or split in two —
 * and base64-decodes the remainder.
 *
 * @throws {CannotDecodeError} when a chunk is missing or the decoded payload is
 * not printable text.
 */
export function decode(encoded: string): string {
  if (!encoded.startsWith('#2')) {
    throw new FilmixError(
      `filmix: not a #2-encoded string (got ${JSON.stringify(encoded.slice(0, 20))})`,
    );
  }
  // Some samples (clipboard, manifest content) carry the separator with
  // surrounding whitespace; normalise both forms.
  let s = encoded.slice('#2'.length).split(':<:').join('').split(': <:').join('');

  for (const chunk of GARBAGE_CHUNKS) {
    const next = removeChunk(s, chunk);
    if (next === undefined) {
      throw new CannotDecodeError(`garbage ${JSON.stringify(chunk)} not found in payload`);
    }
    s = next;
  }

  // Restore any required padding.
  const pad = (4 - (s.length % 4)) % 4;
  s += '='.repeat(pad);
  if (!BASE64_RE.test(s)) {
    throw new FilmixError('filmix: base64 decode: payload contains non-base64 characters');
  }
  const raw = Buffer.from(s, 'base64');

  // The decoder is greedy when a garbage chunk does not appear contiguously:
  // removeChunk falls back to a split prefix+suffix search, which on long
  // payloads can match real base64 noise and eat real bytes. Base64-decoding
  // such a mangled string still succeeds (every byte is a valid raw byte) and
  // yields text mixed with control bytes. All real #2 payloads (URLs, JSON)
  // are printable, so any control byte outside \t\n\r signals corruption.
  if (!looksLikeText(raw)) {
    throw new CannotDecodeError('decoded payload has non-text bytes (garbage chunks may have rotated)');
  }
  return raw.toString('utf8');
}

/**
 * Wraps `payload` in a `#2` envelope that {@link decode} can unwrap. Used by
 * tests that need to round-trip plaintext through the obfuscation layer. The
 * result uses the simplest contiguous-chunk layout; `decode` handles both.
 */
export function encodeForTesting(payload: string): string {
  return '#2' + GARBAGE_CHUNKS.join('') + Buffer.from(payload, 'utf8').toString('base64');
}

/**
 * Reports whether `b` is plausibly text with no embedded binary control bytes.
 * Tab, LF and CR are allowed.
 */
export function looksLikeText(b: Uint8Array): boolean {
  for (const c of b) {
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/**
 * Caps how short the prefix half of a split chunk match may be. With k=1 the
 * fallback would match any single base64 character and gladly eat real bytes;
 * flooring it at 4 (or len/4, whichever is larger) means a match must share a
 * non-trivial run with the real chunk. All observed Filmix splits use a prefix
 * of >= 11 characters, well above this floor.
 */
const MIN_SPLIT_PREFIX_LEN = 4;

/**
 * Removes the first occurrence of `chunk` from `s`, supporting two layouts:
 *
 * 1. `chunk` appears contiguously — plain substring delete.
 * 2. `chunk` was split into prefix+suffix with arbitrary real text between —
 *    find the longest prefix present in `s` whose suffix also appears after it,
 *    then drop both.
 *
 * @returns the cleaned string, or undefined when the chunk was not found.
 */
export function removeChunk(s: string, chunk: string): string | undefined {
  const at = s.indexOf(chunk);
  if (at >= 0) return s.slice(0, at) + s.slice(at + chunk.length);

  const floor = Math.max(MIN_SPLIT_PREFIX_LEN, Math.floor(chunk.length / 4));
  for (let k = chunk.length - 1; k >= floor; k--) {
    const prefix = chunk.slice(0, k);
    const suffix = chunk.slice(k);
    const pi = s.indexOf(prefix);
    if (pi < 0) continue;
    const si = s.indexOf(suffix, pi + prefix.length);
    if (si < 0) continue;
    return s.slice(0, pi) + s.slice(pi + prefix.length, si) + s.slice(si + suffix.length);
  }
  return undefined;
}
