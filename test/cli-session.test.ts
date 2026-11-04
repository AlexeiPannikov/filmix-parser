import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdSession, parseCookieFile, type CommandContext } from '../src/cli/commands.js';
import { Client } from '../src/filmix.js';
import { MemoryStore } from '../src/auth/store.js';

function ctx(store: MemoryStore, mirror = 'https://filmix.gg'): CommandContext {
  return {
    client: new Client({ apiBase: 'http://127.0.0.1:1/api/v2', mirror }),
    store,
    signal: new AbortController().signal,
  };
}

const quiet = (): (() => void) => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return () => spy.mockRestore();
};

describe('parseCookieFile', () => {
  it('reads a Cookie header line, with or without the prefix', () => {
    expect(parseCookieFile('FILMIXNET=abc; x-a-key=sinatra; minotaurs=7wY%2Fx%3D')).toEqual([
      { name: 'FILMIXNET', value: 'abc' },
      { name: 'x-a-key', value: 'sinatra' },
      { name: 'minotaurs', value: '7wY%2Fx%3D' },
    ]);
    expect(parseCookieFile('Cookie: a=1; b=2')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
  });

  it('reads a plain JSON object', () => {
    expect(parseCookieFile('{"a":"1","b":"2"}')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
  });

  it('reads a browser-extension export and ignores the extra fields', () => {
    const raw = JSON.stringify([
      { name: 'FILMIXNET', value: 'abc', domain: '.filmix.gg', expirationDate: 1 },
      { domain: '.filmix.gg' },
      { name: 'alora', value: 'xyz' },
    ]);
    expect(parseCookieFile(raw)).toEqual([
      { name: 'FILMIXNET', value: 'abc' },
      { name: 'alora', value: 'xyz' },
    ]);
  });

  it('returns nothing for empty or valueless input', () => {
    expect(parseCookieFile('')).toEqual([]);
    expect(parseCookieFile('   ')).toEqual([]);
    expect(parseCookieFile('[]')).toEqual([]);
    expect(parseCookieFile('nonsense')).toEqual([]);
  });
});

describe('filmix session import', () => {
  it('stores the cookies against the client mirror', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'filmix-sess-'));
    const file = path.join(dir, 'cookies.txt');
    await writeFile(file, 'FILMIXNET=abc; x-a-key=sinatra');

    const store = new MemoryStore();
    const restore = quiet();
    await cmdSession(ctx(store), ['import', '--cookies', file]);
    restore();

    const state = await store.load();
    expect(state.siteSession?.mirror).toBe('https://filmix.gg');
    expect(state.siteSession?.cookies).toEqual([
      { name: 'FILMIXNET', value: 'abc' },
      { name: 'x-a-key', value: 'sinatra' },
    ]);
  });

  it('honours --mirror and trims its trailing slash', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'filmix-sess-'));
    const file = path.join(dir, 'cookies.json');
    await writeFile(file, '{"a":"1"}');

    const store = new MemoryStore();
    const restore = quiet();
    await cmdSession(ctx(store), ['import', '--cookies', file, '--mirror', 'https://filmix.moe/']);
    restore();

    expect((await store.load()).siteSession?.mirror).toBe('https://filmix.moe');
  });

  it('keeps unrelated state intact', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'filmix-sess-'));
    const file = path.join(dir, 'cookies.txt');
    await writeFile(file, 'a=1');

    const store = new MemoryStore();
    await store.save({ deviceId: 'dev', token: 'tok', apiBase: 'http://api' });
    const restore = quiet();
    await cmdSession(ctx(store), ['import', '--cookies', file]);
    restore();

    const state = await store.load();
    expect(state.deviceId).toBe('dev');
    expect(state.token).toBe('tok');
    expect(state.apiBase).toBe('http://api');
  });

  it('rejects a missing flag, an unknown subcommand and an empty file', async () => {
    const store = new MemoryStore();
    await expect(cmdSession(ctx(store), ['import'])).rejects.toThrow(/--cookies/);
    await expect(cmdSession(ctx(store), ['clear'])).rejects.toThrow(/unknown session subcommand/);

    const dir = await mkdtemp(path.join(tmpdir(), 'filmix-sess-'));
    const empty = path.join(dir, 'empty.txt');
    await writeFile(empty, '   ');
    await expect(cmdSession(ctx(store), ['import', '--cookies', empty])).rejects.toThrow(
      /no cookies found/,
    );
  });
});

describe('imported session is picked up by the client', () => {
  it('restores on bootstrap and enables the website path', async () => {
    const store = new MemoryStore();
    const dir = await mkdtemp(path.join(tmpdir(), 'filmix-sess-'));
    const file = path.join(dir, 'cookies.txt');
    await writeFile(file, 'FILMIXNET=abc');

    const restore = quiet();
    await cmdSession(ctx(store), ['import', '--cookies', file]);
    restore();

    const client = new Client({
      apiBase: 'http://127.0.0.1:1/api/v2',
      mirror: 'https://filmix.gg',
      tokenStore: store,
    });
    await client.search('x').catch(() => undefined); // triggers bootstrap
    expect(client.siteClient()).toBeDefined();
    expect(client.siteAuth()?.authorized()).toBe(true);
    expect(client.siteAuth()?.session.jar.headerFor('https://filmix.gg/any')).toBe(
      'FILMIXNET=abc',
    );
  });
});
