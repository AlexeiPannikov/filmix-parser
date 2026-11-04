import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveDestination, translationKey } from '../src/filmix.js';
import { partFile } from '../src/download/downloader.js';

describe('translationKey', () => {
  it.each([
    ['', ''],
    ['Dub', 'Dub'],
    ['Dub HEVC 4K', 'DubHEVC4K'],
    ['Dub Normal', 'DubNormal'],
    // Truncated to 16 letters/digits, counted in characters not bytes.
    ['IdeaFilm (Кубик в кубе)', 'IdeaFilmКубиквку'],
    ['(((***)))', ''],
    ['Оригинал', 'Оригинал'],
    ['Original (EN)', 'OriginalEN'],
  ])('translationKey(%j) === %j', (input, want) => {
    expect(translationKey(input)).toBe(want);
  });
});

describe('deriveDestination', () => {
  it('uses the URL basename for an empty hint', () => {
    expect(
      deriveDestination(
        'https://nl105.cdnsqu.com/s/abc.xyz/UHD_1313/Mercy.2026.MVO.Ukr.V1R.BDRip.1080p_720.mp4',
        '',
      ),
    ).toBe('Mercy.2026.MVO.Ukr.V1R.BDRip.1080p_720.mp4');
  });

  it('treats a trailing slash as a directory', () => {
    expect(deriveDestination('https://cdn/path/movie_720.mp4', 'out/')).toBe(
      path.join('out', 'movie_720.mp4'),
    );
    expect(deriveDestination('https://cdn/path/movie_720.mp4', 'out' + path.sep)).toBe(
      path.join('out', 'movie_720.mp4'),
    );
  });

  it('uses a literal hint verbatim', () => {
    expect(deriveDestination('https://cdn/path/whatever.mp4', 'custom.mp4')).toBe('custom.mp4');
    expect(deriveDestination('https://cdn/path/whatever.mp4', path.join('dir', 'out.mp4'))).toBe(
      path.join('dir', 'out.mp4'),
    );
  });

  it('strips the query string from the derived filename', () => {
    expect(deriveDestination('https://cdn/path/movie.mp4?sig=abc&t=123', '')).toBe('movie.mp4');
  });

  it('rejects a URL with no filename', () => {
    expect(() => deriveDestination('https://cdn', '')).toThrow(/cannot derive filename/);
    expect(() => deriveDestination('not a url', '')).toThrow(/parse URL for filename/);
  });
});

describe('partFile', () => {
  it.each([
    ['out.mp4', 0, '', 'out.mp4.part'],
    ['out.mp4', 720, '', 'out.mp4.part_720p'],
    ['out.mp4', 0, 'Dub', 'out.mp4.part_Dub'],
    ['out.mp4', 720, 'Dub', 'out.mp4.part_Dub_720p'],
    ['a/b.mp4', 1080, 'IdeaFilm', 'a/b.mp4.part_IdeaFilm_1080p'],
  ])('partFile(%j, %i, %j)', (dst, quality, variant, want) => {
    expect(partFile(dst, quality, variant)).toBe(want);
  });
});
