/**
 * Password-based authentication against the Filmix **website** (not the mobile
 * API). After a successful {@link PasswordAuthenticator.login} the same
 * instance authorises site endpoints such as `/api/movies/player-data` via its
 * cookie jar.
 */
import { CookieSession, CookieJar } from '../internal/cookies.js';
import { HttpClient, readTextLimited, trimRight } from '../internal/http.js';
import { discardLogger, type Logger } from '../logger.js';
import { ForeignMirrorHostError, InvalidCredentialsError, FilmixError } from '../errors.js';
import type { SiteSession } from './store.js';

export const DEFAULT_MIRROR = 'https://filmix.gg';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

export interface PasswordAuthenticatorOptions {
  http?: HttpClient;
  /** Site host, e.g. `https://filmix.gg`. Independent of the mobile API host. */
  mirror?: string;
  logger?: Logger;
}

export class PasswordAuthenticator {
  /** Cookie-aware session; the site client reuses it for its own requests. */
  readonly session: CookieSession;
  readonly mirror: string;
  private readonly log: Logger;
  private authorizedFlag = false;

  constructor(opts: PasswordAuthenticatorOptions = {}) {
    const http = opts.http ?? new HttpClient();
    this.session = new CookieSession(http, new CookieJar());
    this.mirror = trimRight(opts.mirror && opts.mirror !== '' ? opts.mirror : DEFAULT_MIRROR, '/');
    this.log = opts.logger ?? discardLogger;
  }

  /**
   * Posts the credentials to `/engine/ajax/user_auth.php`. The endpoint returns
   * the literal string `AUTHORIZED` on success, otherwise a localised error
   * message; the session itself is bound server-side to the `minotaurs`/
   * `x-a-key` cookies set during the priming GET, so Set-Cookie is not checked.
   *
   * @throws {InvalidCredentialsError}
   */
  async login(username: string, password: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.priming(opts);
    } catch (err) {
      this.log.debug('filmix.password.priming_failed', { err });
    }

    const form = new URLSearchParams({
      login_name: username,
      login_password: password,
      login_not_save: '1',
      login: 'submit',
    });

    const { res } = await this.session.fetch(`${this.mirror}/engine/ajax/user_auth.php`, {
      method: 'POST',
      headers: {
        ...this.browserHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const body = await readTextLimited(res, 16 * 1024);
    if (!body.includes('AUTHORIZED')) throw new InvalidCredentialsError();

    this.authorizedFlag = true;
    this.log.info('filmix.password.login_ok', { user: username });
  }

  /** Reports whether login (or restore) completed successfully. */
  authorized(): boolean {
    return this.authorizedFlag;
  }

  /**
   * Exports the current site cookies for persistence through a `TokenStore`.
   * Returns an empty session when not authorised.
   */
  snapshot(): SiteSession {
    if (!this.authorizedFlag) return { mirror: '', cookies: [] };
    return {
      mirror: this.mirror,
      cookies: this.session.jar.cookiesFor(this.mirror).map((c) => ({ ...c })),
    };
  }

  /**
   * Reinstalls cookies from a persisted session and marks the authenticator as
   * authorised. The session's mirror must match this instance's mirror.
   */
  restore(session: SiteSession): void {
    if (session.mirror === '' || trimRight(session.mirror, '/') !== this.mirror) {
      throw new FilmixError('filmix: site session mirror mismatch');
    }
    if (session.cookies.length === 0) {
      throw new FilmixError('filmix: site session has no cookies');
    }
    this.session.jar.setCookies(this.mirror, session.cookies);
    this.authorizedFlag = true;
  }

  /**
   * Copies the session cookies from the configured mirror onto the host of
   * `targetUrl`. Filmix mirrors share backend state, so reusing the cookies
   * lets us issue authenticated requests against any mirror without a fresh
   * login. No-op when the host matches the configured mirror.
   *
   * The destination host must look like a Filmix mirror; otherwise this throws
   * {@link ForeignMirrorHostError} without touching the jar. A coarse defence,
   * but it shuts the obvious credential-leak vector when a caller passes an
   * unvalidated user URL.
   */
  mirrorCookiesTo(targetUrl: string): void {
    const dst = new URL(targetUrl);
    if (dst.host === '') throw new FilmixError('filmix: targetUrl has no host');
    const src = new URL(this.mirror);
    if (dst.host === src.host) return;
    if (!isAllowedMirrorHost(dst.host)) throw new ForeignMirrorHostError(dst.host);
    const cookies = this.session.jar.cookiesFor(this.mirror);
    if (cookies.length === 0) return;
    this.session.jar.setCookies(dst.toString(), cookies);
  }

  /**
   * Headers that make a request look like a real browser session. Callers that
   * reuse {@link session} should spread these into their own header set.
   */
  browserHeaders(): Record<string, string> {
    return {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: this.mirror,
      Referer: `${this.mirror}/`,
    };
  }

  private async priming(opts: { signal?: AbortSignal }): Promise<void> {
    const { res } = await this.session.fetch(`${this.mirror}/`, {
      headers: this.browserHeaders(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    await readTextLimited(res, 64 * 1024);
  }
}

/**
 * Reports whether `host` is plausibly a Filmix mirror. Intentionally coarse — a
 * `filmix` substring match plus a loopback allowance so that local test servers
 * can exercise the mirror path without spoofing DNS.
 */
export function isAllowedMirrorHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower.includes('filmix')) return true;
  const hostname = lower.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  if (hostname === 'localhost') return true;
  if (hostname === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}
