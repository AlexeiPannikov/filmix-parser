/**
 * A {@link FetchLike} backed by **got-scraping** (the HTTP core of the Crawlee
 * stack). It is the realistic browser-imitation path: got-scraping fills in a
 * consistent browser header set (sec-ch-ua, sec-fetch-*, accept ordering, …)
 * for any header the caller did not set, and negotiates HTTP/2 with a
 * browser-like TLS fingerprint — things a static `User-Agent` cannot fake.
 *
 * Wire it in through {@link ClientOptions.fetch}:
 *
 * ```ts
 * import { Client } from 'filmix-parser';
 * import { createGotScrapingFetch } from 'filmix-parser/net/got-scraping';
 *
 * const client = new Client({ fetch: await createGotScrapingFetch() });
 * ```
 *
 * got-scraping is an **optional** peer dependency; this module dynamically
 * imports it so the core library stays dependency-free until you opt in.
 *
 * The existing {@link CookieSession} still owns cookies and redirects — this
 * adapter runs with `followRedirect: false` and only transports one hop. By
 * default it strips the caller's `User-Agent` so got-scraping generates one
 * that matches its own `sec-ch-ua` / TLS fingerprint (pass `keepUserAgent` to
 * opt out); every other header the library set is preserved.
 *
 * **One identity per adapter.** Each adapter pins a single generated browser
 * fingerprint (via got-scraping's `sessionToken`) and reuses it for every
 * request. This is load-bearing: the site's warm-up GET mints session cookies,
 * and the gated player-data POST sends them back. If the fingerprint rotated
 * per request (got-scraping's default), the POST would look like a *different*
 * browser than the one the cookies were minted for, and the edge anti-bot
 * answers that mismatch with HTTP 403 — measured at ~50 % of requests, versus
 * ~0 % once pinned. For a fresh identity, create a fresh adapter.
 */
import { Readable } from 'node:stream';
import type { Method } from 'got-scraping';
import type { FetchLike } from '../internal/http.js';

/** Statuses the `Response` constructor forbids a body on. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export interface GotScrapingFetchOptions {
  /**
   * Extra got-scraping options merged into every request — e.g. `proxyUrl`,
   * `http2: false`, or a `headerGeneratorOptions` browser/OS profile. See the
   * got-scraping docs. Caller-supplied per-request headers still win.
   */
  gotOptions?: Record<string, unknown>;
  /**
   * Keep the caller's `User-Agent` instead of letting got-scraping generate
   * one. Off by default: dropping it lets the header generator emit a realistic
   * UA that matches the `sec-ch-ua` / TLS fingerprint it also produces — the
   * whole point of this transport. The generated identity is **stable for the
   * life of the adapter** (see the module doc), not rotated per request. All
   * other caller headers are preserved.
   */
  keepUserAgent?: boolean;
}

/**
 * Builds a {@link FetchLike} on top of got-scraping. Dynamically imports the
 * package on first call, so it is only required when this is used.
 *
 * @throws if got-scraping is not installed, or a non-string body is sent (the
 *   library only ever sends url-encoded form strings).
 */
export async function createGotScrapingFetch(
  opts: GotScrapingFetchOptions = {},
): Promise<FetchLike> {
  const { gotScraping } = await import('got-scraping');

  // Opaque, non-primitive token: got-scraping retains the generated header set
  // per token, so one adapter = one stable browser fingerprint across requests.
  const sessionToken = {};

  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const method = (init.method ?? 'GET').toUpperCase();

      const headers = init.headers ? Object.fromEntries(new Headers(init.headers)) : undefined;
      // Let got-scraping own the User-Agent so it matches the fingerprint it
      // generates, unless the caller insists on keeping theirs.
      if (headers && opts.keepUserAgent !== true) delete headers['user-agent'];

      let body: string | undefined;
      if (init.body !== null && init.body !== undefined) {
        if (typeof init.body !== 'string') {
          reject(new TypeError('createGotScrapingFetch: only string request bodies are supported'));
          return;
        }
        body = init.body;
      }

      const stream = gotScraping.stream(input, {
        method: method as Method,
        headers,
        ...(body !== undefined ? { body } : {}),
        sessionToken,
        followRedirect: false,
        throwHttpErrors: false,
        // The caller's AbortSignal (and the library's own timeout) govern;
        // drop got-scraping's internal 60 s cap so large streams can finish.
        timeout: { request: undefined },
        ...(init.signal ? { signal: init.signal } : {}),
        ...opts.gotOptions,
      });

      // got.stream does not auto-end non-GET requests that carry no body option.
      if (body === undefined && method !== 'GET' && method !== 'HEAD') stream.end();

      stream.once('error', reject);
      stream.once('response', (res: { statusCode?: number; headers: Record<string, string | string[] | undefined> }) => {
        const status = res.statusCode ?? 502;

        const out = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          // HTTP/2 responses carry pseudo-headers (":status", …) that the web
          // Headers API rejects as invalid names.
          if (name.startsWith(':')) continue;
          const key = name.toLowerCase();
          // got-scraping decompresses the body; its length/encoding no longer
          // describe what we forward, so undici would mis-handle them.
          if (key === 'content-encoding' || key === 'content-length') continue;
          if (Array.isArray(value)) for (const one of value) out.append(name, one);
          else out.append(name, value);
        }

        if (NULL_BODY_STATUS.has(status)) {
          stream.destroy();
          resolve(new Response(null, { status, headers: out }));
          return;
        }
        const web = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
        resolve(new Response(web, { status, headers: out }));
      });
    });
}
