import { describe, expect, it } from 'vitest';
import {
  GARBAGE_CHUNKS,
  decode,
  encodeForTesting,
  looksLikeText,
  removeChunk,
} from '../src/site/decoder.js';
import { CannotDecodeError } from '../src/errors.js';

describe('decode — real samples', () => {
  // Real samples captured from filmix.my on 2026-05-11 — post 141626. All four
  // translations differ but decode to URLs sharing the session prefix
  // `https://filmix.my/pl/FHsxCm2dVI...` plus a per-translation manifest name.
  it.each([
    [
      'IdeaFilm video link',
      '#2aHR0cHM6Ly9maWxtaXgubXkvcGwvRkhze:<:MTluMWlLQnI4OXVic2tTNXpUENtMmRWS:<:Mm93S0RVb0d6c3:<:SURhQnQwOEM5V2Y3bFl:<:bE5qSTlWNVUxZ01uc3h0NFFyyMGVIVMTkV5aE54TNaMGFMQVMwdElnVlgwRkJRVUZCUW1jMF:<:bzl3UHQwaWk0MkdXZVM3TDdBNGVkZValZHVUZOQ1prb3hiMWxGUFEuOUNDQnZzMzY1MXFBcE5hdjBNTElDZU5yczhheXI4WXc0c1JvUGcvdXAvTm9ybWFsLVBlb3BsZS0yMDIwLUJDQy50eHQ=',
      'https://filmix.my/pl/FH',
      'Normal-People-2020-BCC.txt',
    ],
    [
      'TVShows video link',
      '#2aHR0cHM6Ly9maWxtaXgubXkvcGwvRkhzeENtMmRWSTNaMGFMQVMwdElnVlgwRkJRVUZCUW1jMFNGVkZValZHVUZOQ1prb3hiMWx:<:Mm93S0RVb0d:<:bzl3UHQwaWk0MkdXZVM3TDdB6c3VMTkV5aE54GUFE:<:bE5qSTlWNVUxZ01uc3h0NFFyuOUNDQnZzMzY1MXFBcE5hdjBNTE:<:SURhQnQwOEM5V2Y3bFlyMGVIlDZU5yczhheXI4WXc0c1JvUGcvdXAvTm9ybWFsLVBlb3BsZS0yMDIwLUJDQy1UVlNob3dzLn:<:MTluMWlLQnI4OXVic2tTNXpUR4dA==',
      'https://filmix.my/pl/FH',
      'Normal-People-2020-BCC-TVShows.txt',
    ],
    [
      'Kirilica video link',
      '#2aHR0cHM6Ly9maWx:<:bE5qSTlWNVUxZ01uc3h0NFFytaXgu:<:SURhQnQwOEM5V2Y3bFlyMGVIbXkvcGwvRkhzeENtMmRWSTNaMGFMQVMwdElnVlgwRkJRVUZCUW1jMFNGVkZValZHVUZOQ1prb3hiMWxGUFEuOUNDQnZzMzY1MXFBcE5hdjB:<:MTluMWlLQnI4OXVic2tTNXpUNTElDZU5yczhheXI4WXc0c1JvUGcvdXAvbm9ybWFsLnBlb3BsZS5raXJpbGljYS0yMD:<:Mm93S0RVb:<:bzl3UHQwaWk0MkdXZVM3TDdB0d6c3VMTkV5aE54IwLnR4dA==',
      'https://filmix.my/pl/FH',
      'normal.people.kirilica-2020.txt',
    ],
    [
      'MVO video link',
      '#2aHR0cHM6Ly9maWxtaXgubXkvcGwvRkhzeENtMmRWSTNaMGFMQVMwdElnVlgwRk:<:MTluMWlLQnI4OXVic2tTNXpUJRVUZCUW1jMFNGVkZValZHVUZOQ1prb3hiMWxGUFEuOUNDQnZzMzY1MXFBcE5hdjBNTElDZU5yczhheXI4WXc0c:<:bE5qSTlWNVUxZ01uc3h0NFFy1JvUGcvdXAvTm9ybWFsLVBlb3BsZS1:<:SURhQnQwOEM5V2Y3bFlyMGVIHYXlkY:<:Mm93S0RVb0d6c3VMTkV5aE54W1hay0yMDI1LnR4dA:<:bzl3UHQwaWk0MkdXZVM3TDdB==',
      'https://filmix.my/pl/FH',
      'Normal-People-Gaydamak-2025.txt',
    ],
  ])('%s', (_name, encoded, wantPrefix, wantSuffix) => {
    const got = decode(encoded);
    expect(got.startsWith(wantPrefix)).toBe(true);
    expect(got.endsWith(wantSuffix)).toBe(true);
  });
});

describe('decode — validation', () => {
  it('rejects a non-#2 prefix', () => {
    expect(() => decode('foo')).toThrow(/not a #2-encoded string/);
    expect(() => decode('#1abcd')).toThrow(/not a #2-encoded string/);
  });

  it('rejects a payload whose garbage chunks are missing', () => {
    expect(() => decode('#2' + Buffer.from('https://x').toString('base64'))).toThrow(
      CannotDecodeError,
    );
  });

  it('rejects decoded output containing control bytes', () => {
    // Printable text with an embedded ESC (0x1B): a decode that "succeeds" but
    // produced garbage, which must not be forwarded as a URL.
    const raw = Buffer.from('https://filmix.\u001bevil/path', 'utf8').toString('base64');
    expect(() => decode('#2' + GARBAGE_CHUNKS.join('') + raw)).toThrow(CannotDecodeError);
  });

  it('round-trips encodeForTesting', () => {
    const payload = '[480p]https://cdn/a_480.mp4,[720p]https://cdn/a_720.mp4';
    expect(decode(encodeForTesting(payload))).toBe(payload);
  });

  it('also strips the whitespace-separated separator form', () => {
    const payload = 'https://filmix.my/pl/x.txt';
    const base = Buffer.from(payload, 'utf8').toString('base64');
    expect(decode('#2' + GARBAGE_CHUNKS.join('') + ': <:' + base)).toBe(payload);
  });
});

describe('removeChunk', () => {
  it('removes a contiguous chunk', () => {
    expect(removeChunk('AAAGARBAGEBBB', 'GARBAGE')).toBe('AAABBB');
  });

  it('removes a chunk split in two', () => {
    expect(removeChunk('AAAGARBmiddleAGEBBB', 'GARBAGE')).toBe('AAAmiddleBBB');
  });

  it('returns undefined when neither layout matches', () => {
    expect(removeChunk('AAABBB', 'GARBAGE')).toBeUndefined();
  });
});

describe('looksLikeText', () => {
  it('accepts printable text and whitespace, rejects control bytes', () => {
    expect(looksLikeText(Buffer.from('ok\tline\r\n'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x41, 0x00]))).toBe(false);
    expect(looksLikeText(Buffer.from([0x7f]))).toBe(false);
  });
});
