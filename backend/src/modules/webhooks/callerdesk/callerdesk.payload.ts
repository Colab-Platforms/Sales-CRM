import { z } from "zod";
import { normalizeMobile } from "@/utils/normalize.js";
import type { NormalizeWebhookResult, NormalizedCallDirection, NormalizedCallEvent } from "@modules/telephony/provider.types.js";
import { mapCallerDeskStatus, normalizeStatusKey, type CallerDeskEventKind } from "./callerdesk.status.js";

/**
 * CallerDesk webhook payload parsing.
 *
 * DOCUMENTED (docs.callerdesk.io "Sample Payload"):
 *   Call Report: SourceNumber, DestinationNumber, DialWhomNumber, CallDuration, coins,
 *     Status, StartTime, EndTime, CallSid, CallRecordingUrl, Direction, campid,
 *     TalkDuration, call_group, receiver_name, error_code, LegA_Picked_time,
 *     LegB_Start_time, LegB_Picked_time
 *   Live Call:   SourceNumber, DestinationNumber, DialWhomNumber, Status, StartTime,
 *     CallSid, Direction, campid
 *   Direction: "IVR" = incoming, "WEBOBD" = outgoing.
 *   For INCOMING calls: SourceNumber = caller, DestinationNumber = the virtual number
 *     the call landed on, DialWhomNumber = agent number that answered.
 *
 * NOT DOCUMENTED (so deliberately not assumed):
 *   - An explicit event-type field. Call Report vs Live Call is inferred from
 *     report-only fields (see `detectEventKind`). Configure only those two events.
 *   - Which of SourceNumber / DestinationNumber / DialWhomNumber is the customer or
 *     agent on OUTGOING calls, so those are left null for outbound events.
 *   - The timezone of the "yyyy-mm-dd hh:mm:ss" timestamps (see `parseCallerDeskTimestamp`).
 *   - Whether Leg A / Leg B mean the same thing on incoming calls (for outgoing,
 *     click-to-call parameters make A = agent, B = customer), so leg times are only
 *     mapped for outbound events.
 */

const CALLSID_MAX = 200;
const NUMBER_MAX = 30;
const URL_MAX = 2000;

/** Default assumed timezone of CallerDesk timestamps (India). UNVERIFIED - override via CALLERDESK_TIMESTAMP_UTC_OFFSET. */
export const DEFAULT_TIMESTAMP_UTC_OFFSET = "+05:30";

const scalarToString = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((value) => String(value).trim());

const optionalScalar = scalarToString
  .optional()
  .transform((value) => (value === undefined || value === "" ? undefined : value))
  // A non-scalar (object/array/null) value for an optional field is ignored, never fatal.
  .catch(undefined);

const payloadFieldsSchema = z.object({
  callsid: scalarToString.pipe(z.string().min(1).max(CALLSID_MAX)),
  campid: optionalScalar,
  sourcenumber: optionalScalar,
  destinationnumber: optionalScalar,
  dialwhomnumber: optionalScalar,
  callduration: optionalScalar,
  talkduration: optionalScalar,
  status: optionalScalar,
  starttime: optionalScalar,
  endtime: optionalScalar,
  callrecordingurl: optionalScalar,
  direction: optionalScalar,
  error_code: optionalScalar,
  lega_picked_time: optionalScalar,
  legb_start_time: optionalScalar,
  legb_picked_time: optionalScalar,
});

type PayloadFields = z.infer<typeof payloadFieldsSchema>;

function lowerCaseKeys(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const lower = key.toLowerCase();
    // First occurrence wins so a differently-cased duplicate can't override.
    if (!(lower in out)) out[lower] = value;
  }
  return out;
}

export function parseNonNegativeInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * CallerDesk timestamps are "yyyy-mm-dd hh:mm:ss" with no timezone. We interpret them in
 * `utcOffset` (default +05:30, UNVERIFIED). Values that already carry an explicit
 * zone/offset (ISO 8601) are honoured as-is. Unparseable values yield null.
 */
export function parseCallerDeskTimestamp(value: string | undefined, utcOffset: string): Date | null {
  if (value === undefined) return null;

  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(value);
  const iso = naive ? `${naive[1]}T${naive[2]}${utcOffset}` : /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : null;
  if (!iso) return null;

  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNumberOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > NUMBER_MAX) return null;
  return trimmed;
}

