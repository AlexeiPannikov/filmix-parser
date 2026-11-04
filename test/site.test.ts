import { afterEach, describe, expect, it } from 'vitest';
import { PasswordAuthenticator } from '../src/auth/password.js';
import { SiteClient, mirrorFromUrl, sameHost } from '../src/site/client.js';
import { encodeForTesting } from '../src/site/decoder.js';
import { HttpClient } from '../src/internal/http.js';
import {
  ContentLockedError,
  HttpStatusError,
  NotAuthorizedError,
  PlayerDataEmptyError,
  isErrorOfType,
} from '../src/errors.js';
import { readBody, startServer, type TestServer } from './helpers/server.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(handler: Parameters<typeof startServer>[0]): Promise<TestServer> {
  const server = await startServer(handler);
  servers.push(server);
  return server;
}

/** A PasswordAuthenticator already logged into `mirror`. */
async function fakeAuth(mirror: string): Promise<PasswordAuthenticator> {
  const auth = new PasswordAuthenticator({
    http: new HttpClient({ timeoutMs: 5000 }),
    mirror,
  });
  await auth.login('u', 'p');
  return auth;
}

const MOVIE_PLAYER_DATA =
  '{"type":"success","message":{"translations":{"video":{"Дубляж":"#2encA","Оригинал":"#2encB"},"trailers":{}}},"field":""}';

describe('SiteClient.playerData', () => {
  it('requires an authorised session', async () => {
    const auth = new PasswordAuthenticator({ mirror: 'http://example.invalid' });
    const client = new SiteClient(auth);
    await expect(client.playerData(1, '')).rejects.toThrow(NotAuthorizedError);
    await expect(client.fetchPlaylist('#2x')).rejects.toThrow(NotAuthorizedError);
  });

  it('warms up the post page, posts the id, and parses the translations', async () => {
    const seen: { path: string; body: string; referer: string }[] = [];
    const mirror = await serve((req, res) => {
      void readBody(req).then((body) => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        seen.push({ path, body, referer: String(req.headers.referer ?? '') });
        if (path.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          res.end('AUTHORIZED');
        } else if (path.endsWith('/api/movies/player-data')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(MOVIE_PLAYER_DATA);
        } else {
          res.writeHead(200);
          res.end('<html>page</html>');
        }
      });
    });

    const client = new SiteClient(await fakeAuth(mirror.url));
    const pd = await client.playerData(12345, '');
    expect(pd.locked).toBe(false);
    expect(pd.video.size).toBe(2);
    expect(pd.video.get('Дубляж')).toBe('#2encA');

    const warmUp = seen.find((s) => s.path.startsWith('/play/'));
    expect(warmUp?.path).toBe('/play/12345');
    const post = seen.find((s) => s.path.endsWith('/api/movies/player-data'));
    expect(post?.body).toContain('post_id=12345');
    expect(post?.body).toContain('showfull=true');
    expect(post?.referer).toBe(`${mirror.url}/play/12345`);
  });

  it('uses the post-redirect URL as the Referer', async () => {
    let referer = '';
    const mirror = await serve((req, res) => {
      void readBody(req).then(() => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (path.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          res.end('AUTHORIZED');
        } else if (path.startsWith('/play/')) {
          res.writeHead(302, { Location: '/film/drama/12345-canonical.html' });
          res.end();
        } else if (path.endsWith('/api/movies/player-data')) {
          referer = String(req.headers.referer ?? '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(MOVIE_PLAYER_DATA);
        } else {
          res.writeHead(200);
          res.end('<html>canonical page</html>');
        }
      });
    });

    const client = new SiteClient(await fakeAuth(mirror.url));
    await client.playerData(12345, '');
    expect(referer).toBe(`${mirror.url}/film/drama/12345-canonical.html`);
  });

  it('reports a takedown as ContentLockedError', async () => {
    const mirror = await serve((req, res) => {
      void readBody(req).then(() => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (path.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          res.end('AUTHORIZED');
        } else if (path.endsWith('/api/movies/player-data')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            '{"type":"success","message":{"translations":{"lv":true,"video":[],"trailers":[]}},"field":""}',
          );
        } else {
          res.writeHead(200);
          res.end('<html>page</html>');
        }
      });
    });

    const client = new SiteClient(await fakeAuth(mirror.url));
    await expect(client.playerData(1, '')).rejects.toThrow(ContentLockedError);
  });

  it('reports an empty video map as PlayerDataEmptyError', async () => {
    const mirror = await serve((req, res) => {
      void readBody(req).then(() => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (path.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          res.end('AUTHORIZED');
        } else if (path.endsWith('/api/movies/player-data')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"type":"success","message":{"translations":{"video":[],"trailers":[]}}}');
        } else {
          res.writeHead(200);
          res.end('<html>page</html>');
        }
      });
    });

    const client = new SiteClient(await fakeAuth(mirror.url));
    const err = await client.playerData(1, '').catch((e: unknown) => e);
    expect(isErrorOfType(err, PlayerDataEmptyError)).toBe(true);
  });

  it('fails when the warm-up GET does not return 200', async () => {
    const mirror = await serve((req, res) => {
      void readBody(req).then(() => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (path.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          res.end('AUTHORIZED');
        } else if (path.startsWith('/play/')) {
          res.writeHead(403);
          res.end('denied');
        } else {
          res.writeHead(200);
          res.end('<html></html>');
        }
      });
    });

    const client = new SiteClient(await fakeAuth(mirror.url));
    await expect(client.playerData(1, '')).rejects.toThrow(/warm up post page/);
  });

  it('surfaces a non-200 player-data response', async () => {
    const mirror = await serve((req, res) => {
      void readBody(req).then(() => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (path.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          res.end('AUTHORIZED');
        } else if (path.endsWith('/api/movies/player-data')) {
          res.writeHead(403);
          res.end('forbidden');
        } else {
          res.writeHead(200);
          res.end('<html>page</html>');
        }
      });
    });

    const client = new SiteClient(await fakeAuth(mirror.url));
    const err = await client.playerData(1, '').catch((e: unknown) => e);
    expect(isErrorOfType(err, HttpStatusError)).toBe(true);
  });
});

