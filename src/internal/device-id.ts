import { randomBytes } from 'node:crypto';

/**
 * Returns a 16-character hex string suitable for the `user_dev_id` query
 * parameter. Backed by the platform CSPRNG, so the value is unpredictable
 * across processes.
 */
export function generateDeviceId(): string {
  return randomBytes(8).toString('hex');
}
