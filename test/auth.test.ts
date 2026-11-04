import { afterEach, describe, expect, it } from 'vitest';
import { Authenticator } from '../src/auth/device-token.js';
import { MemoryStore, type State } from '../src/auth/store.js';
import { PasswordAuthenticator } from '../src/auth/password.js';
import { ApiClient } from '../src/client/api.js';
import { HttpClient } from '../src/internal/http.js';
import { InvalidCredentialsError, TokenNotActivatedError, isErrorOfType } from '../src/errors.js';
import { readBody, startServer, type TestServer } from './helpers/server.js';

const device = { name: 'go-filmix', vendor: 'Xiaomi', os: '11', apk: '2.0.9' };

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function newAuth(
  handler: () => string,
): Promise<{ auth: Authenticator; store: MemoryStore; api: ApiClient }> {
  server = await startServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(handler());
  });
  const api = new ApiClient({
    http: new HttpClient({ timeoutMs: 5000 }),
    device,
    apiBase: `${server.url}/api/v2`,
    deviceId: 'deadbeefdeadbeef',
  });
  const store = new MemoryStore();
  await store.save({
    deviceId: 'deadbeefdeadbeef',
    token: '',
    apiBase: `${server.url}/api/v2`,
  });
  return { auth: new Authenticator(api, store, 'https://filmix.my'), store, api };
}

