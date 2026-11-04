import type { ProgressFunc } from '../download/downloader.js';

/** A `ProgressFunc` that prints a single-line bar to stdout, ~10 redraws/sec. */
export function newProgressBar(): ProgressFunc {
  const start = Date.now();
  let lastTick = 0;
  return (downloaded, total) => {
    const now = Date.now();
    if (now - lastTick < 100 && (total <= 0 || downloaded !== total)) return;
    lastTick = now;

    const elapsed = (now - start) / 1000;
    const rate = elapsed > 0 ? downloaded / elapsed : 0;
    if (total <= 0) {
      process.stdout.write(
        `\rDownloaded: ${humanBytes(downloaded)}  ${(rate / (1024 * 1024)).toFixed(2)} MB/s`,
      );
      return;
    }
    const pct = (downloaded / total) * 100;
    process.stdout.write(
      `\r[${renderBar(pct, 20)}] ${pct.toFixed(1).padStart(5)}%  ${humanBytes(downloaded)}/${humanBytes(total)}  ${(rate / (1024 * 1024)).toFixed(2)} MB/s   `,
    );
  };
}

export function renderBar(pct: number, width: number): string {
  const full = Math.min(Math.trunc((pct / 100) * width), width);
  return '#'.repeat(Math.max(full, 0)) + ' '.repeat(width - Math.max(full, 0));
}

export function humanBytes(n: number): string {
  const unit = 1024;
  if (n < unit) return `${n} B`;
  let div = unit;
  let exp = 0;
  for (let x = Math.trunc(n / unit); x >= unit; x = Math.trunc(x / unit)) {
    div *= unit;
    exp++;
  }
  const suffix = 'KMGTPE'[exp] ?? 'E';
  return `${(n / div).toFixed(1)} ${suffix}iB`;
}

/** Pads rows into aligned columns, the small part of `text/tabwriter` we need. */
export function formatTable(rows: readonly (readonly string[])[], gap = 2): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd((widths[i] ?? 0) + gap)))
        .join(''),
    )
    .join('\n');
}
