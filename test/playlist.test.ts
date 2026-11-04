import { describe, expect, it } from 'vitest';
import {
  guessSeasonNumber,
  labelToQuality,
  parseFileField,
  parsePlaylist,
  qualityFromUrl,
} from '../src/site/playlist.js';
import { parsePlayerDataJson } from '../src/site/player-data.js';
import { ContentLockedError, DecodeError, PlayerDataEmptyError } from '../src/errors.js';

describe('parseFileField', () => {
  it('parses numeric labels', () => {
    const got = parseFileField(
      '[480p]https://cdn/a_480.mp4,[720p]https://cdn/a_720.mp4,[1080p]https://cdn/a_1080.mp4',
    );
    expect(got.get(480)).toBe('https://cdn/a_480.mp4');
    expect(got.get(720)).toBe('https://cdn/a_720.mp4');
    expect(got.get(1080)).toBe('https://cdn/a_1080.mp4');
  });

  it.each([
    ['4K UHD only', '[4K UHD]https://cdn/m_2160.mp4', [[2160, 'https://cdn/m_2160.mp4']]],
    ['UHD shorthand', '[UHD]https://cdn/m_2160.mp4', [[2160, 'https://cdn/m_2160.mp4']]],
    [
      'mixed 4K + numeric',
      '[4K UHD]https://cdn/m_2160.mp4,[1080p]https://cdn/m_1080.mp4,[720p]https://cdn/m_720.mp4',
      [
        [2160, 'https://cdn/m_2160.mp4'],
        [1080, 'https://cdn/m_1080.mp4'],
        [720, 'https://cdn/m_720.mp4'],
      ],
    ],
    ['label without p suffix', '[2160]https://cdn/m_2160.mp4', [[2160, 'https://cdn/m_2160.mp4']]],
  ])('%s', (_name, raw, want) => {
    const got = parseFileField(raw);
    expect([...got.entries()].sort()).toEqual((want as [number, string][]).sort());
  });

  it('skips unrecognised labels', () => {
    expect(parseFileField('[HD]https://cdn/x.mp4').size).toBe(0);
  });

  /**
   * Real field from post 186525: `[1080p]` and `[1080p Ultra+]` both start with
   * 1080, so a label-only mapping collapsed them into one key and dropped the
   * genuine 1080p entry. The file names keep them apart.
   */
  it('keeps [1080p] and [1080p Ultra+] apart via the file name', () => {
    const got = parseFileField(
      '[480p]https://cdn/HD_45/Beguschaya.2026_480.mp4,' +
        '[720p]https://cdn/HD_45/Beguschaya.2026_720.mp4,' +
        '[1080p]https://cdn/HD_45/Beguschaya.2026_1080.mp4,' +
        '[1080p Ultra+]https://cdn/HD_45/Beguschaya.2026_1440.mp4,' +
        '[4K UHD]https://cdn/HD_45/Beguschaya.2026_2160.mp4',
    );
    expect([...got.keys()].sort((a, b) => a - b)).toEqual([480, 720, 1080, 1440, 2160]);
    expect(got.get(1080)).toBe('https://cdn/HD_45/Beguschaya.2026_1080.mp4');
    expect(got.get(1440)).toBe('https://cdn/HD_45/Beguschaya.2026_1440.mp4');
  });

  it('trusts the file name over a misleading label', () => {
    // The release name carries 2160p, the actual rendition is 480p.
    const got = parseFileField('[480p]https://cdn/The.Runner.2026.2160p.SDR-HDrezka_480.mp4');
    expect([...got.keys()]).toEqual([480]);
  });

  it('keeps a query string out of the way', () => {
    const got = parseFileField('[720p]https://cdn/s02e05_720.mp4?vs3-origin');
    expect(got.get(720)).toBe('https://cdn/s02e05_720.mp4?vs3-origin');
  });
});

describe('qualityFromUrl', () => {
  it.each([
    ['https://cdn/a_480.mp4', 480],
    ['https://cdn/a_2160.mp4', 2160],
    ['https://cdn/a_720.mp4?vs3-origin', 720],
    ['https://cdn/The.Runner.2026.2160p.SDR-HDrezka_1080.mp4', 1080],
    ['https://cdn/a.mp4', undefined],
    ['https://cdn/part_2.mp4', undefined],
    ['https://cdn/a_99999.mp4', undefined],
  ])('qualityFromUrl(%j) === %j', (url, want) => {
    expect(qualityFromUrl(url)).toBe(want);
  });
});

describe('labelToQuality', () => {
  it.each([
    ['4K UHD', 2160],
    ['UHD', 2160],
    ['4K', 2160],
    ['4k uhd', 2160],
    ['1080p', 1080],
    ['1080', 1080],
    ['720P', 720],
    ['  480p ', 480],
    ['', undefined],
    ['HD', undefined],
  ])('labelToQuality(%j) === %j', (label, want) => {
    expect(labelToQuality(label)).toBe(want);
  });
});

