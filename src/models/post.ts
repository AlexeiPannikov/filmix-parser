import { DecodeError, EpisodeNotFoundError, TranslationNotFoundError } from '../errors.js';
import { intArray, isRecord, looseInt, looseString } from './json.js';
import { parseQualities } from './quality.js';

/**
 * A single translation/dub of a movie. `link` contains the raw URL with a
 * quality placeholder (e.g. `_[1080,720,480].mp4`); `qualities` holds the
 * integer list extracted from it.
 */
export interface Translation {
  translation: string;
  link: string;
  qualities: number[];
}

/** A single series episode. */
export interface Episode {
  number: number;
  link: string;
  qualities: number[];
}

/** Episodes of one season, grouped by translation name. */
export interface Season {
  translations: Map<string, Episode[]>;
}

/**
 * The streamable content of a {@link Post}. Exactly one of `movie` or
 * `playlist` is populated, depending on the post type.
 */
export interface PlayerLinks {
  /** Non-empty for film posts. Each element is one translation/dub. */
  movie: Translation[];
  /** Non-empty for series posts, keyed by season number. */
  playlist: Map<number, Season>;
}

export interface PostInit {
  id: number;
  title: string;
  origTitle: string;
  year: number;
  section: number;
  playerLinks: PlayerLinks;
}

/** A Filmix content entry: either a single movie or a series with episodes. */
export class Post implements PostInit {
  readonly id: number;
  readonly title: string;
  readonly origTitle: string;
  readonly year: number;
  readonly section: number;
  readonly playerLinks: PlayerLinks;

  constructor(init: PostInit) {
    this.id = init.id;
    this.title = init.title;
    this.origTitle = init.origTitle;
    this.year = init.year;
    this.section = init.section;
    this.playerLinks = init.playerLinks;
  }

  /** Parses the `/api/v2/post/{id}` payload. */
  static fromJson(raw: unknown): Post {
    if (!isRecord(raw)) throw new DecodeError('filmix: decode post: payload is not an object');
    return new Post({
      id: looseInt(raw['id']),
      title: looseString(raw['title']),
      origTitle: looseString(raw['original_title']),
      year: looseInt(raw['year']),
      section: looseInt(raw['section']),
      playerLinks: parsePlayerLinks(raw['player_links']),
    });
  }

  /** Reports whether the post is a multi-episode series. */
  isSeries(): boolean {
    return this.playerLinks.playlist.size > 0;
  }

  /**
   * Unique translation names available for the post, sorted. For movies these
   * are the `movie` entries; for series, the union of translation keys across
   * all seasons.
   */
  translations(): string[] {
    const seen = new Set<string>();
    if (this.isSeries()) {
      for (const season of this.playerLinks.playlist.values()) {
        for (const name of season.translations.keys()) seen.add(name);
      }
    } else {
      for (const m of this.playerLinks.movie) seen.add(m.translation);
    }
    return [...seen].sort();
  }

  /** Sorted season numbers; empty for movies. */
  seasons(): number[] {
    if (!this.isSeries()) return [];
    return [...this.playerLinks.playlist.keys()].sort((a, b) => a - b);
  }

  /** Episodes for the given season and translation, sorted by number. */
  episodes(season: number, translation: string): Episode[] {
    return this.playerLinks.playlist.get(season)?.translations.get(translation) ?? [];
  }

  /**
   * Returns the translation matching `translation`. When it is empty, the
   * alphabetically first available translation is returned.
   *
   * @throws {TranslationNotFoundError}
   */
  pickMovie(translation = ''): Translation {
    if (this.isSeries() || this.playerLinks.movie.length === 0) {
      throw new TranslationNotFoundError();
    }
    if (translation === '') {
      const first = this.translations()[0];
      const match = this.playerLinks.movie.find((m) => m.translation === first);
      // `movie[0]` is non-null: the length check above guarantees it.
      return match ?? (this.playerLinks.movie[0] as Translation);
    }
    const found = this.playerLinks.movie.find((m) => m.translation === translation);
    if (found === undefined) throw new TranslationNotFoundError();
    return found;
  }

