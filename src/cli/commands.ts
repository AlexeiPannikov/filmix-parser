import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import type { Client } from '../filmix.js';
import type { Episode, Post } from '../models/post.js';
import type { ProgressFunc } from '../download/downloader.js';
import { parseIdArg, parseIdArgWithUrl } from './id.js';
import { parseRange } from './ranges.js';
import { formatTable, newProgressBar } from './progress.js';
import { readPassword } from './prompt.js';

export interface CommandContext {
  client: Client;
  signal: AbortSignal;
}

/* ------------------------------------------------------------------ search */

export async function cmdSearch(ctx: CommandContext, args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const query = positionals.join(' ').trim();
  if (query === '') {
    process.stderr.write('Usage: filmix search <query>\n');
    throw new Error('missing query');
  }

  const results = await ctx.client.search(query, { signal: ctx.signal });
  if (results.length === 0) {
    console.log('(no results)');
    return;
  }

  const mirror = ctx.client.mirror;
  const rows: string[][] = [['ID', 'YEAR', 'TYPE', 'TITLE', 'URL']];
  for (const r of results) {
    rows.push([
      String(r.id),
      String(r.year),
      r.isSeries() ? 'series' : 'movie',
      r.title,
      r.pageUrl(mirror),
    ]);
  }
  console.log(formatTable(rows));
}

/* -------------------------------------------------------------------- info */

export async function cmdInfo(ctx: CommandContext, args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  if (positionals.length !== 1 || positionals[0] === undefined) {
    process.stderr.write('Usage: filmix info <id|url>\n');
    throw new Error('expected exactly one id or url argument');
  }
  const id = parseIdArg(positionals[0]);
  const post = await ctx.client.getPost(id, { signal: ctx.signal });

  console.log(`ID:        ${post.id}`);
  console.log(`Title:     ${post.title}`);
  console.log(`Original:  ${post.origTitle}`);
  console.log(`Year:      ${post.year}`);

  if (!post.isSeries()) {
    console.log('Type:      movie');
    console.log('Translations:');
    for (const m of post.playerLinks.movie) {
      console.log(`  - ${m.translation}  qualities=[${m.qualities.join(' ')}]`);
    }
    return;
  }

  console.log('Type:      series');
  for (const season of post.seasons()) {
    const s = post.playerLinks.playlist.get(season);
    if (s === undefined) continue;
    console.log(`Season ${season}:`);
    for (const name of [...s.translations.keys()].sort()) {
      const episodes = s.translations.get(name) ?? [];
      const uniform = uniformQualities(episodes);
      if (uniform !== undefined) {
        console.log(
          `  Translation: ${name} (${episodes.length} episodes) qualities=[${uniform.join(' ')}]`,
        );
        continue;
      }
      console.log(`  Translation: ${name} (${episodes.length} episodes)`);
      for (const ep of episodes) {
        console.log(`    E${String(ep.number).padStart(2, '0')}  qualities=[${ep.qualities.join(' ')}]`);
      }
    }
  }
}

/**
 * Returns the shared sorted quality set when every episode advertises the same
 * one, and undefined otherwise. Empty input is treated as uniform.
 */
export function uniformQualities(episodes: readonly Episode[]): number[] | undefined {
  if (episodes.length === 0) return [];
  const ref = [...(episodes[0]?.qualities ?? [])].sort((a, b) => a - b);
  for (const ep of episodes.slice(1)) {
    const cur = [...ep.qualities].sort((a, b) => a - b);
    if (cur.length !== ref.length || cur.some((q, i) => q !== ref[i])) return undefined;
  }
  return ref;
}

/* ------------------------------------------------------------------- login */

export async function cmdLogin(ctx: CommandContext, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      user: { type: 'string', default: '' },
      password: { type: 'string', default: '' },
    },
  });

  const [user, password] = resolveCredentials(values.user ?? '', values.password ?? '');
  if (user !== '') {
    await loginByPassword(ctx, user, password);
    return;
  }
  await loginByDeviceFlow(ctx);
}

/**
 * Returns the username and password for the password (site) flow, falling back
 * to `FILMIX_USER` / `FILMIX_PASS` when the corresponding flag is empty.
 */
