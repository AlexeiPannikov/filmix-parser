import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/client/api.js';
import { LivehashCache } from '../src/client/livehash.js';
import { HttpClient } from '../src/internal/http.js';
import { startServer, type TestServer } from './helpers/server.js';

const device = { name: 'go-filmix', vendor: 'Xiaomi', os: '11', apk: '2.0.9' };

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('LivehashCache', () => {
  it('finds the hash in a body whose slashes are JSON-escaped', async () => {
    // How the real API serializes it. The hand-written fixture below uses plain
    // slashes, which is why a regex that only matched `/s/` looked fine in
    // tests while returning "" against production for every post.
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        '{"id":"171042","player_links":{"movie":[{"translation":"Default","link":"https:\\/\\/cdn.example.com\\/s\\/abc123def\\/file_[1080,720,480].mp4"}]}}',
      );
    });

    const api = new ApiClient({
      http: new HttpClient({ timeoutMs: 5000 }),
      device,
      apiBase: `${server.url}/api/v2`,
      deviceId: 'abcd',
      token: 'tok',
    });
    const cache = new LivehashCache(api);
    expect(await cache.get()).toBe('abc123def');
    expect(await cache.applyToUrl('https://cdn.example.com/s/stale/x.mp4')).toBe(
      'https://cdn.example.com/s/abc123def/x.mp4',
    );
  });

  it('fetches the hash once and reuses it', async () => {
    let hits = 0;
    const paths: string[] = [];
    server = await startServer((req, res) => {
      hits++;
      paths.push(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        '{"id":"171042","title":"Reference","player_links":{"movie":[{"translation":"Default","link":"https://cdn.example.com/s/abc123def/file_[1080,720,480].mp4"}]}}',
      );
    });

    const api = new ApiClient({
      http: new HttpClient({ timeoutMs: 5000 }),
      device,
      apiBase: `${server.url}/api/v2`,
      deviceId: 'abcd',
      token: 'tok',
    });
    const cache = new LivehashCache(api);

    expect(await cache.get()).toBe('abc123def');
    expect(await cache.get()).toBe('abc123def');
    expect(hits).toBe(1);
    expect(paths[0]).toBe('/api/v2/post/171042');

    expect(await cache.applyToUrl('https://cdn.example.com/s/oldhash/film_[1080,720].mp4')).toBe(
      'https://cdn.example.com/s/abc123def/film_[1080,720].mp4',
    );

    const plain = 'https://cdn.example.com/film_[1080,720].mp4';
    expect(await cache.applyToUrl(plain)).toBe(plain);
    expect(hits).toBe(1);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    let hits = 0;
    server = await startServer((_req, res) => {
      hits++;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"player_links":{"movie":[{"link":"https://cdn/s/xyz789/f_[720].mp4"}]}}');
      }, 30);
    });

    const api = new ApiClient({
      http: new HttpClient({ timeoutMs: 5000 }),
      device,
      apiBase: `${server.url}/api/v2`,
    });
    const cache = new LivehashCache(api);
    const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect([a, b, c]).toEqual(['xyz789', 'xyz789', 'xyz789']);
    expect(hits).toBe(1);
  });

  it('returns an empty hash when the response has no /s/ segment', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"player_links":{"movie":[{"link":"https://cdn.example.com/file_[720].mp4"}]}}');
    });
    const api = new ApiClient({
      http: new HttpClient({ timeoutMs: 5000 }),
      device,
      apiBase: `${server.url}/api/v2`,
      deviceId: 'x',
    });
    const cache = new LivehashCache(api);
    expect(await cache.get()).toBe('');
  });

  it('leaves the URL unchanged when the fetch fails', async () => {
    const api = new ApiClient({
      http: new HttpClient({ timeoutMs: 2000 }),
      device,
      apiBase: 'http://127.0.0.1:1/api/v2',
    });
    const cache = new LivehashCache(api);
    const url = 'https://cdn/s/old/f_720.mp4';
    expect(await cache.applyToUrl(url)).toBe(url);
  });
});
