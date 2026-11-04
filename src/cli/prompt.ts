import { createInterface } from 'node:readline';

/**
 * Reads a secret from the terminal without echoing it, the stdlib stand-in for
 * `golang.org/x/term.ReadPassword`. Falls back to a plain line read when stdin
 * is not a TTY (pipes, CI).
 */
export async function readPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY !== true) {
    const rl = createInterface({ input: stdin });
    try {
      for await (const line of rl) return line;
      return '';
    } finally {
      rl.close();
    }
  }

  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return await new Promise<string>((resolve, reject) => {
    let secret = '';
    const done = (finish: () => void): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      finish();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        switch (ch) {
          case '\r':
          case '\n':
          case '\u0004': // EOT
            done(() => resolve(secret));
            return;
          case '\u0003': // Ctrl-C
            done(() => reject(new Error('interrupted')));
            return;
          case '\u007f': // Backspace
          case '\b':
            secret = secret.slice(0, -1);
            break;
          default:
            if (ch >= ' ') secret += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}
