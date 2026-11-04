/**
 * Streams Filmix MP4 files to disk.
 *
 * The downloader writes to `<destination>.part[_<variant>][_<quality>p]` while
 * the transfer runs and renames it to `<destination>` on success. The variant
 * and quality suffixes keep an interrupted partial from being resumed against a
 * different URL (translation or quality changed between runs) on the same
 * destination, which would silently produce a corrupt file. With neither field
 * set the suffix degrades to plain `.part`.
 *
 * Partial files are left in place on cancellation or transport errors and
 * resumed on the next call via an HTTP Range request.
 */
import { open, rename, rm, stat } from 'node:fs/promises';
import { DownloadError, HttpStatusError } from '../errors.js';
import { HttpClient, errMessage } from '../internal/http.js';
import { discardLogger, type Logger } from '../logger.js';

/**
 * Invoked as bytes arrive. `total` is -1 when the server did not advertise a
 * Content-Length.
 */
export type ProgressFunc = (downloaded: number, total: number) => void;

/** Describes one download. */
export interface DownloadFileRequest {
  url: string;
  destination: string;
  headers?: Record<string, string>;
  progress?: ProgressFunc;
  /**
   * When non-zero, appended to the partial file name as `_<quality>p` so that
   * re-running with a different quality starts fresh instead of corrupting the
   * existing partial.
   */
  quality?: number;
  /**
   * When non-empty, an arbitrary tag inserted into the partial file name
   * between `.part` and the quality suffix (e.g. `.part_Dub_720p`). Filmix
   * downloads use it for the translation, isolating a resume for one
   * translation from another translation's URL.
   */
  variant?: string;
  signal?: AbortSignal;
}

/**
 * Path of the partial file for `dst` at the given variant and quality. An empty
 * variant and a zero quality both degrade gracefully, so callers that track
 * neither get the plain `.part` name.
 */
export function partFile(dst: string, quality = 0, variant = ''): string {
  let suffix = '';
  if (variant !== '') suffix += `_${variant}`;
  if (quality > 0) suffix += `_${quality}p`;
  return `${dst}.part${suffix}`;
}

/** Streams large payloads to disk, with resume and progress reporting. */
export class Downloader {
  private readonly http: HttpClient;
  private readonly log: Logger;

  /**
   * Any timeout on `http` is **dropped** for downloads: large MP4 files
   * routinely take longer than 30 s to stream and the timeout would apply to
   * the whole request lifecycle, body included. Per-call cancellation goes
   * through `request.signal`.
   */
  constructor(http: HttpClient = new HttpClient(), log: Logger = discardLogger) {
    this.http = http.withoutTimeout();
    this.log = log;
  }

  /**
   * Executes a download. The body is streamed to the partial file; on success
   * the file is renamed to `destination`. The partial file survives
   * cancellation and transport errors, and a later call resumes from its offset
   * via an HTTP Range request.
   */
  async do(req: DownloadFileRequest): Promise<void> {
    await this.run(req, true);
  }

