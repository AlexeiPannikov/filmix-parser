#!/usr/bin/env node
/**
 * The reference CLI for filmix-ts. It exposes the four operations that make up
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
import { cmdDownload, cmdInfo, cmdLogin, cmdSearch, type CommandContext } from './commands.js';
import { FileStore } from './config-store.js';

const USAGE = `Usage: filmix <command> [args]

Commands:
  login                Start the device-token flow (or --user/--password for the site flow).
  search <query>       Search posts by title.
  info <id|url>        Print details (translations, seasons, episodes, qualities).
  download <id|url>    Download a movie, episode, or a range of episodes.

<id|url> can be either a numeric post id (e.g. 184075) or a Filmix page URL
(e.g. https://filmix.my/film/triller/184075-v-normal-2025.html).

download flags:
  --translation <name>  Translation name (default: first available)
  --season <range>      Season or range of seasons (e.g. 1, 2-3, 1,3,5) [default: 1]
  --episodes <range>    Episodes (e.g. 1, 3-5, 1,3,7-9); empty = all of the selected seasons
  --quality <height>    Pixel height (e.g. 1080); 0 = highest available
  --output <path>       Output file (single download) or directory (multiple downloads)
  --no-progress         Disable the progress bar
  --user, --password    Credentials for the site flow (also FILMIX_USER / FILMIX_PASS)

Set FILMIX_DEBUG=1 for verbose logging.`;

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
  const client = new Client({
    tokenStore: store,
    logger: consoleLogger(debug ? 'debug' : 'info'),
  });

  const controller = new AbortController();
  const onSignal = (): void => controller.abort(new Error('interrupted'));
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const ctx: CommandContext = { client, signal: controller.signal };
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
      case 'download':
        await cmdDownload(ctx, args);
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