function toDigits(value: string | undefined): string | null {
  const trimmed = toNumberOrNull(value);
  return trimmed ? normalizeMobile(trimmed) : null;
}

function safeRecordingUrl(value: string | undefined): string | null {
  if (value === undefined || value.length > URL_MAX) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function mapDirection(value: string | undefined): NormalizedCallDirection | null {
  switch (value?.trim().toUpperCase()) {
    case "IVR":
      return "INBOUND";
    case "WEBOBD":
      return "OUTBOUND";
    default:
      return null;
  }
}

/**
 * Call Reports are sent after disconnection and carry report-only fields; Live Call
 * events (call triggered / answered) do not. There is no documented explicit type field.
 */
export function detectEventKind(fields: PayloadFields): CallerDeskEventKind {
  const hasReportOnlyField =
    fields.endtime !== undefined ||
    fields.callduration !== undefined ||
    fields.talkduration !== undefined ||
    fields.callrecordingurl !== undefined ||
    fields.lega_picked_time !== undefined ||
    fields.legb_start_time !== undefined ||
    fields.legb_picked_time !== undefined;

  return hasReportOnlyField ? "CALL_REPORT" : "LIVE_CALL";
}

export interface CallerDeskParseOptions {
  /** UTC offset applied to naive timestamps, e.g. "+05:30". */
  timestampUtcOffset?: string;
}

export function normalizeCallerDeskPayload(
  rawPayload: unknown,
  options: CallerDeskParseOptions = {},
): NormalizeWebhookResult {
  if (rawPayload === null || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return { ok: false, reason: "payload is not an object" };
  }

  const parsed = payloadFieldsSchema.safeParse(lowerCaseKeys(rawPayload as Record<string, unknown>));
  if (!parsed.success) {
    // Only the field paths are reported, never the values.
    const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))];
    return { ok: false, reason: `invalid or missing fields: ${paths.join(", ")}` };
  }

  const fields = parsed.data;
  const offset = options.timestampUtcOffset ?? DEFAULT_TIMESTAMP_UTC_OFFSET;
  const eventKind = detectEventKind(fields);
  const direction = mapDirection(fields.direction);
  const mapped = mapCallerDeskStatus(fields.status ?? null, eventKind);

  // Number semantics are only documented for INCOMING calls.
  const isInbound = direction === "INBOUND";
  const isOutbound = direction === "OUTBOUND";

  const rawStatusKey = fields.status ? normalizeStatusKey(fields.status) : "NOSTATUS";
  // Call Report: one per call. Live Call: one per (call, status) - retries repeat both.
  const dedupeKey = eventKind === "CALL_REPORT" ? fields.callsid : `${fields.callsid}|${rawStatusKey}`.slice(0, 255);

  const event: NormalizedCallEvent = {
    provider: "CALLERDESK",
    eventType: eventKind,
    externalCallId: fields.callsid,
    dedupeKey,
    campaignId: fields.campid ?? null,
    direction,
    sourceNumber: toNumberOrNull(fields.sourcenumber),
    destinationNumber: toNumberOrNull(fields.destinationnumber),
    customerNumber: isInbound ? toDigits(fields.sourcenumber) : null,
    businessNumber: isInbound ? toNumberOrNull(fields.destinationnumber) : null,
    agentNumber: isInbound ? toDigits(fields.dialwhomnumber) : null,
    status: mapped.status,
    rawStatus: fields.status ?? null,
    failedLeg: mapped.failedLeg,
    durationSeconds: parseNonNegativeInt(fields.callduration),
    talkDurationSeconds: parseNonNegativeInt(fields.talkduration),
    recordingUrl: safeRecordingUrl(fields.callrecordingurl),
    startedAt: parseCallerDeskTimestamp(fields.starttime, offset),
    endedAt: parseCallerDeskTimestamp(fields.endtime, offset),
    // Outgoing click-to-call: Leg A = agent, Leg B = customer. Undocumented for incoming.
    agentPickedAt: isOutbound ? parseCallerDeskTimestamp(fields.lega_picked_time, offset) : null,
    customerLegStartedAt: isOutbound ? parseCallerDeskTimestamp(fields.legb_start_time, offset) : null,
    customerPickedAt: isOutbound ? parseCallerDeskTimestamp(fields.legb_picked_time, offset) : null,
    errorCode: fields.error_code ?? null,
    ivrDigit: null,
    rawPayload: rawPayload as Record<string, unknown>,
  };

  return { ok: true, event };
}
