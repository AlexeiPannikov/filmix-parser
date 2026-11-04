/**
 * Minimal cookie jar and redirect-following session fetch.
 *
 * `fetch` does not manage cookies, so the website path (which authorises via a
 * session cookie) needs one. Go's `net/http/cookiejar` does full domain/path
 * matching; this jar is host-scoped and ignores Path, Domain, Expires and
 * Secure.
 *
 * ponytail: host-scoped jar, no path/expiry matching — the Filmix session only
 * ever sets host-wide cookies on `/`. Swap in `tough-cookie` if a flow ever
 * needs real RFC 6265 semantics.
 */
import type { HttpClient} from './http.js';
import { errMessage } from './http.js';
import { TransportError } from '../errors.js';

export interface StoredCookie {
  name: string;
  value: string;
}

export class CookieJar {
  private readonly byHost = new Map<string, Map<string, string>>();

  /** Cookies stored for the host of `url`, in insertion order. */
  cookiesFor(url: string): StoredCookie[] {
    const host = hostOf(url);
    if (host === undefined) return [];
    const jar = this.byHost.get(host);
    if (jar === undefined) return [];
    return [...jar].map(([name, value]) => ({ name, value }));
  }

  /** Stores (or replaces) cookies for the host of `url`. */
  setCookies(url: string, cookies: readonly StoredCookie[]): void {
    const host = hostOf(url);
    if (host === undefined) return;
    let jar = this.byHost.get(host);
    if (jar === undefined) {
      jar = new Map<string, string>();
      this.byHost.set(host, jar);
    }
    for (const c of cookies) jar.set(c.name, c.value);
  }

  /** Parses and stores the `Set-Cookie` headers of a response. */
  storeFromResponse(url: string, res: Response): void {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const parsed: StoredCookie[] = [];
    for (const header of raw) {
      const first = header.split(';', 1)[0] ?? '';
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      parsed.push({ name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() });
    }
    if (parsed.length > 0) this.setCookies(url, parsed);
  }

  /** The `Cookie` request header value for `url`, or undefined when empty. */
  headerFor(url: string): string | undefined {
    const cookies = this.cookiesFor(url);
    if (cookies.length === 0) return undefined;
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export interface SessionResponse {
  res: Response;
  /** The URL of the last hop — the equivalent of Go's `resp.Request.URL`. */
  finalUrl: string;
}

const MAX_REDIRECTS = 10;

/**
 * A cookie-aware fetch that follows redirects manually so that cookies set
 * mid-chain are captured and re-sent per hop (plain `fetch` with automatic
 * redirects loses both).
 */
export class CookieSession {
  constructor(
    private readonly http: HttpClient,
    readonly jar: CookieJar = new CookieJar(),
  ) {}

  async fetch(url: string, init: RequestInit = {}): Promise<SessionResponse> {
    let current = url;
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;

    for (let hop = 0; ; hop++) {
      const headers = new Headers(init.headers);
      const cookie = this.jar.headerFor(current);
      if (cookie !== undefined) headers.set('Cookie', cookie);
      if (body === undefined || body === null) headers.delete('Content-Type');

      const res = await this.http.fetch(current, {
        ...init,
        method,
        headers,
        body: body ?? null,
        redirect: 'manual',
      });
      this.jar.storeFromResponse(current, res);

      const location = res.headers.get('location');
      if (!isRedirect(res.status) || location === null) {
        return { res, finalUrl: current };
      }
      if (hop >= MAX_REDIRECTS) {
        throw new TransportError(`filmix: stopped after ${MAX_REDIRECTS} redirects (${current})`);
      }
      await res.body?.cancel().catch(() => undefined);

      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch (err) {
        throw new TransportError(`filmix: bad redirect location ${location}: ${errMessage(err)}`, {
          cause: err,
        });
      }
      // 303, and 301/302 after a non-GET, degrade to GET without a body —
      // the behaviour of every mainstream HTTP client.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET')) {
        method = 'GET';
        body = undefined;
      }
      current = next;
    }
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