export function resolveCredentials(user: string, password: string): [string, string] {
  return [
    user !== '' ? user : (process.env['FILMIX_USER'] ?? ''),
    password !== '' ? password : (process.env['FILMIX_PASS'] ?? ''),
  ];
}

export async function loginByPassword(
  ctx: CommandContext,
  rawUser: string,
  rawPassword: string,
): Promise<void> {
  const user = rawUser.trim();
  let password = rawPassword;
  if (password === '') {
    password = await readPassword(`Password for ${user}: `);
  }
  if (password === '') throw new Error('password is empty');

  await ctx.client.loginByPassword(user, password, { signal: ctx.signal });
  console.log('Site session established and saved (will be reused by future commands).');
  console.log();
  console.log('Quality cap with site session: 720p by default (Free tier).');
  console.log('Pass --quality 1080 explicitly if your account has a Pro subscription.');
}

async function loginByDeviceFlow(ctx: CommandContext): Promise<void> {
  const pending = await ctx.client.authenticate({ signal: ctx.signal });

  console.log('Filmix device activation');
  console.log('------------------------');
  console.log(`1. Open in your browser: ${pending.activationUrl}`);
  console.log(`2. Enter the code:       ${pending.userCode}`);
  console.log('Waiting for activation (Ctrl-C to cancel)...');

  const timeout = AbortSignal.timeout(15 * 60 * 1000);
  const signal = AbortSignal.any([ctx.signal, timeout]);
  await ctx.client.waitForActivation(pending, 3000, { signal });

  console.log('Activation successful. Token saved.');
  try {
    const profile = await ctx.client.profile({ signal: ctx.signal });
    console.log(`Logged in as ${profile.login} (plan: ${profile.plan()})`);
  } catch {
    // Profile is a nicety; activation already succeeded.
  }
}

/* ---------------------------------------------------------------- download */

