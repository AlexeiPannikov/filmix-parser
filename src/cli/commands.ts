import { parseArgs } from 'node:util';

import type { Client, ResolvedLinks } from '../filmix.js';
import type { Episode } from '../models/post.js';
import { parseIdArgWithUrl } from './id.js';
import { formatTable } from './table.js';
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
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      season: { type: 'string', default: '1' },
      episode: { type: 'string', default: '1' },
      translation: { type: 'string', default: '' },
      links: { type: 'boolean', default: true },
      'no-links': { type: 'boolean', default: false },
      user: { type: 'string', default: '' },
      password: { type: 'string', default: '' },
    },
  });
  if (positionals.length !== 1 || positionals[0] === undefined) {
    process.stderr.write('Usage: filmix info [flags] <id|url>\n');
    throw new Error('expected exactly one id or url argument');
  }

  const [user, password] = resolveCredentials(values.user ?? '', values.password ?? '');
  if (user !== '') await loginByPassword(ctx, user, password);

  const { id, sourceUrl } = parseIdArgWithUrl(positionals[0]);
  const season = parsePositiveInt(values.season ?? '1', '--season');
  const episode = parsePositiveInt(values.episode ?? '1', '--episode');
  const translation = values.translation ?? '';
  const showLinks = (values.links ?? true) && !(values['no-links'] ?? false);

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
  } else {
    console.log('Type:      series');
    for (const s of post.seasons()) {
      const seasonData = post.playerLinks.playlist.get(s);
      if (seasonData === undefined) continue;
      console.log(`Season ${s}:`);
      for (const name of [...seasonData.translations.keys()].sort()) {
        const episodes = seasonData.translations.get(name) ?? [];
        const uniform = uniformQualities(episodes);
        if (uniform !== undefined) {
          console.log(
            `  Translation: ${name} (${episodes.length} episodes) qualities=[${uniform.join(' ')}]`,
          );
          continue;
        }
        console.log(`  Translation: ${name} (${episodes.length} episodes)`);
        for (const ep of episodes) {
          console.log(
            `    E${String(ep.number).padStart(2, '0')}  qualities=[${ep.qualities.join(' ')}]`,
          );
        }
      }
    }
  }

  if (!showLinks) return;

  const links = await ctx.client.resolveLinks({
    post,
    season,
    episode,
    translation,
    sourceUrl,
    signal: ctx.signal,
  });
  printLinks(links, post.isSeries() ? { season, episode } : undefined);
}

/** Prints the resolved CDN URLs, highest quality first. */
export function printLinks(
  links: ResolvedLinks,
  episodeRef?: { season: number; episode: number },
): void {
  const scope =
    episodeRef === undefined
      ? ''
      : ` for S${String(episodeRef.season).padStart(2, '0')}E${String(episodeRef.episode).padStart(2, '0')}`;
  const origin =
    links.source === 'site'
      ? 'decoded from the website manifests'
      : 'derived from the mobile API templates';
  console.log();
  console.log(`CDN links${scope} (${links.source}: ${origin}):`);
  if (links.translations.length === 0) {
    console.log('  (none resolved)');
    return;
  }
  for (const t of links.translations) {
    console.log(`  ${t.translation}`);
    const rows = [...t.urls.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([quality, url]) => [`    ${quality}p`, url]);
    console.log(formatTable(rows));
  }
  if (links.source === 'mobile') {
    console.log();
    console.log(
      '  Note: without a device token or a site session the CDN serves short previews above ~480p.',
    );
    console.log('  Pass --user/--password to resolve the links through the website session.');
  }
}

function parsePositiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${flag}: expected a positive integer`);
  const n = Number.parseInt(raw, 10);
  if (n < 1) throw new Error(`${flag}: expected a positive integer`);
  return n;
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

/* ------------------------------------------------------------------- links */

/** `filmix links <id|url>` — just the CDN URLs, without the metadata header. */
export async function cmdLinks(ctx: CommandContext, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      season: { type: 'string', default: '1' },
      episode: { type: 'string', default: '1' },
      translation: { type: 'string', default: '' },
      user: { type: 'string', default: '' },
      password: { type: 'string', default: '' },
    },
  });
  if (positionals.length !== 1 || positionals[0] === undefined) {
    process.stderr.write('Usage: filmix links [flags] <id|url>\n');
    throw new Error('expected exactly one id or url argument');
  }

  const [user, password] = resolveCredentials(values.user ?? '', values.password ?? '');
  if (user !== '') await loginByPassword(ctx, user, password);

  const { id, sourceUrl } = parseIdArgWithUrl(positionals[0]);
  const post = await ctx.client.getPost(id, { signal: ctx.signal });
  const links = await ctx.client.resolveLinks({
    post,
    season: parsePositiveInt(values.season ?? '1', '--season'),
    episode: parsePositiveInt(values.episode ?? '1', '--episode'),
    translation: values.translation ?? '',
    sourceUrl,
    signal: ctx.signal,
  });
  printLinks(
    links,
    post.isSeries()
      ? {
          season: parsePositiveInt(values.season ?? '1', '--season'),
          episode: parsePositiveInt(values.episode ?? '1', '--episode'),
        }
      : undefined,
  );
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
