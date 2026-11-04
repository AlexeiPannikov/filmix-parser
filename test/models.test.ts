import { describe, expect, it } from 'vitest';
import { Post } from '../src/models/post.js';
import { Profile } from '../src/models/profile.js';
import { SearchResult } from '../src/models/search.js';
import { decodeApiError } from '../src/models/error.js';
import { Plan } from '../src/models/quality.js';
import { EpisodeNotFoundError, TranslationNotFoundError, DecodeError } from '../src/errors.js';
import { fixture, fixtureJson } from './helpers/server.js';

async function loadPost(name: string): Promise<Post> {
  return Post.fromJson(await fixtureJson(name));
}

describe('Post.fromJson — movie shape', () => {
  it('decodes metadata, translations and derived qualities', async () => {
    const post = await loadPost('post_movie.json');
    expect(post.id).toBe(12345);
    expect(post.title).toBe('Интерстеллар');
    expect(post.origTitle).toBe('Interstellar');
    expect(post.year).toBe(2014);
    expect(post.isSeries()).toBe(false);
    expect(post.playerLinks.movie).toHaveLength(2);

    const dub = post.playerLinks.movie[0]!;
    expect(dub.translation).toBe('Дубляж (Кубик в кубе)');
    expect(dub.qualities).toEqual([1080, 720, 480]);
    expect(post.playerLinks.movie[1]!.qualities).toEqual([2160, 1440, 1080, 720, 480]);
  });

  it('tolerates playlist: [] on a movie post', async () => {
    const post = await loadPost('post_movie.json');
    expect(post.playerLinks.playlist.size).toBe(0);
  });
});

describe('Post.fromJson — series shapes', () => {
  it('decodes the dict-keyed episode form', async () => {
    const post = await loadPost('post_series_dict.json');
    expect(post.isSeries()).toBe(true);
    expect(post.seasons()).toEqual([1, 2]);

    const s1 = post.playerLinks.playlist.get(1)!;
    expect(s1.translations.size).toBe(2);

    const neva = s1.translations.get('Дубляж (Невафильм)')!;
    expect(neva).toHaveLength(2);
    expect(neva.map((e) => e.number)).toEqual([1, 2]);
    expect(neva[0]!.qualities).toEqual([1080, 720]);

    const orig = s1.translations.get('Оригинал (EN)')!;
    expect(orig[0]!.qualities).toEqual([2160, 1080, 720]);

    expect(post.playerLinks.playlist.get(2)!.translations.get('Дубляж (Невафильм)')).toHaveLength(1);
  });

  it('decodes the array episode form with 1-based numbering', async () => {
    const post = await loadPost('post_series_array.json');
    expect(post.isSeries()).toBe(true);
    const dub = post.playerLinks.playlist.get(1)!.translations.get('Дубляж')!;
    expect(dub.map((e) => e.number)).toEqual([1, 2, 3]);
    for (const ep of dub) expect(ep.qualities).toEqual([1080, 720, 480]);
  });

  it('sorts dict-keyed episodes numerically, not lexically', () => {
    const post = Post.fromJson({
      id: 1,
      player_links: {
        playlist: {
          '1': {
            Dub: {
              '10': { link: 'https://cdn/e10_[720].mp4' },
              '2': { link: 'https://cdn/e2_[720].mp4' },
              '1': { link: 'https://cdn/e1_[720].mp4' },
            },
          },
        },
      },
    });
    expect(post.episodes(1, 'Dub').map((e) => e.number)).toEqual([1, 2, 10]);
  });

  it('rejects an episode blob that is neither array nor object', () => {
    expect(() =>
      Post.fromJson({ id: 1, player_links: { playlist: { '1': { Dub: 'nope' } } } }),
    ).toThrow(DecodeError);
  });
});

describe('Post.pickMovie', () => {
  it('returns the alphabetically first translation when none is requested', async () => {
    const post = await loadPost('post_movie.json');
    expect(post.pickMovie('').translation).toBe('Дубляж (Кубик в кубе)');
  });

  it('returns the requested translation', async () => {
    const post = await loadPost('post_movie.json');
    expect(post.pickMovie('Оригинал (EN)').qualities).toEqual([2160, 1440, 1080, 720, 480]);
  });

  it('throws TranslationNotFoundError for an unknown name', async () => {
    const post = await loadPost('post_movie.json');
    expect(() => post.pickMovie('nonexistent')).toThrow(TranslationNotFoundError);
  });
});

