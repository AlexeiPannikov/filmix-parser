/** Resume, Range and partial-file isolation (port of `download/resume_test.go`). */
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Downloader } from '../src/download/downloader.js';
import { HttpClient } from '../src/internal/http.js';
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

const tempDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'filmix-resume-'));
const newDownloader = (): Downloader => new Downloader(new HttpClient({ timeoutMs: 10_000 }));

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('resume', () => {
  it('resumes from an existing partial file', async () => {
    const payload = Buffer.from('ABCDEFGH'.repeat(25_000)); // 200 000 bytes
    const counter = { rangeRequests: 0 };
    const server = await serve(rangeAwareHandler(payload, counter));

    const dst = path.join(await tempDir(), 'out.mp4');
    const partialSize = 80_000;
    await writeFile(`${dst}.part`, payload.subarray(0, partialSize));

    let firstProgress = -1;
    await newDownloader().do({
      url: server.url,
      destination: dst,
      progress: (downloaded) => {
        if (firstProgress === -1) firstProgress = downloaded;
      },
    });

    expect((await readFile(dst)).equals(payload)).toBe(true);
    expect(counter.rangeRequests).toBe(1);
    // The first tick must already include the bytes on disk, or progress UIs
    // jump backwards.
    expect(firstProgress).toBeGreaterThan(partialSize);
    expect(await exists(`${dst}.part`)).toBe(false);
  });

  it('sends no Range request when there is no partial file', async () => {
    const counter = { rangeRequests: 0 };
    const server = await serve(rangeAwareHandler(Buffer.from('x'.repeat(1000)), counter));
    const dst = path.join(await tempDir(), 'out.mp4');
    await newDownloader().do({ url: server.url, destination: dst });
    expect(counter.rangeRequests).toBe(0);
  });

  it('discards a stale partial when the server ignores Range', async () => {
    const payload = Buffer.from('Y'.repeat(5000));
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(payload.length) });
      res.end(payload);
    });
    const dst = path.join(await tempDir(), 'out.mp4');
    await writeFile(`${dst}.part`, 'garbage data');

    await newDownloader().do({ url: server.url, destination: dst });
    expect((await readFile(dst)).equals(payload)).toBe(true);
  });

  it('restarts without Range after a 416', async () => {
    const payload = Buffer.from('Z'.repeat(3000));
    let rangeReqs = 0;
    let plainReqs = 0;
    const server = await serve((req, res) => {
      if (req.headers.range !== undefined) {
        rangeReqs++;
        res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` });
        res.end();
        return;
      }
      plainReqs++;
      res.writeHead(200, { 'Content-Length': String(payload.length) });
      res.end(payload);
    });

    const dst = path.join(await tempDir(), 'out.mp4');
    await writeFile(`${dst}.part`, Buffer.from('X'.repeat(99_999)));

    await newDownloader().do({ url: server.url, destination: dst });
    expect(rangeReqs).toBe(1);
    expect(plainReqs).toBe(1);
    expect((await readFile(dst)).equals(payload)).toBe(true);
  });

  it('restarts when a 206 claims an offset of 0', async () => {
    const payload = Buffer.from('Q'.repeat(2000));
    const server = await serve((req, res) => {
      if (req.headers.range !== undefined) {
        // Lie: claim we resumed from 0 even though the client asked otherwise.
        res.writeHead(206, {
          'Content-Range': `bytes 0-${payload.length - 1}/${payload.length}`,
          'Content-Length': String(payload.length),
        });
        res.end(payload);
        return;
      }
      res.writeHead(200, { 'Content-Length': String(payload.length) });
      res.end(payload);
    });

    const dst = path.join(await tempDir(), 'out.mp4');
    await writeFile(`${dst}.part`, Buffer.from('A'.repeat(500)));
    await newDownloader().do({ url: server.url, destination: dst });
    expect((await readFile(dst)).equals(payload)).toBe(true);
  });

  /**
   * The worst case: a 206 whose start offset is neither 0 nor the requested
   * one. Writing that body into a truncated file would silently drop the first
   * `serverStart` bytes.
   */
  it('restarts when a 206 claims an unrelated non-zero offset', async () => {
    const payload = Buffer.from('M'.repeat(4000));
    const serverStart = 100;
    let rangeReqs = 0;
    let plainReqs = 0;
    const server = await serve((req, res) => {
      if (req.headers.range !== undefined) {
        rangeReqs++;
        res.writeHead(206, {
          'Content-Range': `bytes ${serverStart}-${payload.length - 1}/${payload.length}`,
          'Content-Length': String(payload.length - serverStart),
        });
        res.end(payload.subarray(serverStart));
        return;
      }
      plainReqs++;
      res.writeHead(200, { 'Content-Length': String(payload.length) });
      res.end(payload);
    });

    const dst = path.join(await tempDir(), 'out.mp4');
    await writeFile(`${dst}.part`, Buffer.from('X'.repeat(1500)));

    await newDownloader().do({ url: server.url, destination: dst });
    expect(rangeReqs).toBe(1);
    expect(plainReqs).toBe(1);
    expect((await readFile(dst)).equals(payload)).toBe(true);
    expect(await exists(`${dst}.part`)).toBe(false);
  });

  it('ignores a partial written for a different quality', async () => {
    const payload = Buffer.from('7'.repeat(4000));
    const counter = { rangeRequests: 0 };
    const server = await serve(rangeAwareHandler(payload, counter));

    const dst = path.join(await tempDir(), 'out.mp4');
    const stale480 = Buffer.from('4'.repeat(1500));
    await writeFile(`${dst}.part_480p`, stale480);

    await newDownloader().do({ url: server.url, destination: dst, quality: 720 });
    expect(counter.rangeRequests).toBe(0);
    expect((await readFile(dst)).equals(payload)).toBe(true);
    // The 480p partial stays a valid resume candidate for a future 480p run.
    expect((await readFile(`${dst}.part_480p`)).equals(stale480)).toBe(true);
  });

  it('resumes the partial belonging to the same quality', async () => {
    const payload = Buffer.from('R'.repeat(6000));
    const counter = { rangeRequests: 0 };
    const server = await serve(rangeAwareHandler(payload, counter));

    const dst = path.join(await tempDir(), 'out.mp4');
    await writeFile(`${dst}.part_720p`, payload.subarray(0, 2000));

    await newDownloader().do({ url: server.url, destination: dst, quality: 720 });
    expect(counter.rangeRequests).toBe(1);
    expect((await readFile(dst)).equals(payload)).toBe(true);
  });

  it('ignores a partial written for a different variant', async () => {
    const payload = Buffer.from('V'.repeat(4000));
    const counter = { rangeRequests: 0 };
    const server = await serve(rangeAwareHandler(payload, counter));

    const dst = path.join(await tempDir(), 'out.mp4');
    const staleDub = Buffer.from('X'.repeat(1500));
    await writeFile(`${dst}.part_Dub_720p`, staleDub);

    await newDownloader().do({
      url: server.url,
      destination: dst,
      quality: 720,
      variant: 'Original',
    });
    expect(counter.rangeRequests).toBe(0);
    expect((await readFile(`${dst}.part_Dub_720p`)).equals(staleDub)).toBe(true);
  });
});
