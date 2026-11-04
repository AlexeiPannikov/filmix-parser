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
