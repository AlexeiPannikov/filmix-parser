/**
 * The user-facing facade over four layers:
 *
 * - **models** — data types returned by the API plus helpers for working with
 *   them (`Post`, `Translation`, `Episode`, `Plan`, `parseQualities`,
 *   `applyQuality`).
 * - **client** — low-level HTTP client for `/api/v2/*`, host discovery and
 *   livehash refresh (the "mobile API" path).
 * - **auth** — password-based and device-token authentication flows.
 * - **site** — website-session path that goes through
 *   `/api/movies/player-data`, decodes the obfuscated `#2` payloads, and
 *   resolves direct CDN URLs. This is the preferred path: `resolveLinks` tries
 *   it first whenever `loginByPassword` has been called.
 *
 * This fork resolves metadata and direct CDN links only — transferring media
 * files is out of scope, so there is no downloader.
 *
 * ```ts
 * const client = new Client({ logger: consoleLogger('info') });
 * const results = await client.search('Inception');
 * const post = await client.getPost(results[0]!.id);
 * const links = await client.resolveLinks({ post });
 * for (const t of links.translations) {
 *   console.log(t.translation, [...t.urls]);
 * }
 * ```
 *
 * With a website session (`loginByPassword`) the links come from the decoded
 * `#2` manifests; otherwise they are derived from the mobile API's
 * `player_links` templates.
 */
import { Authenticator, type PendingAuth } from './auth/device-token.js';
import { PasswordAuthenticator } from './auth/password.js';
import type { State } from './auth/store.js';
import { ApiClient, type CallOptions } from './client/api.js';
import { DEFAULT_API_FALLBACKS, discover } from './client/discover.js';
import { LivehashCache } from './client/livehash.js';
import {
  CannotDecodeError,
  ContentLockedError,
  EpisodeNotFoundError,
  FilmixError,
  PlayerDataEmptyError,
  isErrorOfType,
} from './errors.js';
import { generateDeviceId } from './internal/device-id.js';
import { HttpClient, errMessage } from './internal/http.js';
import type { Logger } from './logger.js';
import { Plan, applyQuality } from './models/quality.js';
import type { Post } from './models/post.js';
import type { Profile } from './models/profile.js';
import type { SearchResult } from './models/search.js';
import { resolveOptions, type ClientOptions, type ResolvedOptions } from './options.js';
import { SiteClient } from './site/client.js';
import type { Playlist, PlaylistFile } from './site/playlist.js';

/**
 * Which season/episode of a {@link Post} to resolve links for.
 *
 * For movies the season/episode fields are ignored. For series they default to
 * S1E1, because one manifest entry is one episode.
 */
export interface ResolveRequest {
  post: Post;
  /** Limit the result to a single translation instead of every available one. */
  translation?: string;
  season?: number;
  episode?: number;
  /**
   * Canonical filmix.my page URL of the post, used by the website path to warm
   * up server state before fetching player-data. Optional — when empty,
   * `/play/{post.id}` is used as a redirector.
   */
  sourceUrl?: string;
  signal?: AbortSignal;
}

/** Direct CDN URLs for one translation, keyed by pixel height. */
export interface ResolvedTranslation {
  translation: string;
  urls: Map<number, string>;
}

/** The outcome of {@link Client.resolveLinks}. */
export interface ResolvedLinks {
  /**
   * `site` when the URLs were decoded from the website manifests, `mobile`
   * when they were derived from the API's `player_links` templates.
   */
  source: 'site' | 'mobile';
  translations: ResolvedTranslation[];
}

/** The user-facing entry point. */
export class Client {
  private readonly opts: ResolvedOptions;
  private readonly http: HttpClient;
  private readonly api: ApiClient;
  private readonly authn: Authenticator;
  private readonly livehash: LivehashCache | undefined;
  private readonly log: Logger;

  private bootstrapPromise: Promise<void> | undefined;
  private plan: Plan = Plan.Guest;

  /** Website path (set by {@link loginByPassword} or restored on bootstrap). */
  private passwordAuth: PasswordAuthenticator | undefined;
  private site: SiteClient | undefined;

