/**
 * The website-based path to Filmix content. It needs no bound mobile device: an
 * authenticated browser session ({@link PasswordAuthenticator}) is enough.
 *
 * Pipeline:
 *
 * 1. POST `/api/movies/player-data` — returns a JSON map of translation name →
 *    `#2`-encoded payload.
 * 2. Decode the payload locally to recover the URL of a `.txt` manifest hosted
 *    on `<mirror>/pl/...`.
 * 3. GET that manifest with the same session cookies — it returns another `#2`
 *    encoded blob.
 * 4. Decode the blob into a JSON playlist: a flat list for movies, a
 *    season-grouped list for series. Each entry's `file` field contains the CDN
 *    URLs for every available quality.
 */
import type { PasswordAuthenticator } from '../auth/password.js';
import { FilmixError, HttpStatusError, NotAuthorizedError, WarmUpFailedError } from '../errors.js';
import { errMessage, readTextLimited } from '../internal/http.js';
import { decode } from './decoder.js';
import { parsePlayerDataJson, type PlayerData } from './player-data.js';
import { PlaylistFile, parseFileField, parsePlaylist, type Playlist } from './playlist.js';

/**
 * The short URL the website serves (or 301-redirects) to make the session aware
 * of a post. It accepts any post id and is the cheapest way to "visit" a post
 * page without knowing its slug.
 */
const WARM_UP_REDIRECTOR = '/play/';

export class SiteClient {
  constructor(private readonly auth: PasswordAuthenticator) {}

  /**
   * Fetches `/api/movies/player-data` for the given post id.
   *
   * The site answers player-data with HTTP 403 unless the session has "visited"
   * the canonical post page (an opaque server-side state). `pageUrl` is that
   * canonical URL; when empty, `/play/{id}` is used as a redirector. The final
   * URL after redirects becomes the `Referer` of the POST.
   *
   * When `pageUrl` points to a host other than the configured mirror, the call
   * is attempted against that host first (cookies are mirrored across hosts on
   * a best-effort basis) and retried against the configured mirror on failure.
   */
  async playerData(
    postId: number,
    pageUrl = '',
    opts: { signal?: AbortSignal } = {},
  ): Promise<PlayerData> {
    if (!this.auth.authorized()) throw new NotAuthorizedError();

    const configured = this.auth.mirror;
    const primary = mirrorFromUrl(pageUrl);
    if (primary !== undefined && primary !== configured) {
      let mirrored = true;
      try {
        this.auth.mirrorCookiesTo(primary);
      } catch {
        mirrored = false;
      }
      if (mirrored) {
        try {
          return await this.playerDataAt(postId, pageUrl, primary, opts);
        } catch {
          // Fall through to the configured mirror.
        }
      }
    }
    return await this.playerDataAt(postId, pageUrl, configured, opts);
  }

  /**
   * Runs the warm-up GET plus the player-data POST against `mirror`. `pageUrl`
   * is the warm-up target only when it shares the mirror's host; otherwise
   * warm-up falls back to `/play/{id}` on the mirror.
   */
  private async playerDataAt(
    postId: number,
    pageUrl: string,
    mirror: string,
    opts: { signal?: AbortSignal },
  ): Promise<PlayerData> {
    let warmTarget = pageUrl;
    if (warmTarget === '' || !sameHost(warmTarget, mirror)) {
      warmTarget = `${mirror}${WARM_UP_REDIRECTOR}${postId}`;
    }
    let canonicalUrl: string;
    try {
      canonicalUrl = await this.warmUp(warmTarget, opts);
    } catch (err) {
      throw new FilmixError(`warm up post page: ${errMessage(err)}`, { cause: err });
    }

    const form = new URLSearchParams({ post_id: String(postId), showfull: 'true' });
    const target = `${mirror}/api/movies/player-data?t=${Date.now()}`;

    const { res } = await this.auth.session.fetch(target, {
      method: 'POST',
      headers: {
        ...this.auth.browserHeaders(),
        Referer: canonicalUrl,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: form.toString(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new HttpStatusError(res.status, 'player-data');
    }
    const body = await readTextLimited(res, 4 * 1024 * 1024);
    return parsePlayerDataJson(body);
  }

  /**
   * Resolves a `#2`-encoded video link to a {@link Playlist}: decodes the link
   * to a manifest URL, downloads the (also `#2`-encoded) manifest, and parses
   * its JSON contents.
   *
   * Some posts — typically 4K HEVC movies — short-circuit this two-layer flow:
   * the encoded link decodes straight to a bracketed file field rather than a
   * manifest URL. In that case a single-entry movie playlist is built without a
   * second HTTP round-trip.
   */
  async fetchPlaylist(
    encodedVideoLink: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Playlist> {
    if (!this.auth.authorized()) throw new NotAuthorizedError();

    let decoded: string;
    try {
      decoded = decode(encodedVideoLink);
    } catch (err) {
      throw new FilmixError(`decode video link: ${errMessage(err)}`, { cause: err });
    }

    // Direct file-field shortcut: the decoded string is a list of
    // [quality]URL pairs, not a manifest URL. No HTTP fetch needed.
    const trimmed = decoded.trim();
    if (trimmed.startsWith('[')) {
      const qualities = parseFileField(trimmed);
      if (qualities.size === 0) {
        throw new FilmixError(
          `filmix: decoded file field has no recognised qualities: ${JSON.stringify(trimmed)}`,
        );
      }
      return { movie: new PlaylistFile({ qualities }) };
    }

    const { res } = await this.auth.session.fetch(trimmed, {
      headers: { ...this.auth.browserHeaders(), Accept: '*/*' },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new HttpStatusError(res.status, 'manifest');
    }
    const body = await readTextLimited(res, 8 * 1024 * 1024);

    let rawJson: string;
    try {
      rawJson = decode(body);
    } catch (err) {
      throw new FilmixError(`decode manifest: ${errMessage(err)}`, { cause: err });
    }
    return parsePlaylist(rawJson);
  }

  /** GETs `target` so the session is primed, returning the post-redirect URL. */
  private async warmUp(target: string, opts: { signal?: AbortSignal }): Promise<string> {
    const { res, finalUrl } = await this.auth.session.fetch(target, {
      headers: this.auth.browserHeaders(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    await readTextLimited(res, 256 * 1024);
    if (res.status !== 200) {
      throw new WarmUpFailedError(`GET ${target} returned HTTP ${res.status}`);
    }
    return finalUrl;
  }
}

/**
 * Returns `scheme://host` for a parseable absolute URL, or undefined when
 * `rawUrl` is empty, unparseable, or missing a scheme or host.
 *
 * Host filtering is enforced elsewhere: the CLI rejects URLs whose host does
 * not contain "filmix" before they ever reach here, and
 * `mirrorCookiesTo` throws {@link ForeignMirrorHostError} as a backstop.
 */
export function mirrorFromUrl(rawUrl: string): string | undefined {
  if (rawUrl === '') return undefined;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (u.protocol === '' || u.host === '') return undefined;
  return `${u.protocol}//${u.host}`;
}

/** Reports whether `rawUrl` and `mirror` share the same host. */
export function sameHost(rawUrl: string, mirror: string): boolean {
  try {
    const a = new URL(rawUrl);
    const b = new URL(mirror);
    return a.host !== '' && a.host === b.host;
  } catch {
    return false;
  }
}