  /**
   * Returns the requested episode. When `translation` is empty, the
   * alphabetically first translation of that season is used.
   *
   * @throws {EpisodeNotFoundError} when the season or episode is missing.
   * @throws {TranslationNotFoundError} when the translation is missing.
   */
  pickEpisode(season: number, translation: string, episode: number): Episode {
    if (!this.isSeries()) throw new EpisodeNotFoundError();
    const s = this.playerLinks.playlist.get(season);
    if (s === undefined) throw new EpisodeNotFoundError();

    let name = translation;
    if (name === '') {
      const names = [...s.translations.keys()].sort();
      const first = names[0];
      if (first === undefined) throw new TranslationNotFoundError();
      name = first;
    }
    const episodes = s.translations.get(name);
    if (episodes === undefined) throw new TranslationNotFoundError();
    const found = episodes.find((e) => e.number === episode);
    if (found === undefined) throw new EpisodeNotFoundError();
    return found;
  }
}

/**
 * Decodes `player_links`, supporting both the movie and series shapes as well
 * as the two episode forms (array or dict), and derives `qualities` for every
 * entry from its link.
 *
 * Movie posts return `playlist` as an empty array rather than an object; that
 * is tolerated rather than treated as a schema break.
 */
export function parsePlayerLinks(raw: unknown): PlayerLinks {
  const links: PlayerLinks = { movie: [], playlist: new Map<number, Season>() };
  if (raw === undefined || raw === null) return links;
  if (!isRecord(raw)) {
    throw new DecodeError('filmix: decode player_links: value is not an object');
  }

  const movie = raw['movie'];
  if (Array.isArray(movie) && movie.length > 0) {
    for (const entry of movie) {
      if (!isRecord(entry)) continue;
      const link = looseString(entry['link']);
      const declared = intArray(entry['qualities']);
      links.movie.push({
        translation: looseString(entry['translation']),
        link,
        qualities: declared !== undefined && declared.length > 0 ? declared : (parseQualities(link) ?? []),
      });
    }
    if (links.movie.length > 0) return links;
  }

  const playlist = raw['playlist'];
  if (playlist === undefined || playlist === null) return links;
  if (Array.isArray(playlist)) {
    if (playlist.length === 0) return links;
    throw new DecodeError('filmix: decode player_links: playlist is a non-empty array');
  }
  if (!isRecord(playlist)) {
    throw new DecodeError('filmix: decode player_links: playlist is neither object nor array');
  }

  for (const [seasonKey, translations] of Object.entries(playlist)) {
    const seasonNum = Number.parseInt(seasonKey, 10);
    if (Number.isNaN(seasonNum)) continue;
    if (!isRecord(translations)) {
      throw new DecodeError(`filmix: season ${seasonKey}: translations is not an object`);
    }
    const season: Season = { translations: new Map<string, Episode[]>() };
    for (const [name, blob] of Object.entries(translations)) {
      season.translations.set(name, decodeEpisodes(blob, seasonNum, name));
    }
    links.playlist.set(seasonNum, season);
  }
  return links;
}

/**
 * Accepts either a JSON array of episodes or an object keyed by episode number,
 * and returns the episodes sorted by number ascending.
 */
function decodeEpisodes(blob: unknown, season: number, translation: string): Episode[] {
  if (Array.isArray(blob)) {
    return blob.map((entry, i) => toEpisode(entry, i + 1));
  }
  if (isRecord(blob)) {
    const out: Episode[] = [];
    for (const [key, entry] of Object.entries(blob)) {
      const n = Number.parseInt(key, 10);
      if (Number.isNaN(n)) continue;
      out.push(toEpisode(entry, n));
    }
    return out.sort((a, b) => a.number - b.number);
  }
  throw new DecodeError(
    `filmix: season ${season} / ${JSON.stringify(translation)}: episodes: not an array or object`,
  );
}

function toEpisode(entry: unknown, number: number): Episode {
  const record = isRecord(entry) ? entry : {};
  const link = looseString(record['link']);
  const declared = intArray(record['qualities']);
  return {
    number,
    link,
    qualities: declared !== undefined && declared.length > 0 ? declared : (parseQualities(link) ?? []),
  };
}
