import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { SiteSession, State, TokenStore } from '../auth/store.js';
import { cloneState, emptyState } from '../auth/store.js';
import { isRecord, looseString } from '../models/json.js';

/**
 * `TokenStore` backed by a JSON file under the user's config directory, created
 * with mode 0600 so the token is not readable by other users.
 *
 * The on-disk keys are the Go field names (`DeviceID`, `Token`, `APIBase`,
 * `SiteSession`) so the file stays interchangeable with the Go CLI's
 * `config.json`.
 */
export class FileStore implements TokenStore {
  private state: State = emptyState();

  private constructor(readonly path: string) {}

  /**
   * Loads (or initialises) the JSON config file.
   *
   * `baseDir` overrides the platform config directory; tests pass a temporary
   * directory so they never touch the real one.
   */
  static async open(baseDir: string = userConfigDir()): Promise<FileStore> {
    const dir = path.join(baseDir, 'filmix');
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const store = new FileStore(path.join(dir, 'config.json'));
    try {
      const data = await readFile(store.path, 'utf8');
      store.state = decodeState(JSON.parse(data) as unknown);
    } catch (err) {
      if (isNotFound(err)) return store;
      // Corrupted JSON: the user thinks they are logged in (the file is there)
      // but the state is empty. Warn so they understand why the next command
      // falls back to a fresh login flow.
      process.stderr.write(
        `filmix: warning — config ${store.path} is corrupted (${String(err)}); starting from empty state\n`,
      );
    }
    return store;
  }

  load(): Promise<State> {
    return Promise.resolve(cloneState(this.state));
  }

  async save(state: State): Promise<void> {
    this.state = cloneState(state);
    const data = JSON.stringify(encodeState(this.state), null, 2);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    try {
      await rename(tmp, this.path);
    } catch (err) {
      // Don't leave a temp file with credentials behind on rename failure.
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}

interface WireSiteSession {
  Mirror: string;
  Cookies: { Name: string; Value: string }[];
}

interface WireState {
  DeviceID: string;
  Token: string;
  APIBase: string;
  SiteSession?: WireSiteSession;
}

function encodeState(state: State): WireState {
  return {
    DeviceID: state.deviceId,
    Token: state.token,
    APIBase: state.apiBase,
    ...(state.siteSession
      ? {
          SiteSession: {
            Mirror: state.siteSession.mirror,
            Cookies: state.siteSession.cookies.map((c) => ({ Name: c.name, Value: c.value })),
          },
        }
      : {}),
  };
}

function decodeState(raw: unknown): State {
  if (!isRecord(raw)) return emptyState();
  const state: State = {
    deviceId: looseString(raw['DeviceID']),
    token: looseString(raw['Token']),
    apiBase: looseString(raw['APIBase']),
  };
  const session = raw['SiteSession'];
  if (isRecord(session)) {
    const cookiesRaw = session['Cookies'];
    const siteSession: SiteSession = {
      mirror: looseString(session['Mirror']),
      cookies: Array.isArray(cookiesRaw)
        ? cookiesRaw.filter(isRecord).map((c) => ({
            name: looseString(c['Name']),
            value: looseString(c['Value']),
          }))
        : [],
    };
    state.siteSession = siteSession;
  }
  return state;
}

function isNotFound(err: unknown): boolean {
  return isRecord(err) && err['code'] === 'ENOENT';
}

/** Mirrors Go's `os.UserConfigDir` per platform. */
export function userConfigDir(): string {
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') {
    const appData = process.env['AppData'] ?? process.env['APPDATA'];
    if (appData !== undefined && appData !== '') return appData;
    return path.join(homedir(), 'AppData', 'Roaming');
  }
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg !== '') return xdg;
  return path.join(homedir(), '.config');
}