  private async run(req: DownloadFileRequest, allowResume: boolean): Promise<void> {
    if (req.url === '') throw new DownloadError('download: empty URL');
    if (req.destination === '') throw new DownloadError('download: empty Destination');

    const tmp = partFile(req.destination, req.quality ?? 0, req.variant ?? '');

    let resumeOffset = 0;
    if (allowResume) {
      try {
        const info = await stat(tmp);
        if (info.isFile() && info.size > 0) resumeOffset = info.size;
      } catch {
        // No partial file: start from scratch.
      }
    }

    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (resumeOffset > 0) headers['Range'] = `bytes=${resumeOffset}-`;

    const res = await this.http.fetch(req.url, {
      method: 'GET',
      headers,
      ...(req.signal ? { signal: req.signal } : {}),
    });

    // 416 Range Not Satisfiable: the partial is at or past EOF (typically the
    // file rotated and is now shorter). Wipe the partial and retry once
    // without the Range header.
    if (res.status === 416) {
      await res.body?.cancel().catch(() => undefined);
      await removeIfExists(tmp);
      this.log.debug('download.resume_invalid', { dest: req.destination, offset: resumeOffset });
      return await this.run(req, false);
    }

    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => undefined);
      throw new HttpStatusError(res.status, 'download');
    }

    let appendMode = false;
    let total = -1;

    if (res.status === 206) {
      // Validate Content-Range: the server must resume from exactly our offset.
      const range = parseContentRange(res.headers.get('content-range') ?? '');
      if (range !== undefined && range.start === resumeOffset) {
        appendMode = true;
        if (range.total > 0) total = range.total;
      } else {
        // 206 whose range does not match the request: the body starts at the
        // server's offset, and writing it into a truncated file would silently
        // corrupt the result. Drop the partial and retry without Range.
        this.log.warn('download.bad_content_range', {
          dest: req.destination,
          requested_offset: resumeOffset,
          content_range: res.headers.get('content-range') ?? '',
        });
        await res.body?.cancel().catch(() => undefined);
        await removeIfExists(tmp);
        return await this.run(req, false);
      }
    } else if (res.status === 200) {
      // Server ignored Range (or none was sent). Start from scratch.
      resumeOffset = 0;
      total = contentLength(res) ?? -1;
    }

    if (!appendMode && total < 0) {
      total = contentLength(res) ?? -1;
    }

    const handle = await open(tmp, appendMode ? 'a' : 'w');
    if (appendMode) {
      this.log.debug('download.resume', { dest: req.destination, offset: resumeOffset, total });
    }

    let written = resumeOffset;
    try {
      if (res.body !== null) {
        // The global Response body is loosely typed; pin the chunk type.
        const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined || value.byteLength === 0) continue;
          await handle.write(value);
          written += value.byteLength;
          req.progress?.(written, total);
        }
      }
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw new DownloadError(`download: stream: ${errMessage(err)}`, { cause: err });
    }

    try {
      await handle.close();
    } catch (err) {
      throw new DownloadError(`download: close: ${errMessage(err)}`, { cause: err });
    }
    try {
      await rename(tmp, req.destination);
    } catch (err) {
      throw new DownloadError(`download: rename: ${errMessage(err)}`, { cause: err });
    }
    if (req.progress !== undefined && total > 0) {
      // Final tick at 100% — useful for progress bars that smooth out.
      req.progress(total, total);
    }
    this.log.debug('download.done', {
      dest: req.destination,
      bytes: written,
      resumed_from: resumeOffset,
    });
  }
}

function contentLength(res: Response): number | undefined {
  const raw = res.headers.get('content-length');
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : n;
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (err) {
    throw new DownloadError(`download: remove stale part: ${errMessage(err)}`, { cause: err });
  }
}

export interface ContentRange {
  start: number;
  end: number;
  /** -1 when the server reported `*`. */
  total: number;
}

/**
 * Parses an HTTP `Content-Range` header of the form
 * `bytes <start>-<end>/<total>` (or `/*` for an unknown total). Returns
 * undefined when the header is missing or malformed.
 */
export function parseContentRange(raw: string): ContentRange | undefined {
  const s = raw.trim();
  const prefix = 'bytes ';
  if (!s.startsWith(prefix)) return undefined;
  const rest = s.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return undefined;
  const rangePart = rest.slice(0, slash);
  const totalPart = rest.slice(slash + 1);
  const dash = rangePart.indexOf('-');
  if (dash < 0) return undefined;
  const start = parseStrictInt(rangePart.slice(0, dash));
  const end = parseStrictInt(rangePart.slice(dash + 1));
  if (start === undefined || end === undefined) return undefined;
  if (totalPart === '*') return { start, end, total: -1 };
  const total = parseStrictInt(totalPart);
  if (total === undefined) return undefined;
  return { start, end, total };
}

/** `strconv.ParseInt` semantics: the whole string must be an integer. */
function parseStrictInt(s: string): number | undefined {
  if (!/^[+-]?\d+$/.test(s)) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
}