describe('Authenticator.requestCode', () => {
  it('returns the user code and activation URL', async () => {
    const { auth } = await newAuth(() => '{"user_code":"ABCD","user_dev_token":""}');
    const pending = await auth.requestCode();
    expect(pending.userCode).toBe('ABCD');
    expect(pending.activationUrl).toBe('https://filmix.my/consoles');
    expect(pending.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects an empty user_code', async () => {
    const { auth } = await newAuth(() => '{"user_code":"","user_dev_token":""}');
    await expect(auth.requestCode()).rejects.toThrow(/empty user_code/);
  });
});

describe('Authenticator.waitForActivation', () => {
  it('stores the token once the code is activated', async () => {
    let calls = 0;
    const { auth, store, api } = await newAuth(() => {
      calls++;
      // First two responses: still pending. Third: activated.
      return calls < 3
        ? '{"user_code":"ABCD","user_dev_token":""}'
        : '{"user_code":"ABCD","user_dev_token":"REAL_TOKEN"}';
    });

    await auth.waitForActivation(
      { userCode: 'ABCD', activationUrl: '', expiresAt: new Date(), tempToken: '' },
      50,
      { signal: AbortSignal.timeout(10_000) },
    );
    const state = await store.load();
    expect(state.token).toBe('REAL_TOKEN');
    expect(api.credentials().token).toBe('REAL_TOKEN');
  });

  it('preserves a previously persisted site session', async () => {
    const { auth, store } = await newAuth(
      () => '{"user_code":"ABCD","user_dev_token":"REAL_TOKEN"}',
    );
    const prior: State = {
      deviceId: 'deadbeefdeadbeef',
      token: '',
      apiBase: 'ignored-by-test',
      siteSession: {
        mirror: 'https://filmix.my',
        cookies: [{ name: 'dle_user_id', value: '42' }],
      },
    };
    await store.save(prior);

    await auth.waitForActivation(
      { userCode: 'ABCD', activationUrl: '', expiresAt: new Date(), tempToken: '' },
      20,
      { signal: AbortSignal.timeout(5000) },
    );

    const state = await store.load();
    expect(state.token).toBe('REAL_TOKEN');
    expect(state.deviceId).toBe('deadbeefdeadbeef');
    expect(state.siteSession?.mirror).toBe('https://filmix.my');
    expect(state.siteSession?.cookies).toEqual([{ name: 'dle_user_id', value: '42' }]);
  });

  it('does not mistake the pre-activation temp token for an activated one', async () => {
    const { auth } = await newAuth(() => '{"user_code":"ABCD","user_dev_token":"TEMP"}');
    const err = await auth
      .waitForActivation(
        { userCode: 'ABCD', activationUrl: '', expiresAt: new Date(), tempToken: 'TEMP' },
        20,
        { signal: AbortSignal.timeout(120) },
      )
      .catch((e: unknown) => e);
    expect(isErrorOfType(err, TokenNotActivatedError)).toBe(true);
  });

  it('reports TokenNotActivatedError when the signal expires', async () => {
    const { auth } = await newAuth(() => '{"user_code":"ABCD","user_dev_token":""}');
    const err = await auth
      .waitForActivation(
        { userCode: 'ABCD', activationUrl: '', expiresAt: new Date(), tempToken: '' },
        20,
        { signal: AbortSignal.timeout(80) },
      )
      .catch((e: unknown) => e);
    expect(isErrorOfType(err, TokenNotActivatedError)).toBe(true);
  });
});

describe('MemoryStore', () => {
  it('deep-copies the site session on save and load', async () => {
    const store = new MemoryStore();
    const session = { mirror: 'https://filmix.my', cookies: [{ name: 'a', value: '1' }] };
    await store.save({ deviceId: 'd', token: 't', apiBase: 'b', siteSession: session });
    session.cookies[0]!.value = 'mutated';

    const loaded = await store.load();
    expect(loaded.siteSession?.cookies[0]?.value).toBe('1');
    loaded.siteSession!.cookies[0]!.value = 'also mutated';
    expect((await store.load()).siteSession?.cookies[0]?.value).toBe('1');
  });
});

describe('PasswordAuthenticator', () => {
  it('logs in on an AUTHORIZED body and snapshots the session cookies', async () => {
    const bodies: string[] = [];
    server = await startServer((req, res) => {
      void readBody(req).then((body) => {
        res.setHeader('Set-Cookie', 'session=abc; Path=/');
        if ((req.url ?? '').includes('/engine/ajax/user_auth.php')) {
          bodies.push(body);
          res.writeHead(200);
          res.end('AUTHORIZED');
          return;
        }
        res.writeHead(200);
        res.end('<html></html>');
      });
    });

    const auth = new PasswordAuthenticator({
      http: new HttpClient({ timeoutMs: 5000 }),
      mirror: server.url,
    });
    expect(auth.authorized()).toBe(false);
    await auth.login('user', 'pa ss&word');
    expect(auth.authorized()).toBe(true);
    expect(bodies[0]).toContain('login_name=user');
    expect(bodies[0]).toContain('login_password=pa+ss%26word');
    expect(bodies[0]).toContain('login=submit');

    const snapshot = auth.snapshot();
    expect(snapshot.mirror).toBe(server.url);
    expect(snapshot.cookies).toEqual([{ name: 'session', value: 'abc' }]);
  });

  it('rejects wrong credentials', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end('Неверный логин или пароль');
    });
    const auth = new PasswordAuthenticator({ mirror: server.url });
    await expect(auth.login('u', 'p')).rejects.toThrow(InvalidCredentialsError);
    expect(auth.authorized()).toBe(false);
    expect(auth.snapshot()).toEqual({ mirror: '', cookies: [] });
  });

  it('restores a snapshot and rejects a mismatched mirror', () => {
    const auth = new PasswordAuthenticator({ mirror: 'https://filmix.my' });
    expect(() => auth.restore({ mirror: 'https://other.example', cookies: [] })).toThrow(
      /mirror mismatch/,
    );
    expect(() => auth.restore({ mirror: 'https://filmix.my', cookies: [] })).toThrow(/no cookies/);

    auth.restore({ mirror: 'https://filmix.my/', cookies: [{ name: 'session', value: 'abc' }] });
    expect(auth.authorized()).toBe(true);
    expect(auth.session.jar.headerFor('https://filmix.my/any')).toBe('session=abc');
  });

  it('exposes browser headers pinned to the mirror', () => {
    const auth = new PasswordAuthenticator({ mirror: 'https://filmix.my' });
    const headers = auth.browserHeaders();
    expect(headers['Origin']).toBe('https://filmix.my');
    expect(headers['Referer']).toBe('https://filmix.my/');
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(headers['User-Agent']).toContain('Mozilla/5.0');
  });
});
