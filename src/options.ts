import type { DeviceInfo, FetchLike } from './internal/http.js';
import { discardLogger, type Logger } from './logger.js';
import { MemoryStore, type TokenStore } from './auth/store.js';
import { DEFAULT_MIRROR } from './auth/password.js';

export type { DeviceInfo, FetchLike };

/** Default whole-request timeout for API calls (downloads are exempt). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Device fingerprint sent to the Filmix API. The defaults emulate the Android
 * mobile app the API was designed for.
 */
export function defaultDevice(): DeviceInfo {
  return { name: 'go-filmix', vendor: 'Xiaomi', os: '11', apk: '2.0.9' };
}

/**
 * Configuration of a {@link Client}.
 *
 * The Go original exposes functional `With*` options; an options object is the
 * idiomatic TypeScript equivalent and carries the same fields.
 */
export interface ClientOptions {
  /** Replaces the `fetch` used for all API and download requests. */
  fetch?: FetchLike;
  /** Whole-request timeout for API calls in ms. Defaults to 30 000. */
  timeoutMs?: number;
  /** Logger for diagnostic output. Defaults to a discard logger. */
  logger?: Logger;
  /** Credential persistence layer. Defaults to an in-process store. */
  tokenStore?: TokenStore;
  /** Forces a specific API base URL, skipping discovery. */
  apiBase?: string;
  /**
   * Overrides the discovery candidate list. Hosts are probed concurrently; the
   * first successful host is cached in the token store.
   */
  apiFallbacks?: readonly string[];
  /**
   * User-facing website URL embedded into the activation link shown during the
   * device-token flow, and the host used by the website path. Defaults to
   * `https://filmix.my`.
   */
  mirror?: string;
  /** Overrides the device fingerprint sent on every API request. */
  device?: DeviceInfo;
  /**
   * Enables CDN livehash refresh: MP4 URLs returned by the API are rewritten
   * with the latest `/s/{hash}/` prefix before download. Off by default.
   */
  livehash?: boolean;
}

/** Immutable, fully-resolved configuration of a {@link Client}. */
export interface ResolvedOptions {
  fetch: FetchLike | undefined;
  timeoutMs: number;
  logger: Logger;
  tokenStore: TokenStore;
  apiBase: string;
  apiFallbacks: readonly string[];
  mirror: string;
  device: DeviceInfo;
  livehash: boolean;
}

export function resolveOptions(opts: ClientOptions = {}): ResolvedOptions {
  return {
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    logger: opts.logger ?? discardLogger,
    tokenStore: opts.tokenStore ?? new MemoryStore(),
    apiBase: opts.apiBase ?? '',
    apiFallbacks: opts.apiFallbacks ?? [],
    mirror: opts.mirror !== undefined && opts.mirror !== '' ? opts.mirror : DEFAULT_MIRROR,
    device: opts.device ?? defaultDevice(),
    livehash: opts.livehash ?? false,
  };
}
