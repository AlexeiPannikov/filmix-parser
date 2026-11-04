import { isRecord, looseInt, looseString } from './json.js';
import { trimRight } from '../internal/http.js';
import { DecodeError } from '../errors.js';

/** A single entry returned by `/api/v2/search`. */
export class SearchResult {
  readonly id: number;
  readonly title: string;
  readonly origTitle: string;
  readonly year: number;
  readonly section: number;
  readonly altName: string;

  constructor(init: {
    id: number;
    title: string;
    origTitle: string;
    year: number;
    section: number;
    altName: string;
  }) {
    this.id = init.id;
    this.title = init.title;
    this.origTitle = init.origTitle;
    this.year = init.year;
    this.section = init.section;
    this.altName = init.altName;
  }

  static fromJson(raw: unknown): SearchResult {
    if (!isRecord(raw)) {
      throw new DecodeError('filmix: decode search result: entry is not an object');
    }
    return new SearchResult({
      id: looseInt(raw['id']),
      title: looseString(raw['title']),
      origTitle: looseString(raw['original_title']),
      year: looseInt(raw['year']),
      section: looseInt(raw['section']),
      altName: looseString(raw['alt_name']),
    });
  }

  /** Parses the `/api/v2/search` array payload. */
  static listFromJson(raw: unknown): SearchResult[] {
    if (!Array.isArray(raw)) {
      throw new DecodeError('filmix: decode search: payload is not an array');
    }
    return raw.map((entry) => SearchResult.fromJson(entry));
  }

  /**
   * Reports whether the entry is a multi-episode series. Section 7 is the
   * canonical "series" code; everything else is treated as a movie.
   */
  isSeries(): boolean {
    return this.section === 7;
  }

  /**
   * Builds a Filmix page URL on the given mirror host. The site resolves the
   * (type, id, slug) triple to the canonical genre-prefixed URL itself, so
   * callers do not need to know the exact category.
   *
   * Returns an empty string when the result lacks `altName`.
   */
  pageUrl(mirror: string): string {
    if (this.altName === '') return '';
    const kind = this.isSeries() ? 'seria' : 'film';
    return `${trimRight(mirror, '/')}/${kind}/${this.id}-${this.altName}.html`;
  }
}
