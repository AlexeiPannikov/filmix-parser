/** End-to-end facade behaviour: bootstrap, auth and CDN-link resolution. */
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

/** Serves the mobile API endpoints used by the resolver. */
async function mobileApi(postFixture = 'post_movie.json'): Promise<TestServer> {
  return await serve((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (body: string): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    };
    if (url.pathname.endsWith('/check_update')) return json('{"version":"1.0"}');
    if (url.pathname.endsWith('/user_profile')) {
      return json('{"user_id":"1","login":"u","is_pro":true,"is_pro_plus":true,"pro_date":1893456000}');
    }
    if (url.pathname.includes('/post/')) {
      void fixture(postFixture).then(json);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

describe('resolveLinks — mobile API path', () => {
  it('substitutes every advertised quality into the link template', async () => {
    const server = await mobileApi();
    const client = new Client({ apiBase: `${server.url}/api/v2` });
    const post = await client.getPost(12345);

    const links = await client.resolveLinks({ post });
    expect(links.source).toBe('mobile');
    expect(links.translations.map((t) => t.translation)).toEqual([
      'Дубляж (Кубик в кубе)',
      'Оригинал (EN)',
    ]);

    const dub = links.translations[0]!;
    expect([...dub.urls.keys()].sort((a, b) => a - b)).toEqual([480, 720, 1080]);
    expect(dub.urls.get(720)).toBe('https://cdn1.example.com/file/inter_dub_720.mp4');
    expect(links.translations[1]!.urls.get(2160)).toBe(
      'https://cdn1.example.com/file/inter_orig_2160.mp4',
    );
  });

  it('applies no quality cap regardless of the plan', async () => {
    const server = await mobileApi();
    const client = new Client({ apiBase: `${server.url}/api/v2` });
    const post = await client.getPost(12345);

    expect(client.currentPlan()).toBe(Plan.Guest);
    const guest = await client.resolveLinks({ post });
    expect(guest.translations[1]!.urls.has(2160)).toBe(true);

    await client.profile();
    expect(client.currentPlan()).toBe(Plan.ProPlus);
    const pro = await client.resolveLinks({ post });
    expect([...pro.translations[1]!.urls.keys()].length).toBe(5);
  });

  it('limits the result to one translation on request', async () => {
    const server = await mobileApi();
    const client = new Client({ apiBase: `${server.url}/api/v2` });
    const post = await client.getPost(12345);

    const links = await client.resolveLinks({ post, translation: 'Оригинал (EN)' });
    expect(links.translations).toHaveLength(1);
    expect(links.translations[0]!.translation).toBe('Оригинал (EN)');
  });

  it('throws for an unknown explicit translation', async () => {
    const server = await mobileApi();
    const client = new Client({ apiBase: `${server.url}/api/v2` });
    const post = await client.getPost(12345);
    await expect(client.resolveLinks({ post, translation: 'nope' })).rejects.toThrow(
      /translation not found/,
    );
  });

  it('resolves one episode of a series and skips dubs without that season', async () => {
    const server = await mobileApi('post_series_dict.json');
    const client = new Client({ apiBase: `${server.url}/api/v2` });
    const post = await client.getPost(67890);

    const s1 = await client.resolveLinks({ post, season: 1, episode: 2 });
    expect(s1.translations.map((t) => t.translation)).toEqual([
      'Дубляж (Невафильм)',
      'Оригинал (EN)',
    ]);
    expect(s1.translations[0]!.urls.get(1080)).toBe(
      'https://cdn2.example.com/st/s1e2_neva_1080.mp4',
    );

    // Season 2 exists only for the dub; the other translation is skipped.
    const s2 = await client.resolveLinks({ post, season: 2, episode: 1 });
    expect(s2.translations.map((t) => t.translation)).toEqual(['Дубляж (Невафильм)']);

    // A missing episode yields no translations at all.
    const missing = await client.resolveLinks({ post, season: 1, episode: 99 });
    expect(missing.translations).toEqual([]);
  });

  it('rewrites the livehash prefix when enabled', async () => {
    const server = await serve((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (url.pathname.endsWith('/post/171042')) {
        res.end('{"player_links":{"movie":[{"link":"https://cdn/s/freshhash/x_[720].mp4"}]}}');
        return;
      }
      res.end(
        '{"id":1,"player_links":{"movie":[{"translation":"Dub","link":"https://cdn/s/stale/movie_[720,480].mp4"}]}}',
      );
    });

    const client = new Client({ apiBase: `${server.url}/api/v2`, livehash: true });
    const post = await client.getPost(1);
    const links = await client.resolveLinks({ post });
    expect(links.translations[0]!.urls.get(720)).toBe('https://cdn/s/freshhash/movie_720.mp4');
  });
});

describe('resolveLinks — website path', () => {
  /** Serves login, warm-up, player-data, the post and two #2 manifests. */
  async function siteServer(): Promise<{ server: TestServer; manifestHits: () => number }> {
    let hits = 0;
    const server = await serve((req, res) => {
      void readBody(req).then(() => {
        const p = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        const json = (body: string): void => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(body);
        };
        if (p.endsWith('/check_update')) return json('{"version":"1.0"}');
        if (p.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          return res.end('AUTHORIZED');
        }
        if (p.endsWith('/api/movies/player-data')) {
          const hd = encodeForTesting(`${server.url}/pl/hd.txt`);
          const uhd = encodeForTesting(`${server.url}/pl/uhd.txt`);
          return json(
            `{"type":"success","message":{"translations":{"video":{"Dub HEVC 4K":"${uhd}","Dub Normal":"${hd}"},"trailers":{}}},"field":""}`,
          );
        }
        if (p === '/pl/hd.txt' || p === '/pl/uhd.txt') {
          hits++;
          const file =
            p === '/pl/uhd.txt'
              ? '[4K UHD]https://cdn/uhd_2160.mp4'
              : '[480p]https://cdn/hd_480.mp4,[720p]https://cdn/hd_720.mp4';
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end(encodeForTesting(JSON.stringify([{ id: 'm1', title: 'M', file }])));
        }
        if (p.includes('/post/')) {
          return json(
            '{"id":12345,"title":"M","year":2025,"section":0,"player_links":{"movie":[{"translation":"x","link":"https://x/v_[480].mp4"}],"playlist":[],"trailer":[]}}',
          );
        }
        res.writeHead(200);
        res.end('<html>page</html>');
      });
    });
    return { server, manifestHits: () => hits };
  }

  it('decodes a manifest per translation, keeping above-cap qualities', async () => {
    const { server, manifestHits } = await siteServer();
    const store = new MemoryStore();
    const client = new Client({
      apiBase: `${server.url}/api/v2`,
      mirror: server.url,
      tokenStore: store,
    });
    await client.loginByPassword('u', 'p');
    expect(client.siteClient()).toBeDefined();

    const post = await client.getPost(12345);
    const links = await client.resolveLinks({ post });

    expect(links.source).toBe('site');
    expect(manifestHits()).toBe(2);
    expect(links.translations.map((t) => t.translation)).toEqual(['Dub HEVC 4K', 'Dub Normal']);
    expect(links.translations[0]!.urls.get(2160)).toBe('https://cdn/uhd_2160.mp4');
    expect(links.translations[1]!.urls.get(720)).toBe('https://cdn/hd_720.mp4');

    // The site session was persisted for the next process.
    expect((await store.load()).siteSession?.mirror).toBe(server.url);
  });

  it('falls back to the mobile path when player-data is empty', async () => {
    const server = await serve((req, res) => {
      void readBody(req).then(() => {
        const p = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (p.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          return res.end('AUTHORIZED');
        }
        if (p.endsWith('/api/movies/player-data')) {
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
        res.writeHead(200);
        res.end('<html></html>');
      });
    });

    const client = new Client({ apiBase: `${server.url}/api/v2`, mirror: server.url });
    await client.loginByPassword('u', 'p');
    const post = await client.getPost(12345);

    const links = await client.resolveLinks({ post });
    expect(links.source).toBe('mobile');
    expect(links.translations).toHaveLength(2);
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
    const err = await client.resolveLinks({ post }).catch((e: unknown) => e);
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
    const client = new Client({ apiFallbacks: ['http://127.0.0.1:1/api/v2'] });
    await expect(client.search('x')).rejects.toThrow(/no working API host/);
    await expect(client.getPost(1)).rejects.toThrow(/no working API host/);
  });

  it('guards the public entry points against missing arguments', async () => {
    const client = new Client({ apiBase: 'http://127.0.0.1:1/api/v2' });
    // @ts-expect-error — exercising the runtime guard for JS callers.
    await expect(client.resolveLinks({})).rejects.toThrow(/post is required/);
    // @ts-expect-error — same guard on the activation helper.
    await expect(client.waitForActivation(undefined, 2000)).rejects.toThrow(
      /PendingAuth is required/,
    );
  });
});
