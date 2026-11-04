import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore, userConfigDir } from '../src/cli/config-store.js';
import { main } from '../src/cli/main.js';

const tempDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'filmix-cfg-'));

describe('FileStore', () => {
  it('round-trips state through the Go-compatible JSON layout', async () => {
    const base = await tempDir();
    const store = await FileStore.open(base);
    await store.save({
      deviceId: 'abcdef0123456789',
      token: 'tok',
      apiBase: 'http://host/api/v2',
      siteSession: { mirror: 'https://filmix.my', cookies: [{ name: 'session', value: 'abc' }] },
    });

    const onDisk = JSON.parse(await readFile(store.path, 'utf8')) as Record<string, unknown>;
    expect(onDisk['DeviceID']).toBe('abcdef0123456789');
    expect(onDisk['Token']).toBe('tok');
    expect(onDisk['APIBase']).toBe('http://host/api/v2');
    expect(onDisk['SiteSession']).toEqual({
      Mirror: 'https://filmix.my',
      Cookies: [{ Name: 'session', Value: 'abc' }],
    });

    // A fresh store reads the same state back.
    const reopened = await FileStore.open(base);
    expect(await reopened.load()).toEqual({
      deviceId: 'abcdef0123456789',
      token: 'tok',
      apiBase: 'http://host/api/v2',
      siteSession: { mirror: 'https://filmix.my', cookies: [{ name: 'session', value: 'abc' }] },
    });
  });

  it('starts from empty state on a missing or corrupt file', async () => {
    const base = await tempDir();
    expect(await (await FileStore.open(base)).load()).toEqual({
      deviceId: '',
      token: '',
      apiBase: '',
    });

    const corrupt = await tempDir();
    await mkdir(path.join(corrupt, 'filmix'), { recursive: true });
    await writeFile(path.join(corrupt, 'filmix', 'config.json'), '{not json');
    expect(await (await FileStore.open(corrupt)).load()).toEqual({
      deviceId: '',
      token: '',
      apiBase: '',
    });
  });

  it('omits SiteSession when there is none', async () => {
    const base = await tempDir();
    const store = await FileStore.open(base);
    await store.save({ deviceId: 'd', token: '', apiBase: '' });
    const onDisk = JSON.parse(await readFile(store.path, 'utf8')) as Record<string, unknown>;
    expect('SiteSession' in onDisk).toBe(false);
  });

  it('resolves a platform config directory', () => {
    expect(userConfigDir()).toMatch(/\S/);
  });
});

describe('cli main', () => {
  it('prints usage for help and for no arguments', async () => {
    expect(await main(['help'])).toBe(0);
    expect(await main(['--help'])).toBe(0);
    expect(await main([])).toBe(2);
  });
});