  constructor(options: ClientOptions = {}) {
    this.opts = resolveOptions(options);
    this.log = this.opts.logger;
    this.http = new HttpClient({
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      timeoutMs: this.opts.timeoutMs,
    });
    this.api = new ApiClient({
      http: this.http,
      logger: this.log,
      device: this.opts.device,
      apiBase: this.opts.apiBase,
    });
    this.authn = new Authenticator(this.api, this.opts.tokenStore, this.opts.mirror);
    this.livehash = this.opts.livehash ? new LivehashCache(this.api) : undefined;
  }

  /**
   * One-time setup: loads cached credentials, runs host discovery when needed,
   * pre-populates the API client, and restores a persisted website session.
   * Safe to call repeatedly — only the first invocation does work, and its
   * outcome (including failure) is cached, matching the Go `sync.Once`.
   */
  private ensureBootstrap(opts: CallOptions = {}): Promise<void> {
    this.bootstrapPromise ??= this.bootstrap(opts);
    return this.bootstrapPromise;
  }

  private async bootstrap(opts: CallOptions): Promise<void> {
    let state: State;
    try {
      state = await this.opts.tokenStore.load();
    } catch (err) {
      throw new FilmixError(`token store load: ${errMessage(err)}`, { cause: err });
    }

    if (state.deviceId === '') state.deviceId = generateDeviceId();
    this.api.setCredentials(state.deviceId, state.token);

    if (this.opts.apiBase === '') {
      let base = state.apiBase;
      if (base === '') {
        const candidates =
          this.opts.apiFallbacks.length > 0 ? this.opts.apiFallbacks : DEFAULT_API_FALLBACKS;
        base = await discover(this.http, this.opts.device, candidates, opts);
      }
      this.api.setApiBase(base);
      state.apiBase = base;
    } else {
      this.api.setApiBase(this.opts.apiBase);
      state.apiBase = this.opts.apiBase;
    }

    try {
      await this.opts.tokenStore.save(state);
    } catch (err) {
      throw new FilmixError(`token store save: ${errMessage(err)}`, { cause: err });
    }

    // Restore a previously persisted website session, if any. Failure here is
    // non-fatal — the user simply needs to re-login.
    if (state.siteSession !== undefined && state.siteSession.cookies.length > 0) {
      try {
        const pa = new PasswordAuthenticator({
          http: this.http,
          mirror: this.opts.mirror,
          logger: this.log,
        });
        pa.restore(state.siteSession);
        this.passwordAuth = pa;
        this.site = new SiteClient(pa);
      } catch (err) {
        this.log.debug('filmix.site_session_restore_failed', { err });
      }
    }
  }

  /**
   * Begins the device-token flow. The returned {@link PendingAuth} holds the
   * `userCode` the user must enter on the activation page
   * (`pending.activationUrl`). Call {@link waitForActivation} to block until
   * the user activates the code.
   *
   * Calling this when a token is already cached issues a fresh `token_request`,
   * replacing the previous one once activated.
   */
  async authenticate(opts: CallOptions = {}): Promise<PendingAuth> {
    await this.ensureBootstrap(opts);
    return await this.authn.requestCode(opts);
  }

  /**
   * Blocks until the user has activated the `userCode`. The poll interval is
   * clamped to a sane minimum (2 s).
   */
  async waitForActivation(
    pending: PendingAuth,
    pollMs: number,
    opts: CallOptions = {},
  ): Promise<void> {
    if (pending === null || typeof pending !== 'object') {
      throw new FilmixError('filmix: PendingAuth is required');
    }
    await this.authn.waitForActivation(pending, pollMs, opts);
    // Refresh the cached profile (and therefore the plan) after activation.
    try {
      await this.refreshProfile(opts);
    } catch (err) {
      this.log.warn('filmix.profile_refresh_failed', { err });
    }
  }

  /** Calls `/api/v2/search` with the given free-text query. */
  async search(query: string, opts: CallOptions = {}): Promise<SearchResult[]> {
    await this.ensureBootstrap(opts);
    return await this.api.search(query, opts);
  }

  /** Fetches `/api/v2/post/{id}` and returns the parsed metadata. */
  async getPost(id: number, opts: CallOptions = {}): Promise<Post> {
    await this.ensureBootstrap(opts);
    return await this.api.getPost(id, opts);
  }

  /** Fetches `/api/v2/user_profile` and updates the cached subscription tier. */
  async profile(opts: CallOptions = {}): Promise<Profile> {
    await this.ensureBootstrap(opts);
    return await this.refreshProfile(opts);
  }

