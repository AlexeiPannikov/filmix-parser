import { DecodeError } from '../errors.js';
import { isRecord, looseString } from '../models/json.js';
import { parseJson } from '../internal/http.js';

/**
 * One playable entry inside a manifest. `id` is the manifest's own short
 * identifier (e.g. `s1e3`), `title` the human label, and `qualities` maps pixel
 * height to a direct CDN URL.
 */
export class PlaylistFile {
  readonly id: string;
  readonly title: string;
  readonly qualities: Map<number, string>;

  constructor(init: { id?: string; title?: string; qualities: Map<number, string> }) {
    this.id = init.id ?? '';
    this.title = init.title ?? '';
    this.qualities = init.qualities;
  }

  /** The sorted list of qualities in this file. */
  availableQualities(): number[] {
    return [...this.qualities.keys()].sort((a, b) => a - b);
  }
}

/**
 * The parsed contents of a Filmix `.txt` manifest: either a single movie entry
 * or episode lists keyed by season number.
 */
export interface Playlist {
  movie?: PlaylistFile;
  seasons?: Map<number, PlaylistFile[]>;
}

/**
 * Matches one playable entry in the comma-separated `file` field:
 *
 * ```
 * [480p]https://cdn/.../movie_480.mp4
 * [4K UHD]https://cdn/.../movie_2160.mp4
 * ```
 *
 * The label is captured raw; mapping it to a pixel height happens in
 * {@link labelToQuality} so non-numeric tags like `4K UHD` round-trip.
 */
const QUALITY_FILE_RE = /\[([^\]]+)\]([^,[]+)/g;

/** Pulls the first numeric run out of a quality label or season title. */
const DIGITS_RE = /\d+/;

/**
 * Maps a bracket label to its pixel-height equivalent. Anything containing `4K`
 * or `UHD` resolves to 2160; otherwise the first numeric run is used as-is
 * (`1080p` → 1080, `720` → 720).
 */
export function labelToQuality(label: string): number | undefined {
  const norm = label.trim().toUpperCase();
  if (norm.includes('4K') || norm.includes('UHD')) return 2160;
  const m = DIGITS_RE.exec(norm);
  if (m !== null) {
    const n = Number.parseInt(m[0], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * Parses the comma-separated quality/URL pairs found in the `file` property of
 * a manifest entry.
 */
export function parseFileField(raw: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of raw.matchAll(QUALITY_FILE_RE)) {
    const label = m[1];
    const url = m[2];
    if (label === undefined || url === undefined) continue;
    const quality = labelToQuality(label);
    if (quality === undefined) continue;
    out.set(quality, url.trim());
  }
  return out;
}

interface RawManifestEntry {
  title: string;
  id: string;
  file: string;
  folder: unknown[];
}

function toRawEntry(value: unknown): RawManifestEntry | undefined {
  if (!isRecord(value)) return undefined;
  const folder = value['folder'];
  return {
    title: looseString(value['title']),
    id: looseString(value['id']),
    file: looseString(value['file']),
    folder: Array.isArray(folder) ? folder : [],
  };
}

/**
 * Decodes the JSON payload of a manifest. Manifests come in two shapes:
 *
 * - **Movie**: a flat array with a single entry whose `file` lists the
 *   qualities.
 * - **Series**: a nested array where each top-level entry is one season with a
 *   `folder` of episodes.
 */
export function parsePlaylist(data: string): Playlist {
  const parsed = parseJson(data);
  let raw: RawManifestEntry[];
  if (Array.isArray(parsed)) {
    raw = parsed.map(toRawEntry).filter((e): e is RawManifestEntry => e !== undefined);
  } else {
    // Some manifests wrap a single movie in an object rather than an array;
    // be permissive.
    const single = toRawEntry(parsed);
    if (single === undefined) throw new DecodeError('filmix: decode manifest: unexpected shape');
    raw = [single];
  }
  const first = raw[0];
  if (first === undefined) throw new DecodeError('filmix: manifest is empty');

  // Series shape: at least one top-level entry has a non-empty folder.
  const hasFolder = raw.some((e) => e.folder.length > 0);
  if (!hasFolder) {
    return {
      movie: new PlaylistFile({
        id: first.id,
        title: first.title,
        qualities: parseFileField(first.file),
      }),
    };
  }

  const seasons = new Map<number, PlaylistFile[]>();
  raw.forEach((season, i) => {
    // Fall back to the season's position when the title has no parseable
    // number — otherwise two unparseable seasons would both collapse into
    // key 1, silently losing one of them on overwrite.
    const seasonNum = guessSeasonNumber(season.title, i + 1);
    const episodes: PlaylistFile[] = [];
    for (const epRaw of season.folder) {
      const ep = toRawEntry(epRaw);
      if (ep === undefined) continue;
      episodes.push(
        new PlaylistFile({ id: ep.id, title: ep.title, qualities: parseFileField(ep.file) }),
      );
    }
    seasons.set(seasonNum, episodes);
  });
  return { seasons };
}

/**
 * Extracts the season number from a title like `" Сезон 1"`, returning
 * `fallback` when nothing parseable is found.
 */
export function guessSeasonNumber(title: string, fallback: number): number {
  const m = DIGITS_RE.exec(title);
  if (m !== null) {
    const n = Number.parseInt(m[0], 10);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}
