/**
 * Error taxonomy for the Filmix client.
 *
 * The Go original uses sentinel `error` values compared with `errors.Is`.
 * TypeScript has no equivalent of wrapped-error identity, so each sentinel
 * becomes a class and `errors.Is` becomes {@link isErrorOfType}, which walks
 * the `cause` chain the same way `errors.Is` unwraps `%w`.
 */

/** Base class of every error raised by this library. */
export class FilmixError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Structured error returned by the Filmix API in the body of a response.
 * Mirrors `models.APIError`.
 */
export class ApiError extends FilmixError {
  readonly code: number;
  /** The raw message as returned by the API (without the `filmix api:` prefix). */
  readonly apiMessage: string;

  constructor(code: number, apiMessage: string) {
    super(code === 0 ? `filmix api: ${apiMessage}` : `filmix api: ${apiMessage} (code=${code})`);
    this.code = code;
    this.apiMessage = apiMessage;
  }
}

/** The device-flow `user_code` has not been activated by the user yet. */
export class TokenNotActivatedError extends FilmixError {
  constructor(cause?: unknown) {
    super('filmix: token not yet activated', { cause });
  }
}

/** No quality in the available set fits the requested cap. */
export class QualityUnavailableError extends FilmixError {
  constructor(message = 'filmix: requested quality not available', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** A requested translation name is not present in the post / player-data. */
export class TranslationNotFoundError extends FilmixError {
  constructor(message = 'filmix: translation not found', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** A requested season/episode combination does not exist. */
export class EpisodeNotFoundError extends FilmixError {
  constructor(message = 'filmix: episode not found', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** None of the discovery candidates responded with a Filmix API payload. */
export class NoApiHostError extends FilmixError {
  constructor(message = 'filmix: no working API host found', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** `/api/movies/player-data` returned no translations. */
export class PlayerDataEmptyError extends FilmixError {
  constructor() {
    super('filmix: player-data returned no translations');
  }
}

/** The post is blocked by a rights-holder takedown (the `lv` flag). */
export class ContentLockedError extends FilmixError {
  constructor() {
    super('filmix: content is locked by rights holder');
  }
}

/** The obfuscated `#2` payload could not be decoded. */
export class CannotDecodeError extends FilmixError {
  constructor(detail: string) {
    super(
      `filmix: cannot decode #2 string (garbage patterns may have changed): ${detail}`,
    );
  }
}

/** The warm-up GET of the post page failed, so player-data would return 403. */
export class WarmUpFailedError extends FilmixError {
  constructor(detail: string) {
    super(`filmix: warm-up of post page failed; pass the page URL explicitly: ${detail}`);
  }
}

/** The site rejected the supplied username/password. */
export class InvalidCredentialsError extends FilmixError {
  constructor() {
    super('filmix: invalid login or password');
  }
}

/** An authenticated site call was made before a successful login. */
export class NotAuthorizedError extends FilmixError {
  constructor() {
    super('filmix: not authorized; call loginByPassword first');
  }
}

/** Refused to copy session cookies onto a host that is not a Filmix mirror. */
export class ForeignMirrorHostError extends FilmixError {
  constructor(host: string) {
    super(`filmix: refusing to mirror cookies to non-Filmix host: ${JSON.stringify(host)}`);
  }
}

/** A non-2xx HTTP response that carried no API error envelope. */
export class HttpStatusError extends FilmixError {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, options?: { cause?: unknown }) {
    super(`filmix: http ${status}: ${body}`, options);
    this.status = status;
    this.body = body;
  }
}

/** Transport-level failure (DNS, connection refused, abort, …). */
export class TransportError extends FilmixError {}

/** A response body could not be decoded into the expected shape. */
export class DecodeError extends FilmixError {}

/** Anything the downloader rejects before or during the transfer. */
export class DownloadError extends FilmixError {}

type Ctor<T> = abstract new (...args: never[]) => T;

/**
 * `errors.Is` equivalent: reports whether `err`, or anything in its `cause`
 * chain, is an instance of `type`. Use it instead of a bare `instanceof` when
 * the error may have been wrapped by an outer layer.
 */
export function isErrorOfType<T>(err: unknown, type: Ctor<T>): err is T {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof (type as abstract new (...args: never[]) => object)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