  private async refreshProfile(opts: CallOptions): Promise<Profile> {
    const profile = await this.api.profile(opts);
    this.plan = profile.plan();
    return profile;
  }

  /**
   * The cached subscription tier. `Plan.Guest` until `profile()` or the device
   * flow has run.
   */
  currentPlan(): Plan {
    return this.plan;
  }

  /**
   * The configured website host (e.g. `https://filmix.my`). Useful for building
   * page URLs from search results.
   */
  get mirror(): string {
    return this.opts.mirror;
  }

  /**
   * Establishes a website session from a username/password instead of the
   * device-token flow. Useful when the user has already hit the device-binding
   * limit (2 free / 3 Pro+) and cannot register a new device.
   *
   * After a successful login, {@link resolveLinks} prefers the site path, whose
   * URLs are decoded from the `#2` manifests rather than derived from the
   * mobile API's templates.
   */
  async loginByPassword(username: string, password: string, opts: CallOptions = {}): Promise<void> {
    await this.ensureBootstrap(opts);
    const pa = new PasswordAuthenticator({
      http: this.http,
      mirror: this.opts.mirror,
      logger: this.log,
    });
    await pa.login(username, password, opts);

    // Persist the site session so subsequent processes skip the login.
    try {
      const state = await this.opts.tokenStore.load();
      state.siteSession = pa.snapshot();
      await this.opts.tokenStore.save(state);
    } catch (err) {
      this.log.warn('filmix.site_session_save_failed', { err });
    }

    this.passwordAuth = pa;
    this.site = new SiteClient(pa);
  }

  /**
   * The website-session client, or undefined when {@link loginByPassword} has
   * not been called (and no session was restored). Exposed mainly for advanced
   * callers and tests.
   */
  siteClient(): SiteClient | undefined {
    return this.site;
  }

  /** The website authenticator backing {@link siteClient}, when present. */
  siteAuth(): PasswordAuthenticator | undefined {
    return this.passwordAuth;
  }

  /**
   * Resolves direct CDN URLs for every quality of every translation.
   *
   * Resolution priority:
   *
   * 1. When a website session is present, the site-based path is used: POST
   *    `/api/movies/player-data` → decode the `#2` link → fetch the `.txt`
   *    manifest → decode → direct CDN URLs per quality. A translation whose
   *    manifest cannot be fetched or decoded is skipped (and logged).
   * 2. Otherwise, or when the site path yields nothing, the URLs are derived
   *    from the mobile API's `player_links`: the quality is substituted into
   *    the embedded template (`_[1080,720,480].mp4` or `_%s.mp4`).
   *
   * No quality cap is applied — every advertised quality is returned, and the
   * caller decides what to do with it. Note that on the mobile path without a
   * device token the CDN serves short previews above ~480p.
   *
   * @throws {ContentLockedError} when player-data reports a rights-holder
   * takedown; that verdict is authoritative, so no fallback is attempted.
   */
  async resolveLinks(req: ResolveRequest): Promise<ResolvedLinks> {
    // Guard the trust boundary: JavaScript callers get a clear error instead of
    // a TypeError deep inside the resolver.
    if (req === null || typeof req !== 'object' || typeof req.post?.id !== 'number') {
      throw new FilmixError('filmix: ResolveRequest.post is required');
    }
    const callOpts: CallOptions = req.signal ? { signal: req.signal } : {};
    await this.ensureBootstrap(callOpts);

    const site = this.site;
    if (site !== undefined) {
      try {
        const translations = await this.resolveSiteLinks(site, req);
        if (translations.length > 0) return { source: 'site', translations };
        this.log.warn('filmix.site_path_empty', {
          hint: 'no translation yielded a usable manifest; falling back to the mobile API',
        });
      } catch (err) {
        if (isErrorOfType(err, ContentLockedError)) throw err;
        if (isErrorOfType(err, PlayerDataEmptyError)) {
          this.log.warn('filmix.site_path_empty', {
            hint: "player-data returned no translations — site session may have expired; re-run 'filmix login --user X --password Y'",
          });
        } else if (isErrorOfType(err, CannotDecodeError)) {
          this.log.warn('filmix.site_decoder_outdated', {
            hint: 'garbage chunks in #2 format changed — site/decoder.ts needs updating',
          });
        } else {
          this.log.warn('filmix.site_path_failed', { err });
        }
      }
    }

    return { source: 'mobile', translations: await this.resolveMobileLinks(req) };
  }

