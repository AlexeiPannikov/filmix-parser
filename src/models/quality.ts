import { QualityUnavailableError } from '../errors.js';

/** Filmix subscription tier. */
export const Plan = {
  /** No token: up to 480p. */
  Guest: 'guest',
  /** Token without Pro flag: up to 720p. */
  Free: 'free',
  /** Pro: up to 1080p. */
  Pro: 'pro',
  /** Pro+: up to 2160p. */
  ProPlus: 'pro_plus',
} as const;

export type Plan = (typeof Plan)[keyof typeof Plan];

/** Highest video quality (in pixels) granted by the plan. */
export function maxQualityFor(plan: Plan): number {
  switch (plan) {
    case Plan.ProPlus:
      return 2160;
    case Plan.Pro:
      return 1080;
    case Plan.Free:
      return 720;
    default:
      return 480;
  }
}

/**
 * Matches the bracketed list of qualities embedded in Filmix MP4 URLs:
 * `https://cdn.example.com/path/video_[1080,720,480].mp4`.
 */
const QUALITIES_RE = /_\[([0-9,]+)\]\.mp4/;

/** Extracts the integer list of qualities from a Filmix MP4 link. */
export function parseQualities(link: string): number[] | undefined {
  const m = QUALITIES_RE.exec(link);
  const group = m?.[1];
  if (group === undefined) return undefined;
  const out: number[] = [];
  for (const part of group.split(',')) {
    const n = Number.parseInt(part, 10);
    if (!Number.isNaN(n)) out.push(n);
  }
  return out;
}

/**
 * Substitutes the quality placeholder with a concrete value. Two embedded forms
 * are supported:
 *
 * - `_[1080,720,480].mp4` — bracketed quality list (older mobile API).
 * - `_%s.mp4` — printf-style placeholder (current API for series).
 *
 * The link is returned unchanged when neither form is present.
 */
export function applyQuality(link: string, quality: number): string {
  if (QUALITIES_RE.test(link)) {
    return link.replace(new RegExp(QUALITIES_RE.source, 'g'), `_${quality}.mp4`);
  }
  return link.replace('_%s.mp4', `_${quality}.mp4`);
}

/**
 * Returns the highest quality in `available` that does not exceed `cap`.
 *
 * @throws {QualityUnavailableError} when no quality fits.
 */
export function pickBest(available: readonly number[] | undefined, cap: number): number {
  const eligible = (available ?? []).filter((q) => q <= cap);
  if (eligible.length === 0) throw new QualityUnavailableError();
  return Math.max(...eligible);
}
