/** CLI argument parsing and helpers (port of `cmd/filmix/*_test.go`). */
import { describe, expect, it } from 'vitest';
import { hostLooksLikeFilmix, parseIdArg, parseIdArgWithUrl } from '../src/cli/id.js';
import { parseRange } from '../src/cli/ranges.js';
import { buildSeriesJobs, discoverEpisodes, uniformQualities } from '../src/cli/commands.js';
import { formatTable, humanBytes, renderBar } from '../src/cli/progress.js';
import { Post } from '../src/models/post.js';

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

describe('parseRange', () => {
  it.each([
    ['empty', '', []],
    ['whitespace', '   ', []],
    ['single', '1', [1]],
    ['hyphen range', '2-3', [2, 3]],
    ['list', '1,3,5', [1, 3, 5]],
    ['mixed', '1,3,7-9', [1, 3, 7, 8, 9]],
    ['dedup', '1,1,2,2-3', [1, 2, 3]],
    ['unordered', '5,1,3', [1, 3, 5]],
    ['whitespace tokens', ' 1 , 3 - 4 ', [1, 3, 4]],
    ['single element range', '4-4', [4]],
  ])('%s', (_name, input, want) => {
    expect(parseRange(input)).toEqual(want);
  });

  it.each([
    ['trailing comma', '1,'],
    ['leading comma', ',1'],
    ['empty token', '1,,2'],
    ['bad number', 'abc'],
    ['reversed range', '5-3'],
    ['zero', '0'],
    ['negative', '-1'],
    ['open low', '-3'],
    ['open high', '3-'],
    ['double dash', '1--3'],
    ['non-numeric range', 'a-b'],
    ['oversized range', '1-2147483647'],
    ['oversized via list', '1,3-2000000'],
  ])('%s throws', (_name, input) => {
    expect(() => parseRange(input)).toThrow();
  });
});

const seriesPost = (): Post =>
  Post.fromJson({
    id: 1,
    section: 7,
    player_links: {
      playlist: {
        '1': {
          Dub: [
            { link: 'https://cdn/s1e1_[720].mp4' },
            { link: 'https://cdn/s1e2_[720].mp4' },
          ],
          Original: [{ link: 'https://cdn/s1e1_orig_[1080,720].mp4' }],
        },
        '2': {
          Dub: [{ link: 'https://cdn/s2e1_[720].mp4' }],
        },
      },
    },
  });

describe('buildSeriesJobs', () => {
  it('expands the cross product when episodes are given', () => {
    expect(buildSeriesJobs(seriesPost(), '', [1], [1, 2])).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]);
  });

  it('discovers every episode of each season when none are given', () => {
    expect(buildSeriesJobs(seriesPost(), '', [1, 2], [])).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
      { season: 2, episode: 1 },
    ]);
  });

  it('defaults to season 1', () => {
    expect(buildSeriesJobs(seriesPost(), 'Dub', [], [])).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]);
  });

  it('honours an explicit translation', () => {
    expect(buildSeriesJobs(seriesPost(), 'Original', [1], [])).toEqual([
      { season: 1, episode: 1 },
    ]);
  });

  it('throws when a season has no episodes', () => {
    expect(() => buildSeriesJobs(seriesPost(), '', [9], [])).toThrow(/no episodes found/);
  });
});

describe('discoverEpisodes', () => {
  it('falls back to the first translation that has the season', () => {
    expect(discoverEpisodes(seriesPost(), 2, '')).toEqual([1]);
    expect(discoverEpisodes(seriesPost(), 2, 'Original')).toEqual([]);
    expect(discoverEpisodes(seriesPost(), 7, '')).toEqual([]);
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

describe('progress formatting', () => {
  it('renders byte sizes like the Go CLI', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(2048)).toBe('2.0 KiB');
    expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
    expect(humanBytes(3 * 1024 ** 3)).toBe('3.0 GiB');
  });

  it('renders a fixed-width bar', () => {
    expect(renderBar(0, 10)).toBe(' '.repeat(10));
    expect(renderBar(50, 10)).toBe('#####     ');
    expect(renderBar(100, 10)).toBe('#'.repeat(10));
    expect(renderBar(150, 10)).toBe('#'.repeat(10));
  });

  it('aligns table columns', () => {
    const out = formatTable([
      ['ID', 'TITLE'],
      ['1', 'short'],
      ['12345', 'longer title'],
    ]);
    expect(out.split('\n')).toEqual(['ID     TITLE', '1      short', '12345  longer title']);
  });
});
