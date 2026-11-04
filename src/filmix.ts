/**
 * The user-facing facade over five layers:
 *
 * - **models** — data types returned by the API plus helpers for working with
 *   them (`Post`, `Translation`, `Episode`, `Plan`, `parseQualities`,
 *   `applyQuality`).
 * - **client** — low-level HTTP client for `/api/v2/*`, host discovery and
 *   livehash refresh (the "mobile API" path).
 * - **auth** — password-based and device-token authentication flows.
 * - **site** — website-session path that goes through
 *   `/api/movies/player-data`, decodes the obfuscated `#2` payloads, and
 *   resolves direct CDN URLs. This is the preferred path: `download` tries it
 *   first whenever `loginByPassword` has been called.
 * - **download** — streams MP4 files to disk with resume and progress.
 *
 * Typical use with password authentication (recommended):
 *
 * ```ts
 * const c = new Client({ logger: consoleLogger('info') });
 * await c.loginByPassword('user', 'pass');
 * const results = await c.search('Inception');
 * const post = await c.getPost(results[0].id);
 * await c.download({ post, destination: '/tmp/' }); // trailing slash → CDN filename inside dir
 * ```
 *
 * Device-token flow (useful when password login is not desired):
 *
 * ```ts
 * const pending = await c.authenticate();   // show pending.userCode to the user
 * await c.waitForActivation(pending, 5000);
 * ```
 */
import path from 'node:path';

import { Authenticator, type PendingAuth } from './auth/device-token.js';
import { PasswordAuthenticator } from './auth/password.js';
import type { State } from './auth/store.js';
import { ApiClient, type CallOptions } from './client/api.js';
import { DEFAULT_API_FALLBACKS, discover } from './client/discover.js';
import { LivehashCache } from './client/livehash.js';
import { Downloader, type ProgressFunc } from './download/downloader.js';
import {
  CannotDecodeError,
  ContentLockedError,
  FilmixError,
  PlayerDataEmptyError,
  QualityUnavailableError,
  TranslationNotFoundError,
  EpisodeNotFoundError,
  isErrorOfType,
} from './errors.js';
import { generateDeviceId } from './internal/device-id.js';
import { HttpClient, errMessage } from './internal/http.js';
import type { Logger } from './logger.js';
import { Plan, maxQualityFor, pickBest, applyQuality } from './models/quality.js';
import type { Post } from './models/post.js';
import type { Profile } from './models/profile.js';
import type { SearchResult } from './models/search.js';
import { resolveOptions, type ClientOptions, type ResolvedOptions } from './options.js';
import { SiteClient } from './site/client.js';
import type { Playlist, PlaylistFile } from './site/playlist.js';

/**
 * Describes a single download from a {@link Post}.
 *
 * For movies: set `translation`, or leave it empty for the first available one.
 * For series: set `season`, `episode` and optionally `translation`.
 * `quality: 0` (the default) selects the highest quality within the plan cap.
 */
export interface DownloadRequest {
  post: Post;
  translation?: string;
  season?: number;
  episode?: number;
  quality?: number;
  destination?: string;
  progress?: ProgressFunc;
  /**
   * Canonical filmix.my page URL of the post, used by the website path to warm
   * up server state before fetching player-data. Optional — when empty,
   * `/play/{post.id}` is used as a redirector.
   */
  sourceUrl?: string;
  signal?: AbortSignal;
}

