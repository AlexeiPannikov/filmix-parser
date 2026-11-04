/** End-to-end facade behaviour (port of `filmix_test.go`, plus extra cases). */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '../src/filmix.js';
import { MemoryStore } from '../src/auth/store.js';
import { Plan } from '../src/models/quality.js';
import { encodeForTesting } from '../src/site/decoder.js';
import { ContentLockedError, isErrorOfType } from '../src/errors.js';
import { fixture, readBody, startServer, type TestServer } from './helpers/server.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(handler: Parameters<typeof startServer>[0]): Promise<TestServer> {
  const server = await startServer(handler);
  servers.push(server);
  return server;
}

const tempDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'filmix-e2e-'));

describe('end-to-end: mobile API path', () => {
  it('downloads a movie at the plan cap', async () => {
    const server = await serve((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const done = (body: string | Buffer, headers: Record<string, string> = {}): void => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
        res.end(body);
      };
      if (url.pathname.endsWith('/check_update')) return done('{"version":"1.0"}');
      if (url.pathname.endsWith('/user_profile')) {
        return done(
          '{"user_id":"1","login":"u","is_pro":true,"is_pro_plus":true,"pro_date":1893456000}',
        );
      }
      if (url.pathname.includes('/post/')) {
        void fixture('post_movie.json').then((body) => done(body));
        return;
      }
      if (url.pathname.includes('/file/')) {
        return done('HELLO', { 'Content-Length': '5' });
      }
      res.writeHead(404);
      res.end();
    });

    const store = new MemoryStore();
    await store.save({
      deviceId: 'abcdef0123456789',
      token: 'tok',
      apiBase: `${server.url}/api/v2`,
    });

    const client = new Client({ apiBase: `${server.url}/api/v2`, tokenStore: store });

    // Pre-load the profile so the plan is Pro+ and the highest quality is allowed.
    const profile = await client.profile();
    expect(profile.plan()).toBe(Plan.ProPlus);
    expect(client.currentPlan()).toBe(Plan.ProPlus);

    const post = await client.getPost(12345);
    // Rewrite the embedded host so the test server receives the request.
    for (const movie of post.playerLinks.movie) {
      movie.link = movie.link.replace('https://cdn1.example.com', server.url);
    }

    const dst = path.join(await tempDir(), 'movie.mp4');
    await client.download({ post, destination: dst });
    expect(await readFile(dst, 'utf8')).toBe('HELLO');
  });

  it('derives the destination filename from the CDN URL', async () => {
    const server = await serve((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.includes('/post/')) {
        void fixture('post_movie.json').then((body) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(body);
        });
        return;
      }
      res.writeHead(200, { 'Content-Length': '2' });
      res.end('ok');
    });

    const client = new Client({ apiBase: `${server.url}/api/v2` });
    const post = await client.getPost(12345);
    for (const movie of post.playerLinks.movie) {
      movie.link = movie.link.replace('https://cdn1.example.com', server.url);
    }

    const dir = await tempDir();
    await client.download({ post, destination: dir + path.sep });
    // Guest cap (no profile loaded) is 480p, so the picked file is _480.mp4.
    expect(await readFile(path.join(dir, 'inter_dub_480.mp4'), 'utf8')).toBe('ok');
  });
});

