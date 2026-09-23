import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";

// CallerDesk click_to_call_v2 — confirmed from account dashboard sample code.
// GET https://app.callerdesk.io/api/click_to_call_v2
//   ?calling_party_a=<agent number>      — rung first
//   &calling_party_b=<customer number>   — bridged in once agent picks up
//   &deskphone=<DID/deskphone on account, i.e. our VirtualNumber.number>
//   &authcode=<CallerDesk dashboard "API Key">
//   &call_from_did=1                     — always "1"
// Response: {"type":"success","message":"...","campid":<number>,"callerid":"<number>"}
// No call-id field is returned besides `campid` — that's what we use to correlate the
// later call-report webhook (`payload.campid`) back to this Call row.
const CALLERDESK_BASE_URL = process.env.CALLERDESK_BASE_URL ?? "https://app.callerdesk.io";
const CALLERDESK_AUTH_CODE = process.env.CALLERDESK_API_KEY;

interface TriggerClickToCallInput {
  agentNumber: string;
  customerNumber: string;
  callerId: string;
  leadId: string;
}

interface TriggerClickToCallResult {
  providerCallId: string;
  raw: unknown;
}

export async function triggerClickToCall(input: TriggerClickToCallInput): Promise<TriggerClickToCallResult> {
  if (!CALLERDESK_AUTH_CODE) {
    throw new ApiError("CallerDesk is not configured", STATUS_CODES.SERVER_ERROR);
  }

  const url = new URL("/api/click_to_call_v2", CALLERDESK_BASE_URL);
  url.searchParams.set("calling_party_a", input.agentNumber);
  url.searchParams.set("calling_party_b", input.customerNumber);
  url.searchParams.set("deskphone", input.callerId);
  url.searchParams.set("authcode", CALLERDESK_AUTH_CODE);
  url.searchParams.set("call_from_did", "1");

  const response = await fetch(url, { method: "GET" });
  const raw = await response.json().catch(() => null);

  if (!response.ok || (raw as { type?: string })?.type !== "success") {
    logger.error(`[callerdesk] click-to-call request failed status=${response.status}`, raw);
    throw new ApiError(
      (raw as { message?: string })?.message ?? "Failed to initiate call via CallerDesk",
      STATUS_CODES.SERVER_ERROR,
    );
  }

  const campid = (raw as { campid?: string | number })?.campid;
  if (campid === undefined || campid === null) {
    logger.error("[callerdesk] click-to-call response missing campid", raw);
    throw new ApiError("CallerDesk did not return a call id", STATUS_CODES.SERVER_ERROR);
  }

  return { providerCallId: String(campid), raw };
}