describe('SiteClient.fetchPlaylist', () => {
  it('fetches and decodes the two-layer manifest', async () => {
    const manifest = JSON.stringify([
      {
        title: ' Сезон 1',
        folder: [
          { id: 's1e1', title: 'Серия 1', file: '[480p]https://cdn/s1e1_480.mp4,[720p]https://cdn/s1e1_720.mp4' },
        ],
      },
    ]);
    let manifestHits = 0;
    const mirror = await serve((req, res) => {
      void readBody(req).then(() => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (path.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          res.end('AUTHORIZED');
        } else if (path === '/pl/manifest.txt') {
          manifestHits++;
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(encodeForTesting(manifest));
        } else {
          res.writeHead(200);
          res.end('<html></html>');
        }
      });
    });

    const client = new SiteClient(await fakeAuth(mirror.url));
    const playlist = await client.fetchPlaylist(
      encodeForTesting(`${mirror.url}/pl/manifest.txt`),
    );
    expect(manifestHits).toBe(1);
    expect(playlist.seasons?.get(1)?.[0]?.qualities.get(720)).toBe('https://cdn/s1e1_720.mp4');
  });

  /**
   * The 4K-HEVC case: the encoded video link decodes straight to a
   * "[label]URL,..." file field rather than a manifest URL. The shortcut must
   * build a movie playlist without attempting a manifest fetch.
   */
  it('short-circuits a decoded file field without an HTTP fetch', async () => {
    const fileField =
      '[4K UHD]https://nl210.example/HEVC/movie_2160.mp4,[1080p]https://nl210.example/HEVC/movie_1080.mp4';
    let nonAuthHits = 0;
    const mirror = await serve((req, res) => {
      void readBody(req).then(() => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (path.endsWith('/engine/ajax/user_auth.php')) {
          res.writeHead(200);
          res.end('AUTHORIZED');
        } else if (path === '/') {
          res.writeHead(200);
          res.end('<html></html>');
        } else {
          nonAuthHits++;
          res.writeHead(404);
          res.end();
        }
      });
    });

    const client = new SiteClient(await fakeAuth(mirror.url));
    const playlist = await client.fetchPlaylist(encodeForTesting(fileField));
    expect(playlist.movie?.qualities.get(2160)).toBe('https://nl210.example/HEVC/movie_2160.mp4');
    expect(playlist.movie?.qualities.get(1080)).toBe('https://nl210.example/HEVC/movie_1080.mp4');
    expect(nonAuthHits).toBe(0);
  });

  it('rejects a decoded file field with no recognised qualities', async () => {
    const mirror = await serve((req, res) => {
      void readBody(req).then(() => {
        res.writeHead(200);
        res.end((req.url ?? '').includes('user_auth') ? 'AUTHORIZED' : '<html></html>');
      });
    });
    const client = new SiteClient(await fakeAuth(mirror.url));
    await expect(
      client.fetchPlaylist(encodeForTesting('[HD]https://cdn/x.mp4')),
    ).rejects.toThrow(/no recognised qualities/);
  });

  it('wraps a decode failure of the video link', async () => {
    const mirror = await serve((req, res) => {
      void readBody(req).then(() => {
        res.writeHead(200);
        res.end((req.url ?? '').includes('user_auth') ? 'AUTHORIZED' : '<html></html>');
      });
    });
    const client = new SiteClient(await fakeAuth(mirror.url));
    await expect(client.fetchPlaylist('#2notreallyencoded')).rejects.toThrow(
      /decode video link/,
    );
  });
});

describe('URL helpers', () => {
  it('extracts scheme://host or undefined', () => {
    expect(mirrorFromUrl('https://filmix.my/film/1-x.html')).toBe('https://filmix.my');
    expect(mirrorFromUrl('')).toBeUndefined();
    expect(mirrorFromUrl('/relative/path')).toBeUndefined();
    expect(mirrorFromUrl('not a url')).toBeUndefined();
  });

  it('compares hosts', () => {
    expect(sameHost('https://filmix.my/a', 'https://filmix.my')).toBe(true);
    expect(sameHost('https://other.example/a', 'https://filmix.my')).toBe(false);
    expect(sameHost('nonsense', 'https://filmix.my')).toBe(false);
  });
});
