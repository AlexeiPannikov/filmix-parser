import { DecodeError } from '../errors.js';
import { isRecord, looseBool, looseInt, looseString } from './json.js';
import { Plan } from './quality.js';

/** Slim representation of the authenticated user account. */
export class Profile {
  readonly userId: number;
  readonly login: string;
  readonly isPro: boolean;
  readonly isProPlus: boolean;
  /** Pro expiry, or undefined when the API did not report one. */
  readonly proUntil: Date | undefined;

  constructor(init: {
    userId: number;
    login: string;
    isPro: boolean;
    isProPlus: boolean;
    proUntil?: Date;
  }) {
    this.userId = init.userId;
    this.login = init.login;
    this.isPro = init.isPro;
    this.isProPlus = init.isProPlus;
    this.proUntil = init.proUntil;
  }

  /**
   * Parses `/api/v2/user_profile`. The API returns booleans as either bool or
   * `"0"`/`"1"` strings and `pro_date` as a unix timestamp, so every field goes
   * through the loose readers.
   */
  static fromJson(raw: unknown): Profile {
    if (!isRecord(raw)) throw new DecodeError('filmix: decode profile: payload is not an object');
    const proDate = looseInt(raw['pro_date']);
    return new Profile({
      userId: looseInt(raw['user_id']),
      login: looseString(raw['login']),
      isPro: looseBool(raw['is_pro']),
      isProPlus: looseBool(raw['is_pro_plus']),
      ...(proDate > 0 ? { proUntil: new Date(proDate * 1000) } : {}),
    });
  }

  /** Derives the subscription tier from the profile flags. */
  plan(): Plan {
    if (this.isProPlus) return Plan.ProPlus;
    if (this.isPro) return Plan.Pro;
    return Plan.Free;
  }
}