describe('Post.pickEpisode', () => {
  it('finds an episode by season/translation/number', async () => {
    const post = await loadPost('post_series_dict.json');
    expect(post.pickEpisode(1, 'Дубляж (Невафильм)', 2).number).toBe(2);
  });

  it('defaults to the alphabetically first translation', async () => {
    const post = await loadPost('post_series_dict.json');
    expect(post.pickEpisode(1, '', 1).number).toBe(1);
  });

  it('reports missing seasons, translations and episodes distinctly', async () => {
    const post = await loadPost('post_series_dict.json');
    expect(() => post.pickEpisode(99, 'Дубляж', 1)).toThrow(EpisodeNotFoundError);
    expect(() => post.pickEpisode(1, 'missing', 1)).toThrow(TranslationNotFoundError);
    expect(() => post.pickEpisode(1, 'Дубляж (Невафильм)', 99)).toThrow(EpisodeNotFoundError);
  });
});

describe('Post.translations', () => {
  it('returns the sorted union across seasons', async () => {
    const post = await loadPost('post_series_dict.json');
    expect(post.translations()).toEqual(['Дубляж (Невафильм)', 'Оригинал (EN)']);
  });
});

describe('decodeApiError', () => {
  it('reads the user_message flavour', async () => {
    const err = decodeApiError(await fixture('error_user_message.json'));
    expect(err?.code).toBe(403);
    expect(err?.apiMessage).toBe('Доступ запрещён. Проверьте токен.');
  });

  it('reads the message flavour', async () => {
    const err = decodeApiError(await fixture('error_message.json'));
    expect(err?.code).toBe(500);
    expect(err?.apiMessage).toBe('Internal error');
  });

  it('returns undefined on a success payload', async () => {
    expect(decodeApiError(await fixture('search.json'))).toBeUndefined();
  });

  it('returns undefined on malformed or empty input', () => {
    expect(decodeApiError('')).toBeUndefined();
    expect(decodeApiError('<html>502 Bad Gateway</html>')).toBeUndefined();
    expect(decodeApiError('{"error":{"code":1}}')).toBeUndefined();
  });

  it('formats the message with and without a code', () => {
    const withCode = decodeApiError('{"error":{"message":"boom","code":7}}');
    expect(withCode?.message).toBe('filmix api: boom (code=7)');
    const noCode = decodeApiError('{"error":{"message":"boom"}}');
    expect(noCode?.message).toBe('filmix api: boom');
  });
});

describe('Profile', () => {
  it('derives the Pro+ plan from loose JSON flags', async () => {
    const profile = Profile.fromJson(await fixtureJson('user_profile_pro.json'));
    expect(profile.userId).toBe(555);
    expect(profile.login).toBe('tester');
    expect(profile.isPro).toBe(true);
    expect(profile.isProPlus).toBe(true);
    expect(profile.plan()).toBe(Plan.ProPlus);
    expect(profile.proUntil?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });

  it('accepts "0"/"1" strings and reports Free without flags', () => {
    expect(Profile.fromJson({ is_pro: '1', is_pro_plus: '0' }).plan()).toBe(Plan.Pro);
    expect(Profile.fromJson({}).plan()).toBe(Plan.Free);
    expect(Profile.fromJson({}).proUntil).toBeUndefined();
  });
});

describe('SearchResult', () => {
  it('decodes the search payload', async () => {
    const results = SearchResult.listFromJson(await fixtureJson('search.json'));
    expect(results).toHaveLength(2);
    expect(results[0]!.title).toBe('Интерстеллар');
    expect(results[0]!.isSeries()).toBe(false);
    expect(results[1]!.isSeries()).toBe(true);
  });

  it('builds page URLs per content kind and trims the mirror slash', () => {
    const movie = new SearchResult({ id: 7, title: 't', origTitle: 'o', year: 2020, section: 0, altName: 'slug' });
    const series = new SearchResult({ id: 8, title: 't', origTitle: 'o', year: 2020, section: 7, altName: 'slug' });
    expect(movie.pageUrl('https://filmix.my/')).toBe('https://filmix.my/film/7-slug.html');
    expect(series.pageUrl('https://filmix.my')).toBe('https://filmix.my/seria/8-slug.html');
  });

  it('returns an empty page URL without altName', async () => {
    const results = SearchResult.listFromJson(await fixtureJson('search.json'));
    expect(results[0]!.pageUrl('https://filmix.my')).toBe('');
  });

  it('rejects a non-array payload', () => {
    expect(() => SearchResult.listFromJson({ not: 'an array' })).toThrow(DecodeError);
  });
});
