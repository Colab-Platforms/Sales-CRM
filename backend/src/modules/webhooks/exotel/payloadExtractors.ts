/**
 * Provider-specific payload parsing, isolated so it stays easy to extend.
 *
 * VERIFIED (from Exotel Passthru documentation) — these are Exotel's actual
 * parameter names, sent as URL-encoded query params on a GET request:
 *   CallSid         - unique call identifier
 *   CallFrom        - caller number (incoming call)
 *   CallTo          - ExoPhone/number the call landed on
 *   Direction       - "incoming" | "outbound-dial"
 *   Created         - call creation timestamp
 *   StartTime       - call start timestamp
 *   EndTime         - call end timestamp
 *   digits          - IVR/Gather input, when applicable. May arrive wrapped
 *                      in literal double quotes, e.g. the string `"1"`.
 *   RecordingUrl    - recording URL, when applicable
 *   DialCallStatus  - second-leg call status, when applicable
 *   CustomField     - custom field, when applicable
 *
 * Unconfirmed fields (not part of verified Exotel Passthru params above) are
 * kept as fallback aliases only, in case of a differently configured applet
 * or a future/alternate provider — see TODO(exotel-verify) markers below.
 *
 * Every extractor is tolerant of missing/differently-cased fields and
 * returns null instead of guessing when nothing recognizable is present.
 */

type RawPayload = Record<string, unknown>;

function findFirstValue(payload: RawPayload, candidateKeys: string[]): unknown {
  const keys = Object.keys(payload);
  for (const candidate of candidateKeys) {
    const matchedKey = keys.find((key) => key.toLowerCase() === candidate.toLowerCase());
    if (matchedKey === undefined) continue;

    const value = payload[matchedKey];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;

    return value;
  }
  return null;
}

function toTrimmedString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

// VERIFIED: CallSid is Exotel's call identifier.
export function extractProviderCallId(payload: RawPayload): string | null {
  return toTrimmedString(
    findFirstValue(payload, ["CallSid", "call_sid", "CallSID", "CallUUID", "call_uuid", "provider_call_id", "providerCallId"]),
  );
}

// VERIFIED: CallFrom is the caller/customer number on an incoming call.
export function extractCallerNumber(payload: RawPayload): string | null {
  return toTrimmedString(
    findFirstValue(payload, ["CallFrom", "From", "from", "Caller", "CallerId", "CallerID", "customer_number", "customerNumber"]),
  );
}

// VERIFIED: CallTo is the ExoPhone/virtual number the call landed on.
export function extractBusinessNumber(payload: RawPayload): string | null {
  return toTrimmedString(
    findFirstValue(payload, ["CallTo", "To", "to", "CalledNumber", "DialWhomNumber", "virtual_number", "ExoPhone", "exophone"]),
  );
}

// VERIFIED: Direction is "incoming" | "outbound-dial".
export function extractDirection(payload: RawPayload): string | null {
  return toTrimmedString(findFirstValue(payload, ["Direction", "direction"]));
}

// TODO(exotel-verify): Exotel Passthru documentation does not confirm a
// distinct, retry-stable event/request id separate from CallSid. CallSid
// itself must NOT be used here — a single call legitimately produces
// multiple Passthru events (e.g. multiple IVR digit presses), so treating
// CallSid as an event id would incorrectly collapse them. Leave this
// returning null until/unless such a field is actually confirmed.
export function extractExternalEventId(payload: RawPayload): string | null {
  return toTrimmedString(
    findFirstValue(payload, ["EventSid", "EventId", "event_id", "RequestId", "request_id"]),
  );
}

// VERIFIED: digits carries IVR/Gather input, sometimes wrapped in literal
// double quotes (e.g. the value `"1"` rather than `1`). Handles quoted,
// unquoted, missing, null, and empty values; never fabricates a digit.
export function extractIvrDigit(payload: RawPayload): string | null {
  const raw = findFirstValue(payload, ["digits", "Digits", "Digit", "digit", "DTMF", "dtmf", "selected_option", "IvrDigit"]);
  const trimmed = toTrimmedString(raw);
  if (trimmed === null) return null;

  const unquoted = stripSurroundingQuotes(trimmed).trim();
  return unquoted.length > 0 ? unquoted : null;
}
