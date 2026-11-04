/** Persisted credentials shared across processes and restarts. */
export interface State {
  deviceId: string;
  token: string;
  /** Cached API base so discovery is skipped on the next start. */
  apiBase: string;
  /** Website cookies obtained by the password flow, when present. */
  siteSession?: SiteSession;
}

/** JSON-friendly subset of a cookie used to persist a website session. */
export interface SiteCookie {
  name: string;
  value: string;
}

/** The minimum needed to resume an authenticated site session. */
export interface SiteSession {
  mirror: string;
  cookies: SiteCookie[];
}

/** Persists device credentials. */
export interface TokenStore {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}

export function emptyState(): State {
  return { deviceId: '', token: '', apiBase: '' };
}

/** Deep copy so callers cannot mutate stored state through a shared reference. */
export function cloneState(state: State): State {
  return {
    deviceId: state.deviceId,
    token: state.token,
    apiBase: state.apiBase,
    ...(state.siteSession
      ? {
          siteSession: {
            mirror: state.siteSession.mirror,
            cookies: state.siteSession.cookies.map((c) => ({ ...c })),
          },
        }
      : {}),
  };
}

/**
 * Default in-process {@link TokenStore}. Credentials live only for the lifetime
 * of the process — the user must re-authenticate on restart.
 */
export class MemoryStore implements TokenStore {
  private state: State = emptyState();

  load(): Promise<State> {
    return Promise.resolve(cloneState(this.state));
  }

  save(state: State): Promise<void> {
    this.state = cloneState(state);
    return Promise.resolve();
  }
}
