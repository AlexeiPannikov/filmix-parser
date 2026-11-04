import { ApiError } from '../errors.js';
import { isRecord, looseInt, looseString } from './json.js';
import { parseJson } from '../internal/http.js';

/**
 * Extracts an {@link ApiError} from a JSON payload, handling both flavours of
 * the error wrapper:
 *
 * ```json
 * {"error": {"user_message": "...", "code": 123}}
 * {"error": {"message":      "...", "code": 123}}
 * ```
 *
 * Returns `undefined` when the payload does not look like an error envelope.
 */
export function decodeApiError(body: string): ApiError | undefined {
  if (body.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = parseJson(body);
  } catch {
    return undefined;
  }
  return decodeApiErrorValue(parsed);
}

/** {@link decodeApiError} for an already-parsed payload. */
export function decodeApiErrorValue(parsed: unknown): ApiError | undefined {
  if (!isRecord(parsed)) return undefined;
  const envelope = parsed['error'];
  if (!isRecord(envelope)) return undefined;
  const message = looseString(envelope['user_message']) || looseString(envelope['message']);
  if (message === '') return undefined;
  return new ApiError(looseInt(envelope['code']), message);
}
