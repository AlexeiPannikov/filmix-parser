#!/usr/bin/env node
/**
 * The reference CLI for filmix-parser. It exposes the four operations that make up
 * the typical user flow:
 *
 * ```
 * filmix login                 — start the device-token (or password) flow
 * filmix search <query>        — list matching posts
 * filmix info <id|url>         — describe a single post
 * filmix download [flags] <id> — download a movie or series episodes
 * ```
 */
import { Client } from '../filmix.js';
import { consoleLogger } from '../logger.js';
import {
  cmdInfo,
  cmdLinks,
  cmdLogin,
  cmdSearch,
  cmdSession,
  type CommandContext,
} from './commands.js';
import { FileStore } from './config-store.js';

const USAGE = `Usage: filmix <command> [args]

Commands:
  login                Start the device-token flow (or --user/--password for the site flow).
  search <query>       Search posts by title.
  info <id|url>        Print details (translations, seasons, qualities) and the CDN links.
  links <id|url>       Print only the resolved CDN links, one block per translation.
  session import       Install website cookies captured elsewhere as the site session:
                         filmix session import --cookies cookies.json [--mirror <url>]
                       The file may hold a Cookie header line, a {"name":"value"} object,
                       or a browser-extension export ([{"name":…,"value":…}, …]).

<id|url> can be either a numeric post id (e.g. 184075) or a Filmix page URL
(e.g. https://filmix.gg/film/triller/184075-v-normal-2025.html).

info / links flags:
  --season <n>          Season to resolve links for (series only) [default: 1]
  --episode <n>         Episode to resolve links for (series only) [default: 1]
  --translation <name>  Resolve only this translation (default: all of them)
  --source <path>       auto (default) | site | mobile. "site" requires a website
                        session and fails loudly instead of downgrading; "mobile"
                        skips the website path even when a session exists.
  --no-links            info only: skip link resolution
  --user, --password    Credentials for the site flow (also FILMIX_USER / FILMIX_PASS);
                        with a site session the links are decoded from the
                        website manifests instead of the mobile API templates.

Set FILMIX_DEBUG=1 for verbose logging and FILMIX_MIRROR to override the site mirror
(default https://filmix.gg).`;

export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined) {
    console.log(USAGE);
    return 2;
  }
  if (command === '-h' || command === '--help' || command === 'help') {
    console.log(USAGE);
    return 0;
  }

  let store: FileStore;
  try {
    store = await FileStore.open();
  } catch (err) {
    process.stderr.write(`config: ${message(err)}\n`);
    return 1;
  }

  const debug = (process.env['FILMIX_DEBUG'] ?? '') !== '';
  const mirror = process.env['FILMIX_MIRROR'] ?? '';
  const client = new Client({
    tokenStore: store,
    logger: consoleLogger(debug ? 'debug' : 'info'),
    ...(mirror !== '' ? { mirror } : {}),
  });

  const controller = new AbortController();
  const onSignal = (): void => controller.abort(new Error('interrupted'));
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const ctx: CommandContext = { client, store, signal: controller.signal };
  const args = [...argv.slice(1)];

  try {
    switch (command) {
      case 'login':
        await cmdLogin(ctx, args);
        break;
      case 'search':
        await cmdSearch(ctx, args);
        break;
      case 'info':
        await cmdInfo(ctx, args);
        break;
      case 'links':
        await cmdLinks(ctx, args);
        break;
      case 'session':
        await cmdSession(ctx, args);
        break;
      default:
        process.stderr.write(`unknown command: ${command}\n`);
        console.log(USAGE);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`error: ${message(err)}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return 0;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Run only when invoked as a program, not when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
