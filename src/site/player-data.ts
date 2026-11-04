import { ContentLockedError, DecodeError, PlayerDataEmptyError } from '../errors.js';
import { isRecord } from '../models/json.js';
import { parseJson } from '../internal/http.js';

/** The parsed shape of `/api/movies/player-data`. */
export interface PlayerData {
  /** Translation name → `#2`-encoded link string. */
  video: Map<string, string>;
  /** Translation name → encoded trailer link string. */
  trailers: Map<string, string>;
  /** True when the post is blocked by a takedown. */
  locked: boolean;
}

/**
 * Parses the `/api/movies/player-data` response.
 *
 * The response shape is:
 *
 * ```json
 * {
 *   "type": "success",
 *   "message": {
 *     "translations": {
 *       "lv": false,
 *       "video": { "<translation name>": "#2..." },
 *       "trailers": { }
 *     }
 *   }
 * }
 * ```
 *
 * `video` is sometimes returned as an empty array instead of an object —
 * notably when the session has not warmed up; that case raises
 * {@link PlayerDataEmptyError}.
 *
 * @throws {ContentLockedError} when the `lv` flag is set.
 * @throws {PlayerDataEmptyError} when no translations are present.
 */
export function parsePlayerDataJson(body: string): PlayerData {
  const parsed = parseJson(body);
  if (!isRecord(parsed)) throw new DecodeError('filmix: player-data decode: not an object');
  if (parsed['type'] !== 'success') {
    throw new DecodeError(`filmix: player-data: type=${JSON.stringify(parsed['type'] ?? null)}`);
  }
  const message = isRecord(parsed['message']) ? parsed['message'] : {};
  const translations = isRecord(message['translations']) ? message['translations'] : {};

  const locked = translations['lv'] === true;
  const data: PlayerData = {
    video: decodeMaybeObject(translations['video']),
    trailers: decodeMaybeObject(translations['trailers']),
    locked,
  };

  if (data.locked) throw new ContentLockedError();
  if (data.video.size === 0) throw new PlayerDataEmptyError();
  return data;
}

/**
 * Accepts either an object or an array. An empty array (the API's stand-in for
 * "none") yields an empty map; anything non-object yields an empty map too.
 */
function decodeMaybeObject(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out.set(k, v);
  }
  return out;
}