describe('parsePlaylist', () => {
  it('parses a movie manifest', () => {
    const pl = parsePlaylist(
      '[{"title":"Foo","id":"m1","file":"[480p]https://cdn/m_480.mp4,[1080p]https://cdn/m_1080.mp4"}]',
    );
    expect(pl.movie).toBeDefined();
    expect(pl.movie?.qualities.get(1080)).toBe('https://cdn/m_1080.mp4');
    expect(pl.movie?.availableQualities()).toEqual([480, 1080]);
    expect(pl.seasons).toBeUndefined();
  });

  it('parses a series manifest with folders', () => {
    const pl = parsePlaylist(`[
      {"title":" Сезон 1","folder":[
        {"title":"Серия 1 (Сезон 1)","id":"s1e1","file":"[480p]https://cdn/s01e01_480.mp4,[720p]https://cdn/s01e01_720.mp4"},
        {"title":"Серия 2 (Сезон 1)","id":"s1e2","file":"[480p]https://cdn/s01e02_480.mp4,[720p]https://cdn/s01e02_720.mp4"}
      ]},
      {"title":" Сезон 2","folder":[
        {"title":"Серия 1 (Сезон 2)","id":"s2e1","file":"[480p]https://cdn/s02e01_480.mp4"}
      ]}
    ]`);
    expect(pl.movie).toBeUndefined();
    const s1 = pl.seasons?.get(1);
    expect(s1).toHaveLength(2);
    expect(s1?.[0]?.id).toBe('s1e1');
    expect(s1?.[0]?.qualities.get(720)).toBe('https://cdn/s01e01_720.mp4');
    expect(pl.seasons?.get(2)).toHaveLength(1);
  });

  it('accepts a single movie wrapped in an object', () => {
    const pl = parsePlaylist('{"title":"Foo","id":"m1","file":"[720p]https://cdn/m_720.mp4"}');
    expect(pl.movie?.qualities.get(720)).toBe('https://cdn/m_720.mp4');
  });

  it('keeps unnumbered seasons distinct via their position', () => {
    const pl = parsePlaylist(
      '[{"title":"first","folder":[{"file":"[720p]https://cdn/a.mp4"}]},{"title":"second","folder":[{"file":"[720p]https://cdn/b.mp4"}]}]',
    );
    expect([...(pl.seasons?.keys() ?? [])]).toEqual([1, 2]);
  });

  it('rejects malformed and empty manifests', () => {
    expect(() => parsePlaylist('not json')).toThrow(DecodeError);
    expect(() => parsePlaylist('[]')).toThrow(/manifest is empty/);
    expect(() => parsePlaylist('"a string"')).toThrow(DecodeError);
  });
});

describe('guessSeasonNumber', () => {
  it.each([
    [' Сезон 1', 99, 1],
    [' Сезон 12', 99, 12],
    ['Season 3', 99, 3],
    ['weird', 7, 7],
    ['weird', 1, 1],
  ])('guessSeasonNumber(%j, %i) === %i', (title, fallback, want) => {
    expect(guessSeasonNumber(title, fallback)).toBe(want);
  });
});

describe('parsePlayerDataJson', () => {
  it('parses the video and trailer maps', () => {
    const pd = parsePlayerDataJson(
      '{"type":"success","message":{"translations":{"video":{"Дубляж":"#2encA","Оригинал":"#2encB"},"trailers":{"Дубляж":"#2tr"}}},"field":""}',
    );
    expect(pd.locked).toBe(false);
    expect(pd.video.size).toBe(2);
    expect(pd.video.get('Дубляж')).toBe('#2encA');
    expect(pd.trailers.get('Дубляж')).toBe('#2tr');
  });

  it('reports a takedown through ContentLockedError', () => {
    expect(() =>
      parsePlayerDataJson(
        '{"type":"success","message":{"translations":{"lv":true,"video":[],"trailers":[]}},"field":""}',
      ),
    ).toThrow(ContentLockedError);
  });

  it('reports an empty video map through PlayerDataEmptyError', () => {
    expect(() =>
      parsePlayerDataJson(
        '{"type":"success","message":{"translations":{"video":[],"trailers":[]}},"field":""}',
      ),
    ).toThrow(PlayerDataEmptyError);
  });

  it('rejects a non-success envelope and malformed JSON', () => {
    expect(() => parsePlayerDataJson('{"type":"error"}')).toThrow(/type="error"/);
    expect(() => parsePlayerDataJson('<html>403</html>')).toThrow(DecodeError);
  });
});
