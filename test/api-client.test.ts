import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/client/api.js';
import { HttpClient } from '../src/internal/http.js';
import { ApiError, HttpStatusError, TransportError, isErrorOfType } from '../src/errors.js';
import { fixture, startServer, type TestServer } from './helpers/server.js';

const device = { name: 'go-filmix', vendor: 'Xiaomi', os: '11', apk: '2.0.9' };

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function newTestClient(
  handler: (url: URL) => Promise<{ status?: number; body: string }>,
): Promise<ApiClient> {
  server = await startServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handler(url).then(({ status, body }) => {
      res.writeHead(status ?? 200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
  });
  return new ApiClient({
    http: new HttpClient({ timeoutMs: 5000 }),
    device,
    apiBase: `${server.url}/api/v2`,
    deviceId: 'abcdef0123456789',
    token: 'tok-test',
  });
}

function assertDeviceParams(url: URL): void {
  for (const key of [
    'user_dev_id',
    'user_dev_name',
    'user_dev_vendor',
    'user_dev_os',
    'user_dev_apk',
  ]) {
    expect(url.searchParams.get(key), `missing query param ${key}`).toBeTruthy();
  }
}

describe('ApiClient.search', () => {
  it('sends device params and decodes the result list', async () => {
    let seen: URL | undefined;
    const client = await newTestClient(async (url) => {
      seen = url;
      return { body: await fixture('search.json') };
    });

    const results = await client.search('matrix');
    expect(seen?.pathname).toBe('/api/v2/search');
    assertDeviceParams(seen!);
    expect(seen?.searchParams.get('story')).toBe('matrix');
    expect(seen?.searchParams.get('user_dev_token')).toBe('tok-test');
    expect(results).toHaveLength(2);
    expect(results[0]?.title).toBe('Интерстеллар');
  });
});

describe('ApiClient.getPost', () => {
  it('requests /post/{id} and decodes a movie', async () => {
    let seen: URL | undefined;
    const client = await newTestClient(async (url) => {
      seen = url;
      return { body: await fixture('post_movie.json') };
    });

    const post = await client.getPost(12345);
    expect(seen?.pathname).toBe('/api/v2/post/12345');
    expect(post.isSeries()).toBe(false);
    expect(post.playerLinks.movie).toHaveLength(2);
  });
});

describe('ApiClient error handling', () => {
  it('surfaces an API error envelope as ApiError', async () => {
    const client = await newTestClient(async () => ({
      status: 403,
      body: await fixture('error_user_message.json'),
    }));

    const err = await client.getPost(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(403);
  });

  it('surfaces a bare non-2xx response as HttpStatusError', async () => {
    const client = await newTestClient(() =>
      Promise.resolve({ status: 500, body: '<html>oops</html>' }),
    );
    const err = await client.search('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect((err as HttpStatusError).status).toBe(500);
  });

  it('wraps transport failures', async () => {
    const client = new ApiClient({
      http: new HttpClient({ timeoutMs: 2000 }),
      device,
      apiBase: 'http://127.0.0.1:1/api/v2', // closed port
    });
    const err = await client.search('x').catch((e: unknown) => e);
    expect(isErrorOfType(err, TransportError)).toBe(true);
  });

  it('does not leak the token into the error message', async () => {
    const client = new ApiClient({
      http: new HttpClient({ timeoutMs: 2000 }),
      device,
      apiBase: 'http://127.0.0.1:1/api/v2',
      token: 'SUPERSECRET',
    });
    const err = await client.search('x').catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('SUPERSECRET');
    expect((err as Error).message).toContain('user_dev_token=***');
  });
});

describe('ApiClient.tokenRequest', () => {
  it('decodes the device-flow payload', async () => {
    let seen: URL | undefined;
    const client = await newTestClient(async (url) => {
      seen = url;
      return { body: await fixture('token_request.json') };
    });

    const resp = await client.tokenRequest();
    expect(seen?.pathname).toBe('/api/v2/token_request');
    expect(resp.userCode).toBe('ABCD');
    expect(resp.userDevToken).not.toBe('');
  });
});

describe('ApiClient credential and base updates', () => {
  it('applies the latest credentials to each request', async () => {
    let lastToken: string | null = null;
    server = await startServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      lastToken = url.searchParams.get('user_dev_token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });

    const client = new ApiClient({
      http: new HttpClient({ timeoutMs: 5000 }),
      device,
      apiBase: 'http://stale/api/v2',
    });
    client.setApiBase(`${server.url}/api/v2`);
    client.setCredentials('dev1', 'tokA');
    await client.search('x');
    expect(lastToken).toBe('tokA');

    client.setCredentials('dev2', 'tokB');
    await client.search('x');
    expect(lastToken).toBe('tokB');
    expect(client.credentials()).toEqual({ deviceId: 'dev2', token: 'tokB' });
    expect(client.apiBase).toBe(`${server.url}/api/v2`);
  });
});

describe('ApiClient.profile', () => {
  it('decodes the profile payload', async () => {
    const client = await newTestClient(async () => ({
      body: await fixture('user_profile_pro.json'),
    }));
    const profile = await client.profile();
    expect(profile.login).toBe('tester');
    expect(profile.isProPlus).toBe(true);
  });
});
