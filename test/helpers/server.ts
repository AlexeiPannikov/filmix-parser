import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

/** Starts an HTTP server on a loopback port, the `httptest.NewServer` analogue. */
export async function startServer(handler: http.RequestListener): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Reads a request body as a UTF-8 string. */
export async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Reads a JSON fixture (shared with the Go repository's `client/testdata`). */
export function fixture(name: string): Promise<string> {
  return readFile(path.join(fixturesDir, name), 'utf8');
}

export async function fixtureJson(name: string): Promise<unknown> {
  return JSON.parse(await fixture(name)) as unknown;
}
