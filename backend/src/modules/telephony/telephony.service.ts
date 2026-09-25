import { CallerDeskProvider } from "./callerdesk.provider.js";
import { ExotelProvider } from "./exotel.provider.js";
import {
  ProviderInitiationError,
  type InitiateOutboundCallInput,
  type InitiateOutboundCallResult,
  type InitiationFailureKind,
  type TelephonyProvider,
  type TelephonyProviderName,
} from "./provider.types.js";

/**
 * Provider selection and fallback. CallerDesk = PRIMARY, Exotel = BACKUP.
 *
 * FALLBACK CONDITION (exact):
 *   The backup provider is tried ONLY when the primary provider's `initiateOutboundCall`
 *   fails with a `ProviderInitiationError` whose kind is NOT_DISPATCHED - i.e. we are certain
 *   no call was placed (credentials missing, request rejected before dialling, connection
 *   refused / DNS failure). It is tried at most ONCE, and never if the backup is the same
 *   provider as the primary.
 *
 * NEVER falls back when:
 *   - the primary returned success (a delayed or missing webhook is not a failure);
 *   - the failure is UNCERTAIN (timeout, connection reset, 5xx, unparseable success) - the
 *     call may already be ringing, so a second attempt could dial the customer twice;
 *   - the error is anything other than a ProviderInitiationError (treated as UNCERTAIN).
 * There are no retry loops: one attempt per provider, then the failure is surfaced.
 */

export interface InitiationAttempt {
  provider: TelephonyProviderName;
  kind: InitiationFailureKind;
  code: string;
}

export interface InitiationOutcome {
  result: InitiateOutboundCallResult;
  fallbackUsed: boolean;
  attempts: InitiationAttempt[];
}

export class TelephonyInitiationFailedError extends Error {
  readonly attempts: InitiationAttempt[];
  /** True when at least one attempt may have placed a call - callers must not retry automatically. */
  readonly callMayHaveBeenPlaced: boolean;

  constructor(attempts: InitiationAttempt[]) {
    super("Call could not be initiated");
    this.name = "TelephonyInitiationFailedError";
    this.attempts = attempts;
    this.callMayHaveBeenPlaced = attempts.some((attempt) => attempt.kind === "UNCERTAIN");
    Object.setPrototypeOf(this, TelephonyInitiationFailedError.prototype);
  }
}

export interface TelephonyServiceConfig {
  providers: Record<TelephonyProviderName, TelephonyProvider>;
  primary: TelephonyProviderName;
  fallback: TelephonyProviderName | null;
}

function toAttempt(provider: TelephonyProviderName, err: unknown): InitiationAttempt {
  if (err instanceof ProviderInitiationError) {
    return { provider, kind: err.kind, code: err.code };
  }
  // Unknown error: assume the worst so we never risk a duplicate call.
  return { provider, kind: "UNCERTAIN", code: "UNEXPECTED_ERROR" };
}

export function createTelephonyService(config: TelephonyServiceConfig) {
  const { providers, primary, fallback } = config;

  function getProvider(name: TelephonyProviderName): TelephonyProvider {
    return providers[name];
  }

  async function initiateOutboundCall(input: InitiateOutboundCallInput): Promise<InitiationOutcome> {
    const attempts: InitiationAttempt[] = [];

    try {
      const result = await providers[primary].initiateOutboundCall(input);
      return { result, fallbackUsed: false, attempts };
    } catch (err) {
      const attempt = toAttempt(primary, err);
      attempts.push(attempt);

      const canFallBack = attempt.kind === "NOT_DISPATCHED" && fallback !== null && fallback !== primary;
      if (!canFallBack) throw new TelephonyInitiationFailedError(attempts);
    }

    try {
      const result = await providers[fallback!].initiateOutboundCall(input);
      return { result, fallbackUsed: true, attempts };
    } catch (err) {
      attempts.push(toAttempt(fallback!, err));
      throw new TelephonyInitiationFailedError(attempts);
    }
  }

  return { primary, fallback, getProvider, initiateOutboundCall };
}

export type TelephonyService = ReturnType<typeof createTelephonyService>;

function parseProviderName(value: string | undefined): TelephonyProviderName | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === "CALLERDESK" || normalized === "EXOTEL" ? normalized : null;
}

/** Defaults: primary CALLERDESK, fallback EXOTEL. Set TELEPHONY_FALLBACK_PROVIDER=NONE to disable fallback. */
export function readTelephonyConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<TelephonyServiceConfig, "primary" | "fallback"> {
  const primary = parseProviderName(env.TELEPHONY_PRIMARY_PROVIDER) ?? "CALLERDESK";
  const fallbackRaw = env.TELEPHONY_FALLBACK_PROVIDER?.trim().toUpperCase();
  const fallback = fallbackRaw === "NONE" ? null : (parseProviderName(fallbackRaw) ?? "EXOTEL");
  return { primary, fallback: fallback === primary ? null : fallback };
}

let cached: TelephonyService | undefined;

export function getTelephonyService(): TelephonyService {
  cached ??= createTelephonyService({
    providers: { CALLERDESK: new CallerDeskProvider(), EXOTEL: new ExotelProvider() },
    ...readTelephonyConfigFromEnv(),
  });
  return cached;
}
