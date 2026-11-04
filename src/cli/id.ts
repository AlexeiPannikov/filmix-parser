/**
 * Captures the post ID embedded in a Filmix page URL slug:
 *
 * ```
 * https://filmix.gg/film/triller/184075-v-normal-2025.html
 *                                ^^^^^^
 * ```
 *
 * The pattern matches the last `<digits>-...` segment before `.html`; this
 * shape is consistent across genre and type prefixes.
 */
const ID_FROM_URL_RE = /\/(\d+)-[^/]*\.html(?:[?#]|$)/;

/** A numeric post id plus the page URL it came from, when it was a URL. */
export interface ParsedIdArg {
  id: number;
  /** The original URL, or `''` when the argument was a plain numeric id. */
  sourceUrl: string;
}

/**
 * Accepts either a numeric post id (e.g. `184075`) or a Filmix page URL and
 * returns the integer id. Whitespace is trimmed.
 */
export function parseIdArg(arg: string): number {
  return parseIdArgWithUrl(arg).id;
}

/**
 * Like {@link parseIdArg} but also returns the original URL, for callers that
 * need to pass the canonical post URL downstream.
 *
 * URLs are rejected when the host does not contain "filmix" — a blunt check
 * that keeps an attacker-supplied URL such as
 * `http://attacker.example/film/12345-x.html` from being threaded into the site
 * path, where cookie mirroring would otherwise leak the session to that host.
 */
export function parseIdArgWithUrl(rawArg: string): ParsedIdArg {
  const arg = rawArg.trim();
  if (arg === '') throw new Error('empty id argument');

  if (/^\d+$/.test(arg)) {
    return { id: Number.parseInt(arg, 10), sourceUrl: '' };
  }

  const m = ID_FROM_URL_RE.exec(arg);
  if (m?.[1] !== undefined) {
    let host = '';
    try {
      host = new URL(arg).host;
    } catch {
      host = '';
    }
    if (!hostLooksLikeFilmix(host)) {
      throw new Error(
        `refusing URL with non-Filmix host ${JSON.stringify(host)} (expected the host to contain "filmix")`,
      );
    }
    return { id: Number.parseInt(m[1], 10), sourceUrl: arg };
  }

  throw new Error(
    `could not extract post id from ${JSON.stringify(arg)} (expected a number or a filmix page URL)`,
  );
}

/**
 * The cheap substring check that gates URLs before they reach cookie mirroring.
 * Case-insensitive; an empty host is rejected.
 */
export function hostLooksLikeFilmix(host: string): boolean {
  return host.toLowerCase().includes('filmix');
}
