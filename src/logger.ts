/**
 * Minimal structured logger, the TypeScript stand-in for `log/slog`.
 *
 * Fields are passed as a record rather than slog's alternating key/value
 * varargs, which keeps the call sites type-safe.
 */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** Drops every record. The default, matching `slog.DiscardHandler`. */
export const discardLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Writes one `level msg key=value …` line per record to stderr. */
export function consoleLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'info'): Logger {
  const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const min = order[level];
  const emit = (lvl: keyof typeof order, msg: string, fields?: LogFields): void => {
    if (order[lvl] < min) return;
    const parts = Object.entries(fields ?? {}).map(([k, v]) => `${k}=${format(v)}`);
    process.stderr.write(`${lvl.toUpperCase()} ${msg}${parts.length ? ' ' + parts.join(' ') : ''}\n`);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

function format(v: unknown): string {
  if (v instanceof Error) return JSON.stringify(v.message);
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v) ?? String(v);
}
