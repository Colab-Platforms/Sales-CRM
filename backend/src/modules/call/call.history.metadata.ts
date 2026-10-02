import { lowerCaseKeys } from "@modules/webhooks/callerdesk/callerdesk.payload.js";
import type { CallProviderMetadata } from "./call.history.types.js";

/**
 * Safe-only extraction from a stored CallerDesk webhook payload, for IVR call-detail display.
 *
 * `WebhookEvent.payload` already stores the raw Call Report body verbatim (see
 * callerdesk.service.ts's `createWebhookEvent` call) - no new table or Call column is needed to show
 * campid/error_code/call_group/receiver_name/leg times, since they were never discarded from the
 * database, only from the `Call` row itself (see callerdesk.service.ts's `buildCallPatch`, which
 * deliberately persists only the fields the rest of the app needs). This function is the one place
 * that reads them back out, for display only - nothing here is ever written anywhere.
 *
 * Explicit allowlist, never a payload dump: the stored JSON is whatever CallerDesk sent us, so this
 * must never return a field that wasn't specifically vetted - in particular, CallerDesk's webhook
 * payload has never contained our own CALLERDESK_API_KEY/authcode (that only ever travels outbound,
 * in our own request URL - see callerdesk.provider.ts), but this function stays an allowlist on
 * principle rather than trusting that to remain true forever.
 */

const SAFE_FIELDS = ["campid", "error_code", "call_group", "receiver_name", "lega_picked_time", "legb_start_time", "legb_picked_time", "callduration"] as const;

function asDisplayString(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const str = String(value).trim();
  return str.length > 0 && str.length <= 200 ? str : null;
}

function asNonNegativeInt(value: unknown): number | null {
  const str = asDisplayString(value);
  if (str === null || !/^\d+$/.test(str)) return null;
  const n = Number.parseInt(str, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function extractSafeProviderMetadata(payload: unknown): CallProviderMetadata | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;

  const lower = lowerCaseKeys(payload as Record<string, unknown>);
  const picked: Record<string, string | null> = {};
  for (const field of SAFE_FIELDS) {
    picked[field] = asDisplayString(lower[field]);
  }

  const metadata: CallProviderMetadata = {
    campaignId: picked.campid,
    errorCode: picked.error_code,
    callGroup: picked.call_group,
    receiverName: picked.receiver_name,
    agentPickedAt: picked.lega_picked_time,
    customerLegStartedAt: picked.legb_start_time,
    customerPickedAt: picked.legb_picked_time,
    // CallerDesk's own "CallDuration" (full ring+talk time) - distinct from `Call.durationSeconds`,
    // which is always sourced from "TalkDuration" (see buildCallPatch in callerdesk.service.ts).
    // Both are genuinely different numbers CallerDesk sends; neither is invented here.
    callDurationSeconds: asNonNegativeInt(lower.callduration),
  };

  // All-null is the same as "nothing useful was found" - let the caller treat it as absent.
  return Object.values(metadata).some((v) => v !== null) ? metadata : null;
}
