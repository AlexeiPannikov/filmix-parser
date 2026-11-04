import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Downloader, parseContentRange } from '../src/download/downloader.js';
import { HttpClient } from '../src/internal/http.js';
import { DownloadError, HttpStatusError, isErrorOfType } from '../src/errors.js';
import { startServer, type TestServer } from './helpers/server.js';
import { rangeAwareHandler } from './helpers/range-server.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(handler: Parameters<typeof startServer>[0]): Promise<TestServer> {
  const server = await startServer(handler);
  servers.push(server);
  return server;
}

function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'filmix-dl-'));
}

function newDownloader(): Downloader {
  return new Downloader(new HttpClient({ timeoutMs: 10_000 }));
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('Downloader.do', () => {
  it('streams a payload to disk and reports progress', async () => {
    const payload = Buffer.from('X'.repeat(200_000));
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(payload.length) });
      res.end(payload);
    });

    const dst = path.join(await tempDir(), 'out.mp4');
    let lastDownloaded = 0;
    let lastTotal = 0;
    await newDownloader().do({
      url: server.url,
      destination: dst,
      progress: (downloaded, total) => {
        lastDownloaded = downloaded;
        lastTotal = total;
      },
    });

    expect((await stat(dst)).size).toBe(payload.length);
    expect(await exists(`${dst}.part`)).toBe(false);
    expect(lastDownloaded).toBe(payload.length);
    expect(lastTotal).toBe(payload.length);
  });

  it('leaves no destination file when the transfer is aborted', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': '10000000' });
      res.write('hello');
      void held.then(() => res.end());
    });

    const dst = path.join(await tempDir(), 'out.mp4');
    const controller = new AbortController();
    const promise = newDownloader().do({
      url: server.url,
      destination: dst,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    await expect(promise).rejects.toThrow();
    expect(await exists(dst)).toBe(false);
    release?.();
  });

  it('fails on a non-2xx response', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(403);
      res.end();
    });
    const dst = path.join(await tempDir(), 'out.mp4');
    const err = await newDownloader()
      .do({ url: server.url, destination: dst })
      .catch((e: unknown) => e);
    expect(isErrorOfType(err, HttpStatusError)).toBe(true);
    expect(await exists(dst)).toBe(false);
  });

  it('rejects empty url and destination', async () => {
    const d = newDownloader();
    await expect(d.do({ url: '', destination: '/tmp/x' })).rejects.toThrow(DownloadError);
    await expect(d.do({ url: 'http://example.com', destination: '' })).rejects.toThrow(
      DownloadError,
    );
  });

  it('reports total = -1 when the server sends no Content-Length', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      res.end('abc');
    });
    const dst = path.join(await tempDir(), 'out.mp4');
    const totals: number[] = [];
    await newDownloader().do({
      url: server.url,
      destination: dst,
      progress: (_d, total) => totals.push(total),
    });
    expect(totals).toContain(-1);
    expect(await readFile(dst, 'utf8')).toBe('abc');
  });

  it('forwards custom request headers', async () => {
    let seen = '';
    const server = await serve((req, res) => {
      seen = String(req.headers['x-custom'] ?? '');
      res.writeHead(200, { 'Content-Length': '2' });
      res.end('ok');
    });
    const dst = path.join(await tempDir(), 'out.mp4');
    await newDownloader().do({
      url: server.url,
      destination: dst,
      headers: { 'X-Custom': 'yes' },
    });
    expect(seen).toBe('yes');
  });

  it('overwrites an existing destination file', async () => {
    const payload = Buffer.from('fresh');
    const server = await serve(rangeAwareHandler(payload));
    const dir = await tempDir();
    const dst = path.join(dir, 'out.mp4');
    await writeFile(dst, 'stale');
    await newDownloader().do({ url: server.url, destination: dst });
    expect(await readFile(dst, 'utf8')).toBe('fresh');
  });
});

describe('parseContentRange', () => {
  it.each([
    ['bytes 0-99/200', { start: 0, end: 99, total: 200 }],
    ['bytes 100-199/200', { start: 100, end: 199, total: 200 }],
    ['bytes 0-99/*', { start: 0, end: 99, total: -1 }],
    ['', undefined],
    ['items 0-99/200', undefined],
    ['bytes 0-99', undefined],
    ['bytes 0/99/200', undefined],
    ['bytes abc-99/200', undefined],
  ])('parseContentRange(%j)', (input, want) => {
    expect(parseContentRange(input)).toEqual(want);
  });
});
