/**
 * filmix-parser — a Filmix client for TypeScript.
 *
 * The public surface is a {@link Client} facade plus the models, errors and
 * sub-clients it is built from.
 */
export { Client, pickPlaylistFile } from './filmix.js';
export type { ResolveRequest, ResolvedLinks, ResolvedTranslation } from './filmix.js';

export { resolveOptions, defaultDevice, DEFAULT_TIMEOUT_MS } from './options.js';
export type { ClientOptions, ResolvedOptions, DeviceInfo, FetchLike } from './options.js';

export { consoleLogger, discardLogger } from './logger.js';
export type { Logger, LogFields } from './logger.js';

// Models.
export {
  Plan,
  maxQualityFor,
  parseQualities,
  applyQuality,
  pickBest,
  Post,
  Profile,
  SearchResult,
  parsePlayerLinks,
  decodeApiError,
} from './models/index.js';
export type { PlayerLinks, PostInit, Translation, Season, Episode } from './models/index.js';

// Mobile-API path.
export { ApiClient, discover, DEFAULT_API_FALLBACKS, LivehashCache } from './client/index.js';
export type { ApiClientConfig, CallOptions, TokenResponse } from './client/index.js';

// Authentication.
export {
  Authenticator,
  PasswordAuthenticator,
  MemoryStore,
  isAllowedMirrorHost,
  DEFAULT_MIRROR,
} from './auth/index.js';
export type {
  PendingAuth,
  PasswordAuthenticatorOptions,
  State,
  SiteCookie,
  SiteSession,
  TokenStore,
} from './auth/index.js';

// Website path.
export {
  SiteClient,
  decode,
  encodeForTesting,
  parsePlaylist,
  parseFileField,
  labelToQuality,
  guessSeasonNumber,
  parsePlayerDataJson,
  PlaylistFile,
  GARBAGE_CHUNKS,
} from './site/index.js';
export type { Playlist, PlayerData } from './site/index.js';

// HTTP plumbing (useful for custom transports and tests).
export { HttpClient, buildUrl, redactUrlString } from './internal/http.js';
export type { HttpClientOptions } from './internal/http.js';
export { CookieJar, CookieSession } from './internal/cookies.js';
export type { StoredCookie, SessionResponse } from './internal/cookies.js';
export { generateDeviceId } from './internal/device-id.js';

// Errors. `isErrorOfType` is the `errors.Is` equivalent: it walks `cause`.
export {
  FilmixError,
  ApiError,
  TokenNotActivatedError,
  QualityUnavailableError,
  TranslationNotFoundError,
  EpisodeNotFoundError,
  NoApiHostError,
  PlayerDataEmptyError,
  ContentLockedError,
  CannotDecodeError,
  WarmUpFailedError,
  InvalidCredentialsError,
  NotAuthorizedError,
  ForeignMirrorHostError,
  HttpStatusError,
  TransportError,
  DecodeError,
  isErrorOfType,
} from './errors.js';