describe('end-to-end: website path', () => {
  /**
   * When the alphabetically first translation offers only above-cap qualities
   * (typically a "HEVC 4K" dub), the next translation must be used instead:
   * "Dub HEVC 4K" has only 2160p, "Dub Normal" has 480p and 720p, and the
   * Free-cap path must download 720p from the latter.
   */
  it('skips a 4K-only translation and falls back to the next one', async () => {
    let encoded4K = '';
    let encodedHD = '';
    let hits720 = 0;
    let hits2160 = 0;

    const server = await serve((req, res) => {
      void readBody(req).then(() => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const p = url.pathname;
        const json = (body: string): void => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(body);
        };
        if (p.endsWith('/check_update')) return json('{"version":"1.0"}');
        if (p === '/') {
          res.writeHead(200);
          return res.end('<html></html>');
        }
        if (p.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          return res.end('AUTHORIZED');
        }
        if (p.startsWith('/play/')) {
          res.writeHead(200);
          return res.end('<html>page</html>');
        }
        if (p.endsWith('/api/movies/player-data')) {
          // Alphabetically "Dub HEVC 4K" < "Dub Normal", so the 4K-only
          // translation is tried first.
          return json(
            `{"type":"success","message":{"translations":{"video":{"Dub HEVC 4K":"${encoded4K}","Dub Normal":"${encodedHD}"},"trailers":{}}},"field":""}`,
          );
        }
        if (p.includes('/post/')) {
          // Minimal post: the site path only uses post.id.
          return json(
            '{"id":12345,"title":"M","year":2025,"section":0,"player_links":{"movie":[{"translation":"x","link":"https://x"}],"playlist":[],"trailer":[]}}',
          );
        }
        if (p.includes('movie_720.mp4')) {
          hits720++;
          res.writeHead(200, { 'Content-Length': '5' });
          return res.end('OK720');
        }
        if (p.includes('movie_2160.mp4')) {
          hits2160++;
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(404);
        res.end();
      });
    });

    encoded4K = encodeForTesting(`[4K UHD]${server.url}/movie_2160.mp4`);
    encodedHD = encodeForTesting(
      `[480p]${server.url}/movie_480.mp4,[720p]${server.url}/movie_720.mp4`,
    );

    const store = new MemoryStore();
    await store.save({ deviceId: 'abcdef0123456789', token: '', apiBase: `${server.url}/api/v2` });

    const client = new Client({
      apiBase: `${server.url}/api/v2`,
      mirror: server.url,
      tokenStore: store,
    });
    await client.loginByPassword('u', 'p');
    expect(client.siteClient()).toBeDefined();

    const post = await client.getPost(12345);
    const dst = path.join(await tempDir(), 'movie.mp4');
    await client.download({ post, destination: dst });

    expect(await readFile(dst, 'utf8')).toBe('OK720');
    expect(hits2160).toBe(0);
    expect(hits720).toBe(1);

    // The site session was persisted for the next process.
    const state = await store.load();
    expect(state.siteSession?.mirror).toBe(server.url);
  });

  it('falls back to the mobile path with a 480p cap when the site path fails', async () => {
    const requested: string[] = [];
    const server = await serve((req, res) => {
      void readBody(req).then(() => {
        const p = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        requested.push(p);
        if (p.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          return res.end('AUTHORIZED');
        }
        if (p.endsWith('/api/movies/player-data')) {
          // No translations at all: the site path gives up.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end('{"type":"success","message":{"translations":{"video":[]}}}');
        }
        if (p.includes('/post/')) {
          void fixture('post_movie.json').then((body) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(body);
          });
          return;
        }
        if (p.includes('/file/')) {
          res.writeHead(200, { 'Content-Length': '4' });
          return res.end('MP4!');
        }
        res.writeHead(200);
        res.end('<html></html>');
      });
    });

    const client = new Client({
      apiBase: `${server.url}/api/v2`,
      mirror: server.url,
    });
    await client.loginByPassword('u', 'p');

    const post = await client.getPost(12345);
    for (const movie of post.playerLinks.movie) {
      movie.link = movie.link.replace('https://cdn1.example.com', server.url);
    }
    const dst = path.join(await tempDir(), 'movie.mp4');
    await client.download({ post, destination: dst });

    expect(await readFile(dst, 'utf8')).toBe('MP4!');
    // Guest cap after a site failure → 480p, even though 1080p is listed.
    expect(requested.some((p) => p.includes('inter_dub_480.mp4'))).toBe(true);
  });

  it('propagates a rights-holder lock instead of falling back', async () => {
    const server = await serve((req, res) => {
      void readBody(req).then(() => {
        const p = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (p.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          return res.end('AUTHORIZED');
        }
        if (p.endsWith('/api/movies/player-data')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end('{"type":"success","message":{"translations":{"lv":true,"video":[]}}}');
        }
        if (p.includes('/post/')) {
          void fixture('post_movie.json').then((body) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(body);
          });
          return;
        }
        res.writeHead(200);
        res.end('<html></html>');
      });
    });

    const client = new Client({ apiBase: `${server.url}/api/v2`, mirror: server.url });
    await client.loginByPassword('u', 'p');
    const post = await client.getPost(12345);
    const err = await client
      .download({ post, destination: path.join(await tempDir(), 'x.mp4') })
      .catch((e: unknown) => e);
    expect(isErrorOfType(err, ContentLockedError)).toBe(true);
  });

  it('restores a persisted site session on bootstrap', async () => {
    const server = await serve((req, res) => {
      void readBody(req).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"version":"1.0"}');
      });
    });

    const store = new MemoryStore();
    await store.save({
      deviceId: 'abcdef0123456789',
      token: '',
      apiBase: `${server.url}/api/v2`,
      siteSession: { mirror: server.url, cookies: [{ name: 'session', value: 'abc' }] },
    });

    const client = new Client({
      apiBase: `${server.url}/api/v2`,
      mirror: server.url,
      tokenStore: store,
    });
    // Bootstrap runs lazily on the first call.
    await client.search('x').catch(() => undefined);
    expect(client.siteClient()).toBeDefined();
    expect(client.siteAuth()?.authorized()).toBe(true);
  });
});

describe('bootstrap', () => {
  it('discovers the API host and caches it in the token store', async () => {
    const server = await serve((req, res) => {
      const p = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(p.endsWith('/check_update') ? '{"version":"1.0"}' : '[]');
    });

    const store = new MemoryStore();
    const client = new Client({
      apiFallbacks: ['http://127.0.0.1:1/api/v2', `${server.url}/api/v2`],
      tokenStore: store,
    });
    await client.search('x');

    const state = await store.load();
    expect(state.apiBase).toBe(`${server.url}/api/v2`);
    expect(state.deviceId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reports a bootstrap failure and caches it', async () => {
    const store = new MemoryStore();
    const client = new Client({ apiFallbacks: ['http://127.0.0.1:1/api/v2'], tokenStore: store });
    await expect(client.search('x')).rejects.toThrow(/no working API host/);
    await expect(client.getPost(1)).rejects.toThrow(/no working API host/);
  });

  it('rejects a download without a post', async () => {
    const client = new Client({ apiBase: 'http://127.0.0.1:1/api/v2' });
    // @ts-expect-error — exercising the runtime guard for JS callers.
    await expect(client.download({})).rejects.toThrow(/post is required/);
    // @ts-expect-error — same guard on the activation helper.
    await expect(client.waitForActivation(undefined, 2000)).rejects.toThrow(
      /PendingAuth is required/,
    );
  });
});
