import type { ApiClient, CallOptions } from './api.js';
import { doRaw } from '../internal/http.js';
import { signalInit } from './api.js';

/**
 * Hardcoded post used by the Lampac engine to fetch the current livehash: the
 * `/s/{hash}/` segment of its URL is the prefix the CDN expects for premium
 * streams.
 */
const REFERENCE_POST_ID = 171042;

/** How long a fetched hash is reused before refresh. */
const LIVEHASH_TTL_MS = 2 * 60 * 60 * 1000;

/** Captures the `/s/{hash}/` segment in CDN URLs. */
const LIVEHASH_RE = /\/s\/[^/]+\//;

/**
 * Fetches and caches the active CDN livehash.
 *
 * Concurrent callers share one in-flight request, the single-threaded
 * equivalent of the Go version's double-checked mutex.
 */
export class LivehashCache {
  private hash = '';
  private expiresAt = 0;
  private inFlight: Promise<string> | undefined;

  constructor(private readonly api: ApiClient) {}

  /**
   * Returns the active livehash, refreshing when the cached value is empty or
   * stale. An empty string is returned (without throwing) when the API
   * response carried no `/s/{hash}/` segment.
   */
  async get(opts: CallOptions = {}): Promise<string> {
    if (this.hash !== '' && Date.now() < this.expiresAt) return this.hash;
    if (this.inFlight !== undefined) return await this.inFlight;

    this.inFlight = this.fetchHash(opts)
      .then((hash) => {
        this.hash = hash;
        this.expiresAt = Date.now() + LIVEHASH_TTL_MS;
        return hash;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return await this.inFlight;
  }

  /**
   * Replaces the `/s/{hash}/` segment of `url` with the cached hash. The URL is
   * returned unchanged when it has no hash segment or the fetch fails.
   */
  async applyToUrl(url: string, opts: CallOptions = {}): Promise<string> {
    if (!LIVEHASH_RE.test(url)) return url;
    let hash: string;
    try {
      hash = await this.get(opts);
    } catch {
      return url;
    }
    if (hash === '') return url;
    return url.replace(LIVEHASH_RE, `/s/${hash}/`);
  }

  /** Hits the reference post and extracts its `/s/{hash}/` segment. */
  private async fetchHash(opts: CallOptions): Promise<string> {
    const url = this.api.url(`post/${REFERENCE_POST_ID}`);
    const body = await doRaw(this.api.http, this.api.logger, url, { ...signalInit(opts) });
    const m = LIVEHASH_RE.exec(body);
    if (m === null) return '';
    // "/s/abc123/" -> "abc123"
    return m[0].slice('/s/'.length, -1);
  }
}