  /**
   * Website path: player-data → per-translation manifest → direct CDN URLs.
   * Translations that fail are skipped so one broken dub cannot hide the rest.
   */
  private async resolveSiteLinks(
    site: SiteClient,
    req: ResolveRequest,
  ): Promise<ResolvedTranslation[]> {
    const callOpts = req.signal ? { signal: req.signal } : {};
    const pd = await site.playerData(req.post.id, req.sourceUrl ?? '', callOpts);

    const candidates =
      req.translation !== undefined && req.translation !== ''
        ? [req.translation]
        : [...pd.video.keys()].sort();

    const out: ResolvedTranslation[] = [];
    for (const name of candidates) {
      const encoded = pd.video.get(name);
      if (encoded === undefined || encoded === '') continue;

      let playlist: Playlist;
      try {
        playlist = await site.fetchPlaylist(encoded, callOpts);
      } catch (err) {
        this.log.debug('filmix.site_translation_skip', {
          translation: name,
          reason: 'fetch_playlist',
          err,
        });
        continue;
      }

      let file: PlaylistFile;
      try {
        file = pickPlaylistFile(playlist, req);
      } catch (err) {
        this.log.debug('filmix.site_translation_skip', {
          translation: name,
          reason: 'pick_file',
          err,
        });
        continue;
      }
      if (file.qualities.size === 0) {
        this.log.debug('filmix.site_translation_skip', { translation: name, reason: 'no_qualities' });
        continue;
      }
      out.push({ translation: name, urls: await this.withLivehash(file.qualities, callOpts) });
    }
    return out;
  }

  /** Mobile path: substitute each advertised quality into the link template. */
  private async resolveMobileLinks(req: ResolveRequest): Promise<ResolvedTranslation[]> {
    const post = req.post;
    const names =
      req.translation !== undefined && req.translation !== ''
        ? [req.translation]
        : post.translations();
    const explicit = names.length === 1 && req.translation !== undefined && req.translation !== '';
    const callOpts = req.signal ? { signal: req.signal } : {};

    const out: ResolvedTranslation[] = [];
    for (const name of names) {
      let link: string;
      let qualities: readonly number[];
      try {
        if (post.isSeries()) {
          const episode = post.pickEpisode(req.season ?? 1, name, req.episode ?? 1);
          link = episode.link;
          qualities = episode.qualities;
        } else {
          const movie = post.pickMovie(name);
          link = movie.link;
          qualities = movie.qualities;
        }
      } catch (err) {
        // A dub may simply not carry the requested season/episode.
        if (explicit) throw err;
        this.log.debug('filmix.mobile_translation_skip', { translation: name, err });
        continue;
      }
      if (link === '' || qualities.length === 0) continue;

      const urls = new Map<number, string>();
      for (const quality of qualities) urls.set(quality, applyQuality(link, quality));
      out.push({ translation: name, urls: await this.withLivehash(urls, callOpts) });
    }
    return out;
  }

  /** Rewrites the `/s/{hash}/` prefix of each URL when livehash is enabled. */
  private async withLivehash(
    urls: ReadonlyMap<number, string>,
    opts: CallOptions,
  ): Promise<Map<number, string>> {
    const livehash = this.livehash;
    if (livehash === undefined) return new Map(urls);
    const out = new Map<number, string>();
    for (const [quality, url] of urls) {
      out.set(quality, await livehash.applyToUrl(url, opts));
    }
    return out;
  }
}

/** Selects the manifest entry for the requested season/episode. */
export function pickPlaylistFile(playlist: Playlist, req: ResolveRequest): PlaylistFile {
  if (playlist.movie !== undefined) return playlist.movie;
  const season = req.season ?? 1;
  const episodes = playlist.seasons?.get(season);
  if (episodes === undefined || episodes.length === 0) {
    throw new EpisodeNotFoundError(`filmix: episode not found: season ${season}`);
  }
  // Episode numbers are 1-based and match the order in the manifest.
  const idx = (req.episode ?? 1) - 1;
  const file = idx >= 0 ? episodes[idx] : undefined;
  if (file === undefined) {
    throw new EpisodeNotFoundError(
      `filmix: episode not found: episode ${req.episode ?? 1} (have ${episodes.length} episodes in season ${season})`,
    );
  }
  return file;
}
