import { afterEach, describe, expect, it } from 'vitest';
import type http from 'node:http';
import { createGotScrapingFetch } from '../src/net/got-scraping.js';
import { startServer, readBody, type TestServer } from './helpers/server.js';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve(handler: http.RequestListener): Promise<string> {
  server = await startServer(handler);
  return server.url;
}

describe('createGotScrapingFetch', () => {
  it('GETs and forwards status, body and headers', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'X-Custom': 'yes' });
      res.end('hello');
    });
    const fetch = await createGotScrapingFetch();
    const res = await fetch(url, { headers: new Headers({ Accept: '*/*' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-custom')).toBe('yes');
    expect(await res.text()).toBe('hello');
  });

  it('generates a browser User-Agent when the caller sets none', async () => {
    let seen = '';
    const url = await serve((req, res) => {
      seen = String(req.headers['user-agent'] ?? '');
      res.end('ok');
    });
    const fetch = await createGotScrapingFetch();
    await (await fetch(url)).text();
    expect(seen).toMatch(/Mozilla\/5\.0/);
  });

  it('pins one generated fingerprint for the life of the adapter', async () => {
    const seen: string[] = [];
    const url = await serve((req, res) => {
      seen.push(String(req.headers['user-agent'] ?? ''));
      res.end('ok');
    });
    const fetch = await createGotScrapingFetch();
    // Many requests through one adapter must all carry the same generated UA —
    // a rotating fingerprint would break cookie-bound sessions (the 403 flake).
    for (let i = 0; i < 4; i++) await (await fetch(url)).text();
    expect(seen).toHaveLength(4);
    expect(seen[0]).toMatch(/Mozilla\/5\.0/);
    expect(new Set(seen).size).toBe(1);
  });

  it('does not follow redirects and exposes Location + Set-Cookie', async () => {
    const url = await serve((req, res) => {
      if (req.url === '/to') {
        res.writeHead(302, { Location: '/dest', 'Set-Cookie': ['a=1', 'b=2'] });
        res.end('');
        return;
      }
      res.writeHead(200);
      res.end('FOLLOWED');
    });
    const fetch = await createGotScrapingFetch();
    const res = await fetch(`${url}/to`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dest');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('sends a POST body', async () => {
    let body = '';
    const url = await serve((req, res) => {
      void readBody(req).then((b) => {
        body = b;
        res.end('stored');
      });
    });
    const fetch = await createGotScrapingFetch();
    const res = await fetch(url, {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: 'post_id=42&showfull=true',
    });
    expect(await res.text()).toBe('stored');
    expect(body).toBe('post_id=42&showfull=true');
  });

  it('flushes a bodyless POST (manual stream.end)', async () => {
    const url = await serve((_req, res) => res.end('done'));
    const fetch = await createGotScrapingFetch();
    const res = await fetch(url, { method: 'POST' });
    expect(await res.text()).toBe('done');
  });
});