/** The user-facing entry point. */
export class Client {
  private readonly opts: ResolvedOptions;
  private readonly http: HttpClient;
  private readonly api: ApiClient;
  private readonly authn: Authenticator;
  private readonly livehash: LivehashCache | undefined;
  private readonly dl: Downloader;
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
    this.dl = new Downloader(this.http, this.log);
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
   * After a successful login, {@link download} attempts the site-based path
   * first (POST player-data → fetch & decode manifest → CDN URL). If the site
   * path fails, the call falls back to the mobile-API path with a guest quality
   * cap of 480p.
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
   * Resolves the URL described by `req` and streams it to disk.
   *
   * Resolution priority:
   *
   * 1. When a website session is present, the site-based path is attempted
   *    first: POST `/api/movies/player-data` → fetch the `.txt` manifest →
   *    parse direct CDN URLs for each quality.
   * 2. Otherwise, or if the site path fails, the mobile-API path is used: pick
   *    the translation/episode from `req.post`, substitute the requested
   *    quality, optionally apply the livehash.
   */
  async download(req: DownloadRequest): Promise<void> {
    // Guard the trust boundary: JavaScript callers get a clear error instead of
    // a TypeError deep inside the resolver.
    if (req === null || typeof req !== 'object' || typeof req.post?.id !== 'number') {
      throw new FilmixError('filmix: DownloadRequest.post is required');
    }
    const callOpts: CallOptions = req.signal ? { signal: req.signal } : {};
    await this.ensureBootstrap(callOpts);

    let siteFailed = false;
    const site = this.site;
    if (site !== undefined) {
      try {
        const picked = await this.resolveSiteUrl(site, req);
        const dst = deriveDestination(picked.url, req.destination ?? '');
        this.log.info('filmix.download.start', {
          url: picked.url,
          dest: dst,
          quality: picked.quality,
          translation: picked.translation,
          source: 'site',
        });
        await this.dl.do({
          url: picked.url,
          destination: dst,
          quality: picked.quality,
          variant: translationKey(picked.translation),
          ...(req.progress ? { progress: req.progress } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        });
        return;
      } catch (err) {
        siteFailed = true;
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

    const { link, qualities } = pickLink(req);

    const cap = this.qualityCap(true, siteFailed);
    let quality = req.quality ?? 0;
    if (quality === 0) {
      quality = pickBest(qualities, cap);
    } else if (quality > cap) {
      this.log.info('filmix.quality_override', { requested: quality, cap });
    }

    let finalUrl = applyQuality(link, quality);
    if (this.livehash !== undefined) {
      finalUrl = await this.livehash.applyToUrl(finalUrl, callOpts);
    }

    const dst = deriveDestination(finalUrl, req.destination ?? '');
    let chosenTranslation = req.translation ?? '';
    if (chosenTranslation === '') {
      chosenTranslation = req.post.translations()[0] ?? '';
    }
    this.log.info('filmix.download.start', {
      url: finalUrl,
      dest: dst,
      quality,
      translation: chosenTranslation,
      source: 'mobile',
    });
    await this.dl.do({
      url: finalUrl,
      destination: dst,
      quality,
      variant: translationKey(chosenTranslation),
      ...(req.progress ? { progress: req.progress } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  }

  /**
   * The quality-cap policy, kept in one place for both callers.
   *
   * - Site path: always 720p (Free tier). The site endpoint serves 1080p+ only
   *   to Pro accounts; pinning to 720p keeps the policy stable for the common
   *   Free user. Callers wanting more must pass `quality` explicitly.
   * - Mobile path after a site failure: 480p (guest) — without a device token
   *   the CDN hands out short previews for higher qualities, and a full 480p
   *   episode beats a 10-second 1080p teaser.
   * - Mobile path with no site involvement: the cached profile plan.
   */
  private qualityCap(mobilePath: boolean, siteFailed: boolean): number {
    if (!mobilePath) return maxQualityFor(Plan.Free);
    if (siteFailed) return maxQualityFor(Plan.Guest);
    return maxQualityFor(this.plan);
  }

  /**
   * Fetches player-data, picks a translation, downloads the playlist manifest,
   * and selects the URL for the requested season/episode and quality.
   *
   * When `req.translation` is empty, translations are tried alphabetically and
   * one whose manifest offers no quality fitting the Free cap (e.g. a "HEVC 4K"
   * dub on a Free account) is skipped in favour of the next. Some posts list a
   * 4K-only HEVC variant first alphabetically but also carry a
   * standard-quality dub later; this falls back to the latter automatically.
   * An explicit `req.translation` disables the loop — the caller's pin wins.
   */
  private async resolveSiteUrl(
    site: SiteClient,
    req: DownloadRequest,
  ): Promise<{ url: string; quality: number; translation: string }> {
    const callOpts = req.signal ? { signal: req.signal } : {};
    const pd = await site.playerData(req.post.id, req.sourceUrl ?? '', callOpts);

    let candidates: string[];
    if (req.translation !== undefined && req.translation !== '') {
      if (!pd.video.has(req.translation)) {
        throw new TranslationNotFoundError(
          `filmix: translation not found: translation ${JSON.stringify(req.translation)} not in site player-data`,
        );
      }
      candidates = [req.translation];
    } else {
      candidates = [...pd.video.keys()].sort();
    }

    const cap = this.qualityCap(false, false);
    let lastErr: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const name = candidates[i] as string;
      const encoded = pd.video.get(name);
      if (encoded === undefined || encoded === '') continue;

      let playlist: Playlist;
      try {
        playlist = await site.fetchPlaylist(encoded, callOpts);
      } catch (err) {
        lastErr = new FilmixError(`fetch site playlist: ${errMessage(err)}`, { cause: err });
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
        lastErr = err;
        this.log.debug('filmix.site_translation_skip', {
          translation: name,
          reason: 'pick_file',
          err,
        });
        continue;
      }

      let quality = req.quality ?? 0;
      if (quality === 0) {
        try {
          quality = pickBest(file.availableQualities(), cap);
        } catch (err) {
          lastErr = new QualityUnavailableError(
            `translation ${JSON.stringify(name)}: filmix: requested quality not available`,
            { cause: err },
          );
          this.log.debug('filmix.site_translation_skip', {
            translation: name,
            reason: 'no_fitting_quality',
            available: file.availableQualities(),
            cap,
          });
          continue;
        }
      }
      const url = file.qualities.get(quality);
      if (url === undefined) {
        lastErr = new QualityUnavailableError(
          `filmix: quality ${quality} not in site manifest (available: ${file.availableQualities().join(',')})`,
        );
        this.log.debug('filmix.site_translation_skip', {
          translation: name,
          reason: 'quality_missing',
          q: quality,
          available: file.availableQualities(),
        });
        continue;
      }
      if (i > 0) {
        this.log.info('filmix.site_translation_fallback', {
          picked: name,
          skipped: candidates.slice(0, i),
        });
      }
      return { url, quality, translation: name };
    }

    if (lastErr !== undefined) {
      if (lastErr instanceof Error) throw lastErr;
      throw new FilmixError('filmix: site path failed', { cause: lastErr });
    }
    throw new FilmixError('filmix: no usable translation in site player-data');
  }
}

/** Selects the manifest entry for the requested season/episode. */
export function pickPlaylistFile(playlist: Playlist, req: DownloadRequest): PlaylistFile {
  if (playlist.movie !== undefined) return playlist.movie;
  const season = req.season ?? 0;
  const episodes = playlist.seasons?.get(season);
  if (episodes === undefined || episodes.length === 0) {
    throw new EpisodeNotFoundError(`filmix: episode not found: season ${season}`);
  }
  // Episode numbers are 1-based and match the order in the manifest.
  const idx = (req.episode ?? 0) - 1;
  const file = idx >= 0 ? episodes[idx] : undefined;
  if (file === undefined) {
    throw new EpisodeNotFoundError(
      `filmix: episode not found: episode ${req.episode ?? 0} (have ${episodes.length} episodes in season ${season})`,
    );
  }
  return file;
}

/**
 * Resolves a {@link Post} plus selectors into a raw URL with embedded qualities
 * and the parsed quality list.
 */
export function pickLink(req: DownloadRequest): { link: string; qualities: number[] } {
  const post = req.post;
  if (post.isSeries()) {
    const ep = post.pickEpisode(req.season ?? 0, req.translation ?? '', req.episode ?? 0);
    return { link: ep.link, qualities: ep.qualities };
  }
  const tr = post.pickMovie(req.translation ?? '');
  return { link: tr.link, qualities: tr.qualities };
}

/**
 * Returns a filesystem-safe short discriminator derived from a translation
 * name, used as the `variant` suffix of partial files so the same translation
 * produces the same partial across runs regardless of alphabetical position or
 * server-side reordering.
 *
 * Letters and digits are kept (Unicode-aware), other characters dropped, and
 * the result bounded to 16 code points — not bytes, so Cyrillic and CJK retain
 * their character count. Empty input yields an empty string.
 */
export function translationKey(name: string): string {
  if (name === '') return '';
  const maxChars = 16;
  let out = '';
  for (const ch of name) {
    if (out.length >= maxChars) break;
    if (/[\p{L}\p{N}]/u.test(ch)) out += ch;
  }
  return out;
}

/**
 * Resolves the on-disk path the downloader writes to, given a CDN URL and the
 * caller's destination hint:
 *
 * - empty hint → URL basename in the current working directory;
 * - hint ending in `/` or the platform separator → URL basename in that dir;
 * - any other hint → used verbatim.
 *
 * The URL basename is taken from the URL's path component, so query strings and
 * signed-URL prefixes are ignored.
 */
export function deriveDestination(rawUrl: string, hint: string): string {
  const asDir = hint === '' || hint.endsWith('/') || hint.endsWith(path.sep);
  if (!asDir) return hint;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new FilmixError(`filmix: parse URL for filename: ${errMessage(err)}`, { cause: err });
  }
  const base = path.posix.basename(parsed.pathname);
  if (base === '' || base === '.' || base === '/') {
    throw new FilmixError(`filmix: cannot derive filename from URL ${JSON.stringify(rawUrl)}`);
  }
  if (hint === '') return base;
  return path.join(hint, base);
}
