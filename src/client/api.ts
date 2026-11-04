/**
 * Low-level HTTP client for Filmix API v2 (the "mobile API" path).
 *
 * User code normally goes through the higher-level {@link Client} facade rather
 * than constructing an `ApiClient` directly.
 */
import { buildUrl, doJson, type DeviceInfo, type HttpClient } from '../internal/http.js';
import { discardLogger, type Logger } from '../logger.js';
import { isRecord, looseString } from '../models/json.js';
import { Post } from '../models/post.js';
import { Profile } from '../models/profile.js';
import { SearchResult } from '../models/search.js';
import { DecodeError } from '../errors.js';

export interface ApiClientConfig {
  http: HttpClient;
  logger?: Logger;
  device: DeviceInfo;
  /** The base URL discovered or explicitly set, e.g. `http://host/api/v2`. */
  apiBase?: string;
  deviceId?: string;
  token?: string;
}

/** Per-call options; `signal` cancels the request the way a Go context does. */
export interface CallOptions {
  signal?: AbortSignal;
}

/**
 * Shape of `/api/v2/token_request`, which serves both halves of the device
 * flow: the first call returns the `user_code` the user enters on the website,
 * and subsequent calls return the persistent `user_dev_token` once activated.
 */
export interface TokenResponse {
  userCode: string;
  userDevToken: string;
}

export class ApiClient {
  readonly http: HttpClient;
  readonly logger: Logger;
  readonly device: DeviceInfo;

  private base: string;
  private deviceId: string;
  private token: string;

  constructor(cfg: ApiClientConfig) {
    this.http = cfg.http;
    this.logger = cfg.logger ?? discardLogger;
    this.device = cfg.device;
    this.base = cfg.apiBase ?? '';
    this.deviceId = cfg.deviceId ?? '';
    this.token = cfg.token ?? '';
  }

  /** The currently active API base URL. */
  get apiBase(): string {
    return this.base;
  }

  setApiBase(base: string): void {
    this.base = base;
  }

  /** Updates the device id and token used by subsequent requests. */
  setCredentials(deviceId: string, token: string): void {
    this.deviceId = deviceId;
    this.token = token;
  }

  credentials(): { deviceId: string; token: string } {
    return { deviceId: this.deviceId, token: this.token };
  }

  /** Calls `/api/v2/search` with the given free-text query. */
  async search(query: string, opts: CallOptions = {}): Promise<SearchResult[]> {
    const payload = await doJson(this.http, this.logger, this.url('search', { story: query }), {
      ...signalInit(opts),
    });
    return SearchResult.listFromJson(payload);
  }

  /** Fetches the metadata of a single post (movie or series). */
  async getPost(id: number, opts: CallOptions = {}): Promise<Post> {
    const payload = await doJson(this.http, this.logger, this.url(`post/${id}`), {
      ...signalInit(opts),
    });
    return Post.fromJson(payload);
  }

  /** Fetches the current user profile. */
  async profile(opts: CallOptions = {}): Promise<Profile> {
    const payload = await doJson(this.http, this.logger, this.url('user_profile'), {
      ...signalInit(opts),
    });
    return Profile.fromJson(payload);
  }

  /** Calls `/api/v2/token_request`. */
  async tokenRequest(opts: CallOptions = {}): Promise<TokenResponse> {
    const payload = await doJson(this.http, this.logger, this.url('token_request'), {
      ...signalInit(opts),
    });
    if (!isRecord(payload)) {
      throw new DecodeError('filmix: decode token_request: payload is not an object');
    }
    return {
      userCode: looseString(payload['user_code']),
      userDevToken: looseString(payload['user_dev_token']),
    };
  }

  /** Builds a fully-qualified URL for `path` with the device parameters. */
  url(path: string, extra?: Readonly<Record<string, string>>): string {
    return buildUrl(this.base, path, this.device, this.deviceId, this.token, extra);
  }
}

export function signalInit(opts: CallOptions): { signal?: AbortSignal } {
  return opts.signal ? { signal: opts.signal } : {};
}
