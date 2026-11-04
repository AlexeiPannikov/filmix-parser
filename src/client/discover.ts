import { NoApiHostError } from '../errors.js';
import {
  buildUrl,
  composeSignal,
  errMessage,
  readTextLimited,
  trimRight,
  type DeviceInfo,
  type HttpClient,
} from '../internal/http.js';

/**
 * API hosts probed by {@link discover} when no override is configured. Order
 * matters in error messages, but probes run concurrently and the first
 * successful host wins.
 */
export const DEFAULT_API_FALLBACKS: readonly string[] = [
  'http://filmixapp.cyou/api/v2',
  'https://filmixapp.cyou/api/v2',
];

/** Per-host timeout used during discovery. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Substring the `/check_update` response must contain for a probe to count as
 * successful: the endpoint returns a JSON envelope with the current APK version
 * under this key.
 */
const VERSION_MARKER = '"version"';

/**
 * Probes the candidate list concurrently and returns the first host that
 * responds with a recognisable `/check_update` payload.
 *
 * `device` carries the fingerprint the API requires on every request, health
 * checks included — without it the API answers HTTP 400 and every probe would
 * be a false negative.
 *
 * @throws {NoApiHostError} when every candidate fails.
 */
export async function discover(
  http: HttpClient,
  device: DeviceInfo,
  candidates: readonly string[] = DEFAULT_API_FALLBACKS,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  const hosts = candidates.length > 0 ? candidates : DEFAULT_API_FALLBACKS;
  const controller = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;

  return await new Promise<string>((resolve, reject) => {
    const failures: string[] = [];
    let pending = hosts.length;

    const settle = (): void => {
      if (pending > 0) return;
      if (opts.signal?.aborted) {
        reject(opts.signal.reason as Error);
        return;
      }
      reject(new NoApiHostError(`filmix: no working API host found: ${failures.join('; ')}`));
    };

    for (const base of hosts) {
      void probe(http, device, base, signal).then(
        () => {
          pending--;
          controller.abort();
          resolve(trimRight(base, '/'));
        },
        (err: unknown) => {
          pending--;
          failures.push(`${base}: ${errMessage(err)}`);
          settle();
        },
      );
    }
  });
}

/**
 * Issues a `/check_update` request with full device parameters and validates
 * that the response looks like a Filmix payload.
 */
async function probe(
  http: HttpClient,
  device: DeviceInfo,
  base: string,
  signal: AbortSignal,
): Promise<void> {
  const url = buildUrl(base, 'check_update', device, 'abcdef0123456789', '');
  const probeSignal = composeSignal(signal, PROBE_TIMEOUT_MS);
  const res = await http.fetch(url, probeSignal ? { signal: probeSignal } : {});
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`status ${res.status}`);
  }
  // Read just enough to detect the marker; the real payload can be tens of
  // kilobytes (it embeds ad URLs we don't care about).
  const body = await readTextLimited(res, 4096);
  if (!body.includes(VERSION_MARKER)) {
    throw new Error('response does not look like /check_update');
  }
}
