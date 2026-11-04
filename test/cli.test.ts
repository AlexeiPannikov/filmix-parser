/** CLI argument parsing and helpers (port of `cmd/filmix/*_test.go`). */
import { describe, expect, it } from 'vitest';
import { hostLooksLikeFilmix, parseIdArg, parseIdArgWithUrl } from '../src/cli/id.js';
import { parseSource, printLinks, uniformQualities } from '../src/cli/commands.js';
import { formatTable } from '../src/cli/table.js';

describe('parseIdArg', () => {
  it.each([
    ['plain id', '184075', 184075],
    ['id with whitespace', '  184075  ', 184075],
    ['film url', 'https://filmix.my/film/triller/184075-v-normal-2025.html', 184075],
    ['series url', 'https://filmix.my/serialy/drama/141626-normalnye-ludi-2020.html', 141626],
    ['url without genre prefix', 'https://filmix.ac/film/12345-some-title.html', 12345],
    ['url with query string', 'https://filmix.my/film/triller/184075-v-normal-2025.html?ref=share', 184075],
    ['url with fragment', 'https://filmix.my/film/triller/184075-v-normal-2025.html#comments', 184075],
    ['uppercase host', 'https://FILMIX.MY/film/12345-x.html', 12345],
  ])('%s', (_name, input, want) => {
    expect(parseIdArg(input)).toBe(want);
  });

  it.each([
    ['empty', ''],
    ['non-numeric junk', 'abc'],
    ['url without trailing slug', 'https://filmix.my/film/'],
    ['non-filmix url', 'https://example.com/abc'],
    // Matches the slug pattern but points at a foreign host: must be rejected
    // so site cookies are never mirrored to it.
    ['foreign host with valid slug', 'https://attacker.example/film/12345-x.html'],
    ['localhost with valid slug', 'http://localhost:8080/film/12345-x.html'],
  ])('%s throws', (_name, input) => {
    expect(() => parseIdArg(input)).toThrow();
  });

  it('returns the source URL only for URL input', () => {
    expect(parseIdArgWithUrl('184075')).toEqual({ id: 184075, sourceUrl: '' });
    const url = 'https://filmix.my/film/triller/184075-v-normal-2025.html';
    expect(parseIdArgWithUrl(url)).toEqual({ id: 184075, sourceUrl: url });
  });

  it('checks the host case-insensitively', () => {
    expect(hostLooksLikeFilmix('FiLmIx.my')).toBe(true);
    expect(hostLooksLikeFilmix('example.com')).toBe(false);
    expect(hostLooksLikeFilmix('')).toBe(false);
  });
});

describe('uniformQualities', () => {
  it('returns the shared sorted set, or undefined when they differ', () => {
    expect(uniformQualities([])).toEqual([]);
    expect(
      uniformQualities([
        { number: 1, link: '', qualities: [720, 480] },
        { number: 2, link: '', qualities: [480, 720] },
      ]),
    ).toEqual([480, 720]);
    expect(
      uniformQualities([
        { number: 1, link: '', qualities: [720] },
        { number: 2, link: '', qualities: [480, 720] },
      ]),
    ).toBeUndefined();
  });
});

describe('parseSource', () => {
  it.each([
    ['', 'auto'],
    ['auto', 'auto'],
    ['site', 'site'],
    ['mobile', 'mobile'],
  ])('parseSource(%j) === %j', (raw, want) => {
    expect(parseSource(raw)).toBe(want);
  });

  it('rejects anything else', () => {
    expect(() => parseSource('website')).toThrow(/expected auto, site or mobile/);
    expect(() => parseSource('SITE')).toThrow();
  });
});

describe('printLinks', () => {
  it('prints one block per translation, highest quality first', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    try {
      printLinks(
        {
          source: 'site',
          translations: [
            {
              translation: 'Dub',
              urls: new Map([
                [720, 'https://cdn/a_720.mp4'],
                [1080, 'https://cdn/a_1080.mp4'],
              ]),
            },
          ],
        },
        { season: 2, episode: 3 },
      );
    } finally {
      console.log = original;
    }
    const out = lines.join('\n');
    expect(out).toContain('CDN links for S02E03 (site: decoded from the website manifests)');
    expect(out.indexOf('1080p')).toBeLessThan(out.indexOf('720p'));
    expect(out).toContain('https://cdn/a_1080.mp4');
    // The preview warning belongs to the mobile path only.
    expect(out).not.toContain('short previews');
  });

  it('warns about previews on the mobile path and handles an empty result', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    try {
      printLinks({ source: 'mobile', translations: [] });
    } finally {
      console.log = original;
    }
    const out = lines.join('\n');
    expect(out).toContain('(none resolved)');
    expect(out).toContain('derived from the mobile API templates');
  });
});

describe('table formatting', () => {
  it('aligns table columns', () => {
    const out = formatTable([
      ['ID', 'TITLE'],
      ['1', 'short'],
      ['12345', 'longer title'],
    ]);
    expect(out.split('\n')).toEqual(['ID     TITLE', '1      short', '12345  longer title']);
  });
});
