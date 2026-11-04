/**
 * Host-preference and cookie-mirroring behaviour of the website path
 * (port of `site/mirror_test.go`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PasswordAuthenticator, isAllowedMirrorHost } from '../src/auth/password.js';
import { SiteClient } from '../src/site/client.js';
import { HttpClient } from '../src/internal/http.js';
import { ForeignMirrorHostError } from '../src/errors.js';
import { readBody, startServer, type TestServer } from './helpers/server.js';

const MOVIE_RESPONSE =
  '{"type":"success","message":{"translations":{"video":{"Дубляж":"#2encA"},"trailers":{}}},"field":""}';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

interface Counter {
  hits: number;
}

/**
 * Answers the login POST, the warm-up GETs and the player-data POST, counting
 * requests that reach `/api/movies/player-data`.
 */
async function servePlayerData(body: string, status: number, counter: Counter): Promise<TestServer> {
  const server = await startServer((req, res) => {
    void readBody(req).then(() => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (path.endsWith('/engine/ajax/user_auth.php')) {
        res.writeHead(200);
        res.end('AUTHORIZED');
        return;
      }
      if (path.endsWith('/api/movies/player-data')) {
        counter.hits++;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      }
      // warm-up GETs land here (/, /play/{id}, /film/.../{id}-...html, …)
      res.writeHead(200);
      res.end('<html>page</html>');
    });
  });
  servers.push(server);
  return server;
}

async function fakeAuth(mirror: string): Promise<PasswordAuthenticator> {
  const auth = new PasswordAuthenticator({ http: new HttpClient({ timeoutMs: 5000 }), mirror });
  await auth.login('u', 'p');
  return auth;
}

describe('playerData host preference', () => {
  it('prefers the page URL host over the configured mirror', async () => {
    const primaryHits: Counter = { hits: 0 };
    const configuredHits: Counter = { hits: 0 };
    const primary = await servePlayerData(MOVIE_RESPONSE, 200, primaryHits);
    const configured = await servePlayerData(MOVIE_RESPONSE, 200, configuredHits);

    const client = new SiteClient(await fakeAuth(configured.url));
    const pd = await client.playerData(12345, `${primary.url}/film/x/12345-foo.html`);
    expect(pd.video.size).toBe(1);
    expect(primaryHits.hits).toBe(1);
    expect(configuredHits.hits).toBe(0);
  });

  it('falls back to the configured mirror when the URL host fails', async () => {
    const primaryHits: Counter = { hits: 0 };
    const configuredHits: Counter = { hits: 0 };
    const primary = await servePlayerData('{"type":"error"}', 500, primaryHits);
    const configured = await servePlayerData(MOVIE_RESPONSE, 200, configuredHits);

    const client = new SiteClient(await fakeAuth(configured.url));
    const pd = await client.playerData(12345, `${primary.url}/film/x/12345-foo.html`);
    expect(pd.video.size).toBe(1);
    expect(primaryHits.hits).toBe(1);
    expect(configuredHits.hits).toBe(1);
  });

  it('uses only the configured mirror for an id-only call', async () => {
    const hits: Counter = { hits: 0 };
    const configured = await servePlayerData(MOVIE_RESPONSE, 200, hits);
    const client = new SiteClient(await fakeAuth(configured.url));
    const pd = await client.playerData(12345, '');
    expect(pd.video.size).toBe(1);
    expect(hits.hits).toBe(1);
  });

  it('issues no extra request when the URL host equals the mirror', async () => {
    const hits: Counter = { hits: 0 };
    const server = await servePlayerData(MOVIE_RESPONSE, 200, hits);
    const client = new SiteClient(await fakeAuth(server.url));
    const pd = await client.playerData(12345, `${server.url}/film/x/12345-foo.html`);
    expect(pd.video.size).toBe(1);
    expect(hits.hits).toBe(1);
  });
});

describe('mirrorCookiesTo', () => {
  async function loggedInAuth(): Promise<PasswordAuthenticator> {
    const server = await startServer((req, res) => {
      void readBody(req).then(() => {
        res.setHeader('Set-Cookie', 'session=abc; Path=/');
        res.writeHead(200);
        res.end((req.url ?? '').includes('user_auth') ? 'AUTHORIZED' : '<html></html>');
      });
    });
    servers.push(server);
    const auth = new PasswordAuthenticator({ http: new HttpClient({ timeoutMs: 5000 }), mirror: server.url });
    await auth.login('u', 'p');
    return auth;
  }

  it('copies the session onto another Filmix host', async () => {
    const auth = await loggedInAuth();
    const target = 'http://other.filmix.example/';
    auth.mirrorCookiesTo(target);
    expect(auth.session.jar.cookiesFor(target)).toEqual([{ name: 'session', value: 'abc' }]);
  });

  it('refuses a foreign host and leaves the jar untouched', async () => {
    const auth = await loggedInAuth();
    const target = 'http://attacker.example/film/x/12345-foo.html';
    expect(() => auth.mirrorCookiesTo(target)).toThrow(ForeignMirrorHostError);
    expect(auth.session.jar.cookiesFor(target)).toEqual([]);
  });

  it('is a no-op for the mirror host itself', async () => {
    const auth = await loggedInAuth();
    expect(() => auth.mirrorCookiesTo(auth.mirror)).not.toThrow();
  });
});

describe('isAllowedMirrorHost', () => {
  it.each([
    ['filmix.my', true],
    ['other.FILMIX.example', true],
    ['localhost:8080', true],
    ['127.0.0.1:52341', true],
    ['[::1]:8080', true],
    ['attacker.example', false],
    ['192.168.1.10', false],
    ['', false],
  ])('isAllowedMirrorHost(%j) === %s', (host, want) => {
    expect(isAllowedMirrorHost(host)).toBe(want);
  });
});
