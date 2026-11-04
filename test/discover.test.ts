import { afterEach, describe, expect, it } from 'vitest';
import { discover } from '../src/client/discover.js';
import { HttpClient } from '../src/internal/http.js';
import { NoApiHostError, isErrorOfType } from '../src/errors.js';
import { startServer, type TestServer } from './helpers/server.js';

const device = { name: 'go-filmix', vendor: 'Xiaomi', os: '11', apk: '2.0.9' };
const http = new HttpClient({ timeoutMs: 5000 });

/** What /check_update returns on the live API. */
const VALID_PROBE_BODY = '{"version":"2.2.13","release_date":"2025-12-06"}';

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(
  handler: (url: URL) => { status?: number; body: string },
): Promise<TestServer> {
  const server = await startServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const { status, body } = handler(url);
    res.writeHead(status ?? 200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  servers.push(server);
  return server;
}

describe('discover', () => {
  it('returns the working host and sends device params', async () => {
    let seen: URL | undefined;
    const good = await serve((url) => {
      seen = url;
      return { body: VALID_PROBE_BODY };
    });

    const got = await discover(http, device, [good.url, 'http://127.0.0.1:1']);
    expect(got).toBe(good.url);
    expect(seen?.pathname).toBe('/check_update');
    expect(seen?.searchParams.get('user_dev_apk')).toBe('2.0.9');
  });

  it('falls through a host that answers 400', async () => {
    const bad = await serve(() => ({ status: 400, body: '' }));
    const good = await serve(() => ({ body: VALID_PROBE_BODY }));
    expect(await discover(http, device, [bad.url, good.url])).toBe(good.url);
  });

  it('rejects a 200 response that is not /check_update', async () => {
    const notFilmix = await serve(() => ({ body: '<!DOCTYPE html><html>nope</html>' }));
    const err = await discover(http, device, [notFilmix.url]).catch((e: unknown) => e);
    expect(isErrorOfType(err, NoApiHostError)).toBe(true);
  });

  it('reports every failure when all candidates fail', async () => {
    const err = await discover(http, device, ['http://127.0.0.1:1', 'http://127.0.0.1:2']).catch(
      (e: unknown) => e,
    );
    expect(isErrorOfType(err, NoApiHostError)).toBe(true);
    expect((err as Error).message).toContain('127.0.0.1:1');
    expect((err as Error).message).toContain('127.0.0.1:2');
  });

  it('trims a trailing slash from the winning base', async () => {
    const good = await serve(() => ({ body: VALID_PROBE_BODY }));
    expect(await discover(http, device, [`${good.url}/`])).toBe(good.url);
  });

  it('fails when the caller aborts', async () => {
    const slow = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end(VALID_PROBE_BODY);
      }, 500);
    });
    servers.push(slow);

    const err = await discover(http, device, [slow.url], {
      signal: AbortSignal.timeout(20),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });
});
