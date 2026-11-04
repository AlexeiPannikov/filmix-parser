/**
 * The Filmix device-token flow: obtain a long-lived API credential without
 * sharing the user's password.
 */
import type { ApiClient } from '../client/api.js';
import { FilmixError, TokenNotActivatedError } from '../errors.js';
import { trimRight } from '../internal/http.js';
import { sleepOrAbort } from '../internal/time.js';
import { DEFAULT_MIRROR } from './password.js';
import type { TokenStore } from './store.js';
import { emptyState } from './store.js';

/** Data needed to complete the device-token flow. */
export interface PendingAuth {
  /** Code the user enters on the website. */
  userCode: string;
  /** Mirror URL where the code is entered. */
  activationUrl: string;
  /** Conservative expiry; the API does not advertise a TTL. */
  expiresAt: Date;
  /**
   * Initial token returned by `token_request` before activation.
   * @internal — compared against to detect activation.
   */
  tempToken: string;
}

/** Floor on the activation poll interval, so the API is not hammered. */
const MIN_POLL_INTERVAL_MS = 2000;

/** Orchestrates the device-token flow. */
export class Authenticator {
  private readonly mirror: string;

  constructor(
    private readonly api: ApiClient,
    private readonly store: TokenStore,
    mirror: string = DEFAULT_MIRROR,
  ) {
    this.mirror = trimRight(mirror === '' ? DEFAULT_MIRROR : mirror, '/');
  }

  /**
   * Starts a device-flow session. The returned {@link PendingAuth} holds the
   * `user_code` the user must enter on the website; call
   * {@link waitForActivation} afterwards.
   */
  async requestCode(opts: { signal?: AbortSignal } = {}): Promise<PendingAuth> {
    let resp;
    try {
      resp = await this.api.tokenRequest(opts);
    } catch (err) {
      throw new FilmixError(`token_request: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    if (resp.userCode === '') {
      throw new FilmixError('filmix: token_request returned empty user_code');
    }
    return {
      userCode: resp.userCode,
      activationUrl: `${this.mirror}/consoles`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      tempToken: resp.userDevToken,
    };
  }

  /**
   * Polls the API until the `user_code` is activated, then persists the
   * credentials and updates the underlying {@link ApiClient}. The poll interval
   * is clamped to {@link MIN_POLL_INTERVAL_MS}.
   *
   * @throws {TokenNotActivatedError} when the signal aborts before activation.
   */
  async waitForActivation(
    pending: PendingAuth,
    pollMs: number,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const interval = Math.max(pollMs, MIN_POLL_INTERVAL_MS);

    for (;;) {
      // Repeated token_request calls return the activated token once the user
      // has entered the code. The API does not distinguish "not activated"
      // from "ok" by status code: the token field is either empty or real.
      const resp = await this.api.tokenRequest(opts);
      if (resp.userDevToken !== '' && resp.userDevToken !== pending.tempToken) {
        // Load existing state so unrelated fields (notably siteSession) survive
        // — activating a device token must not wipe a password-flow session.
        const state = await this.store.load().catch(() => emptyState());
        if (state.deviceId === '') {
          state.deviceId = this.api.device.name; // legacy fallback
        }
        this.api.setCredentials(state.deviceId, resp.userDevToken);
        state.token = resp.userDevToken;
        state.apiBase = this.api.apiBase;
        try {
          await this.store.save(state);
        } catch (err) {
          throw new FilmixError(`save token: ${err instanceof Error ? err.message : String(err)}`, {
            cause: err,
          });
        }
        return;
      }

      if (await sleepOrAbort(interval, opts.signal)) {
        throw new TokenNotActivatedError(opts.signal?.reason);
      }
    }
  }
}