export async function cmdDownload(ctx: CommandContext, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      translation: { type: 'string', default: '' },
      season: { type: 'string', default: '1' },
      episodes: { type: 'string', default: '' },
      quality: { type: 'string', default: '0' },
      output: { type: 'string', default: '' },
      progress: { type: 'boolean', default: true },
      'no-progress': { type: 'boolean', default: false },
      user: { type: 'string', default: '' },
      password: { type: 'string', default: '' },
    },
  });

  const [user, password] = resolveCredentials(values.user ?? '', values.password ?? '');
  if (user !== '') await loginByPassword(ctx, user, password);

  if (positionals.length !== 1 || positionals[0] === undefined) {
    process.stderr.write('Usage: filmix download [flags] <id|url>\n');
    throw new Error('expected exactly one id or url argument');
  }
  const { id, sourceUrl } = parseIdArgWithUrl(positionals[0]);
  const quality = Number.parseInt(values.quality ?? '0', 10);
  if (Number.isNaN(quality)) throw new Error('--quality: expected a number');
  const translation = values.translation ?? '';
  const output = values.output ?? '';

  const post = await ctx.client.getPost(id, { signal: ctx.signal });

  const seasons = parseRange(values.season ?? '1');
  const episodes = parseRange(values.episodes ?? '');
  if (seasons.length > 1 && episodes.length > 1) {
    throw new Error('--episodes with multiple values requires a single --season');
  }

  const showProgress = (values.progress ?? true) && !(values['no-progress'] ?? false);
  const progress = showProgress ? newProgressBar() : undefined;

  if (!post.isSeries()) {
    await runDownload(ctx, {
      post,
      translation,
      quality,
      output,
      sourceUrl,
      ...(progress ? { progress } : {}),
    });
    return;
  }

  const jobs = buildSeriesJobs(post, translation, seasons, episodes);
  if (jobs.length === 0) {
    throw new Error('no episodes match the requested season/episode range');
  }
  const multi = jobs.length > 1;

  let outDir = '';
  let outFile = '';
  if (multi) {
    outDir = output;
    if (outDir !== '') await ensureDir(outDir);
  } else {
    outFile = output;
  }

  for (const [i, job] of jobs.entries()) {
    if (multi) {
      const s = String(job.season).padStart(2, '0');
      const e = String(job.episode).padStart(2, '0');
      console.log(`[${i + 1}/${jobs.length}] S${s}E${e}`);
    }
    try {
      await runDownload(ctx, {
        post,
        translation,
        season: job.season,
        episode: job.episode,
        quality,
        output: outFile,
        outDir,
        sourceUrl,
        ...(progress ? { progress } : {}),
      });
    } catch (err) {
      const s = String(job.season).padStart(2, '0');
      const e = String(job.episode).padStart(2, '0');
      throw new Error(`S${s}E${e}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
  }
}

export interface SeriesJob {
  season: number;
  episode: number;
}

/**
 * Expands the requested season/episode ranges into concrete (season, episode)
 * pairs.
 *
 * When `episodes` is non-empty the cross product is returned (a multi-value
 * cross product is rejected upstream — only one dimension may be a true range).
 * When it is empty, each season's full episode list is discovered from the post
 * metadata, using `translation` when set, else the alphabetically first
 * translation that has the season.
 */
export function buildSeriesJobs(
  post: Post,
  translation: string,
  seasonsIn: readonly number[],
  episodes: readonly number[],
): SeriesJob[] {
  const seasons = seasonsIn.length > 0 ? seasonsIn : [1];

  if (episodes.length > 0) {
    const jobs: SeriesJob[] = [];
    for (const season of seasons) {
      for (const episode of episodes) jobs.push({ season, episode });
    }
    return jobs;
  }

  const jobs: SeriesJob[] = [];
  for (const season of seasons) {
    const eps = discoverEpisodes(post, season, translation);
    if (eps.length === 0) throw new Error(`no episodes found for season ${season}`);
    for (const episode of eps) jobs.push({ season, episode });
  }
  return jobs;
}

/**
 * The episode numbers available for `season`. With `translation` set only that
 * translation is consulted; otherwise the first translation (alphabetically)
 * that actually has the season is used.
 */
export function discoverEpisodes(post: Post, season: number, translation: string): number[] {
  const s = post.playerLinks.playlist.get(season);
  if (s === undefined) return [];
  const names = translation === '' ? post.translations() : [translation];
  for (const name of names) {
    if (name === '') continue;
    const eps = s.translations.get(name);
    if (eps === undefined || eps.length === 0) continue;
    return eps.map((e) => e.number);
  }
  return [];
}

interface DownloadParams {
  post: Post;
  translation: string;
  season?: number;
  episode?: number;
  quality: number;
  /** Exact destination when a single file. */
  output: string;
  /** Destination directory when downloading many files. */
  outDir?: string;
  sourceUrl: string;
  progress?: ProgressFunc;
}

/**
 * Performs one download. The filename is derived from the resolved CDN URL by
 * the library unless `output` is a literal file path; when `outDir` is set, the
 * library writes inside it.
 */
async function runDownload(ctx: CommandContext, p: DownloadParams): Promise<void> {
  const dst = p.outDir !== undefined && p.outDir !== '' ? p.outDir + path.sep : p.output;

  try {
    await ctx.client.download({
      post: p.post,
      translation: p.translation,
      quality: p.quality,
      destination: dst,
      sourceUrl: p.sourceUrl,
      ...(p.progress ? { progress: p.progress } : {}),
      ...(p.post.isSeries() ? { season: p.season ?? 0, episode: p.episode ?? 0 } : {}),
      signal: ctx.signal,
    });
  } catch (err) {
    console.log();
    throw new Error(`download: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  if (dst === '' || dst.endsWith(path.sep)) {
    // The library derived the actual path; the chosen name is logged as
    // filmix.download.start dest=...
    console.log('\nDone.');
  } else {
    console.log(`\nDone: ${dst}`);
  }
}

async function ensureDir(dir: string): Promise<void> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new Error(`--output ${JSON.stringify(dir)} exists and is not a directory`);
    }
    return;
  } catch (err) {
    if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
  }
  await mkdir(dir, { recursive: true, mode: 0o755 });
}
