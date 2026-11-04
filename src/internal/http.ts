/** Low-level HTTP plumbing for the Filmix API client (port of `internal/httpx`). */
import type { ApiError} from '../errors.js';
import { DecodeError, HttpStatusError, TransportError } from '../errors.js';
import type { Logger } from '../logger.js';
import { decodeApiError } from '../models/error.js';

/**
 * Maximum size of an API response body buffered in memory. The largest payload
 * is `/api/v2/post/{id}` for a long-running series, which empirically fits in
 * well under 1 MB. 16 MB is a safe cap that still bounds memory.
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** The subset of `fetch` this library depends on. Injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Whole-request timeout in milliseconds. 0 or undefined disables it. */
  timeoutMs?: number;
}

/**
 * Thin wrapper around `fetch` that owns the request timeout, the equivalent of
 * Go's `*http.Client`. Instances are immutable and cheap to derive.
 */
export class HttpClient {
  readonly timeoutMs: number;
  private readonly impl: FetchLike;

  constructor(opts: HttpClientOptions = {}) {
    this.impl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 0;
  }

  /**
   * Returns a client sharing this one's `fetch` with the timeout removed.
   * Used by the downloader: a whole-request timeout cuts 100+ MB streams.
   */
  withoutTimeout(): HttpClient {
    return new HttpClient({ fetch: this.impl, timeoutMs: 0 });
  }

  /** Issues the request, composing the caller's signal with the timeout. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const signal = composeSignal(init.signal ?? undefined, this.timeoutMs);
    try {
      return await this.impl(url, signal ? { ...init, signal } : init);
    } catch (err) {
      throw new TransportError(
        `filmix: http ${String(init.method ?? 'GET')} ${redactUrlString(url)}: ${errMessage(err)}`,
        { cause: err },
      );
    }
  }
}

/** Combines an optional caller signal with an optional timeout. */
export function composeSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  if (timeoutMs > 0) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return caller ? AbortSignal.any([caller, timeout]) : timeout;
  }
  return caller;
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Device identity fields that every Filmix API request must carry as query
 * parameters.
 */
export interface DeviceInfo {
  name: string;
  vendor: string;
  os: string;
  apk: string;
}

/**
 * Composes a fully-qualified API URL with all required device parameters plus
 * any extra query values.
 *
 * `extra` is treated as read-only — the caller's record is never mutated.
 */
export function buildUrl(
  base: string,
  path: string,
  dev: DeviceInfo,
  deviceId: string,
  token: string,
  extra?: Readonly<Record<string, string>>,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v);
  q.set('user_dev_id', deviceId);
  q.set('user_dev_name', dev.name);
  q.set('user_dev_vendor', dev.vendor);
  q.set('user_dev_os', dev.os);
  q.set('user_dev_apk', dev.apk);
  if (token !== '') q.set('user_dev_token', token);
  // url.Values.Encode() sorts by key; match it so URLs are deterministic.
  q.sort();

  const full = trimRight(base, '/') + '/' + trimLeft(path, '/');
  const sep = full.includes('?') ? '&' : '?';
  return full + sep + q.toString();
}

/**
 * Returns a URL string with the `user_dev_token` query parameter masked. Use
 * before logging any API URL.
 */
export function redactUrlString(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (!u.searchParams.has('user_dev_token')) return u.toString();
  u.searchParams.set('user_dev_token', '***');
  u.searchParams.sort();
  return u.toString();
}

export function trimRight(s: string, cut: string): string {
  let end = s.length;
  while (end > 0 && cut.includes(s.charAt(end - 1))) end--;
  return s.slice(0, end);
}

export function trimLeft(s: string, cut: string): string {
  let start = 0;
  while (start < s.length && cut.includes(s.charAt(start))) start++;
  return s.slice(start);
}

/**
 * Reads at most `limit` bytes of the response body and decodes them as UTF-8.
 * Mirrors `io.ReadAll(io.LimitReader(body, limit))`: the excess is dropped
 * silently rather than raising.
 */
export async function readTextLimited(res: Response, limit: number): Promise<string> {
  if (res.body === null) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  // The global Response body is loosely typed; pin the chunk type.
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const room = limit - size;
      if (room <= 0) break;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        size += room;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}

/**
 * Runs the request, reads the body with a size cap, logs the redacted URL, and
 * surfaces API error envelopes or non-2xx responses as thrown errors.
 *
 * The error envelope is checked **before** the status code, matching the Go
 * original: Filmix returns a structured envelope with both 2xx and 4xx codes.
 */
export async function doRaw(
  client: HttpClient,
  log: Logger | undefined,
  url: string,
  init: RequestInit = {},
): Promise<string> {
  const res = await client.fetch(url, init);
  const body = await readTextLimited(res, MAX_RESPONSE_BYTES);
  log?.debug('filmix.api', {
    method: init.method ?? 'GET',
    url: redactUrlString(url),
    status: res.status,
    bytes: Buffer.byteLength(body),
  });
  const apiErr: ApiError | undefined = decodeApiError(body);
  if (apiErr) throw apiErr;
  if (res.status >= 400) throw new HttpStatusError(res.status, truncate(body, 200));
  return body;
}

/** `doRaw` plus a JSON parse. The caller narrows the `unknown` result. */
export async function doJson(
  client: HttpClient,
  log: Logger | undefined,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const body = await doRaw(client, log, url, init);
  return parseJson(body);
}

export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (err) {
    throw new DecodeError(`filmix: decode response: ${errMessage(err)}`, { cause: err });
  }
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '...';
}
