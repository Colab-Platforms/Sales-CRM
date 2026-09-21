import { CallStatus } from "@root/generated/prisma/enums.js";
import { normalizeCallerDeskPayload, DEFAULT_TIMESTAMP_UTC_OFFSET } from "@modules/webhooks/callerdesk/callerdesk.payload.js";
import {
  ProviderInitiationError,
  type InitiateOutboundCallInput,
  type InitiateOutboundCallResult,
  type NormalizeWebhookResult,
  type ProviderCallStatus,
  type TelephonyProvider,
} from "./provider.types.js";

/**
 * CALLERDESK CLICK-TO-CALL CONTRACT
 * Source: CallerDesk's official public API documentation (Postman collection published at
 * https://api.callerdesk.io/), item "Click_to_call (Normal)", plus behaviour observed on
 * 2026-09-21 with an INVALID auth code (which cannot place a call). See README.md.
 *
 *   GET https://app.callerdesk.io/api/click_to_call_v2
 *       ?calling_party_a=<agent number>      required - rung FIRST (leg A)
 *       &calling_party_b=<customer number>   required - rung once A answers (leg B)
 *       &deskphone=<DID assigned in account> required - the number presented to the customer
 *       &call_from_did=1                     required - "always 1"
 *       &authcode=<API key>                  required - auth is a query parameter; HTTPS only
 *   No headers, no body. Numbers are 10-digit, no country code (docs' examples).
 *
 *   Success (documented):  {"type":"success","message":"Call to Customer Initiate Successfully..",
 *                           "campid":<int>,"callerid":"<did>"}
 *   Failure: NOT documented for click-to-call. OBSERVED for a bad auth code: HTTP 200,
 *     Content-Type text/html, body {"type":"error","message":"Invalid Auth Code!"}.
 *   => The HTTP status is NOT a reliable signal; the body's `type` decides.
 *   => `campid` is returned by CallerDesk (we do not supply it). The CallSid arrives later via webhook.
 *
 * CLASSIFICATION (decides whether the backup provider may be tried - see telephony.service.ts):
 *   success (200 + type=success)            -> accepted
 *   200 + type=error                        -> NOT_DISPATCHED (provider explicitly rejected the request)
 *   never connected (DNS/refused/unreachable/connect-timeout), not configured, invalid input
 *                                           -> NOT_DISPATCHED
 *   anything else (timeout after sending, reset, non-200, HTML/garbage, unknown `type`, redirect)
 *                                           -> UNCERTAIN: a call may already be ringing, NEVER fall back
 *
 * SECURITY: the auth code travels in the URL, so URLs are never logged and never appear in
 * error messages. Error messages here are fixed strings.
 */

export const CALLERDESK_CLICK_TO_CALL_URL = "https://app.callerdesk.io/api/click_to_call_v2";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

const AGENT_OR_CUSTOMER_NUMBER = /^\d{10}$/;
const DESKPHONE_NUMBER = /^\d{8,15}$/;

/** Node/undici error codes that mean no connection was ever established, so no request was sent. */
const NEVER_CONNECTED_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

export interface CallerDeskProviderConfig {
  /** CallerDesk "authcode" (Dashboard -> Integration Settings -> API key). Never logged, never hardcoded. */
  apiKey?: string;
  /** UTC offset for CallerDesk's naive webhook timestamps. */
  timestampUtcOffset?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function readCallerDeskConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CallerDeskProviderConfig {
  return {
    apiKey: env.CALLERDESK_API_KEY?.trim() || undefined,
    timestampUtcOffset: env.CALLERDESK_TIMESTAMP_UTC_OFFSET?.trim() || DEFAULT_TIMESTAMP_UTC_OFFSET,
  };
}

export type ClickToCallClassification =
  | { kind: "ACCEPTED"; campid: string | null }
  | { kind: "REJECTED" }
  | { kind: "UNCERTAIN"; code: string };

/** Pure classification of a click-to-call HTTP response. Exported for tests. */
export function classifyClickToCallResponse(httpStatus: number, bodyText: string): ClickToCallClassification {
  if (httpStatus !== 200) return { kind: "UNCERTAIN", code: `HTTP_${httpStatus}` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText.trim());
  } catch {
    return { kind: "UNCERTAIN", code: "UNPARSEABLE_RESPONSE" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "UNCERTAIN", code: "UNRECOGNISED_RESPONSE" };
  }

  const body = parsed as Record<string, unknown>;
  const type = typeof body.type === "string" ? body.type.trim().toLowerCase() : null;

  if (type === "success") {
    const raw = body.campid;
    const campid =
      typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
        ? String(raw)
        : typeof raw === "string" && /^\d{1,20}$/.test(raw.trim())
          ? raw.trim()
          : null;
    return { kind: "ACCEPTED", campid };
  }

  if (type === "error") return { kind: "REJECTED" };

  return { kind: "UNCERTAIN", code: "UNRECOGNISED_RESPONSE" };
}

function transportErrorCode(err: unknown): string | undefined {
  const anyErr = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = anyErr?.cause?.code ?? anyErr?.code;
  return typeof code === "string" ? code : undefined;
}

async function readLimitedText(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
}

/**
 * CallerDesk = PRIMARY provider.
 *
 * Restrictions NOT documented (so not enforced or assumed here): whether the agent number must be a
 * registered member for `click_to_call_v2` (the docs only require registration for the call-group,
 * member-id and reverse variants), rate limits, and credit/balance errors. Those would surface as
 * `type:"error"` and be treated as a rejection.
 */
export class CallerDeskProvider implements TelephonyProvider {
  readonly name = "CALLERDESK" as const;

  private readonly config: CallerDeskProviderConfig;

  constructor(config: CallerDeskProviderConfig = readCallerDeskConfigFromEnv()) {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async initiateOutboundCall(input: InitiateOutboundCallInput): Promise<InitiateOutboundCallResult> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new ProviderInitiationError("CALLERDESK", "NOT_DISPATCHED", "NOT_CONFIGURED", "CallerDesk credentials are not configured");
    }

    const deskphone = input.businessNumber ?? "";
    if (
      !AGENT_OR_CUSTOMER_NUMBER.test(input.agentNumber) ||
      !AGENT_OR_CUSTOMER_NUMBER.test(input.customerNumber) ||
      !DESKPHONE_NUMBER.test(deskphone)
    ) {
      throw new ProviderInitiationError("CALLERDESK", "NOT_DISPATCHED", "INVALID_INPUT", "Call parameters are not in a dialable format");
    }

    const url = new URL(CALLERDESK_CLICK_TO_CALL_URL);
    url.searchParams.set("calling_party_a", input.agentNumber);
    url.searchParams.set("calling_party_b", input.customerNumber);
    url.searchParams.set("deskphone", deskphone);
    url.searchParams.set("call_from_did", "1");
    url.searchParams.set("authcode", apiKey);

    const fetchImpl = this.config.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let status: number;
    let bodyText: string;
    try {
      // redirect:"error" - never follow a redirect, which could forward the auth code to another host.
      const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: controller.signal });
      status = response.status;
      bodyText = await readLimitedText(response);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ProviderInitiationError("CALLERDESK", "UNCERTAIN", "TIMEOUT", "CallerDesk did not respond in time");
      }
      const code = transportErrorCode(err);
      if (code && NEVER_CONNECTED_CODES.has(code)) {
        throw new ProviderInitiationError("CALLERDESK", "NOT_DISPATCHED", "CONNECTION_FAILED", "Could not connect to CallerDesk");
      }
      throw new ProviderInitiationError("CALLERDESK", "UNCERTAIN", "REQUEST_FAILED", "The CallerDesk request failed after it may have been sent");
    } finally {
      clearTimeout(timer);
    }

    const outcome = classifyClickToCallResponse(status, bodyText);

    switch (outcome.kind) {
      case "ACCEPTED":
        return { provider: "CALLERDESK", providerCallId: outcome.campid, campaignId: outcome.campid, status: CallStatus.INITIATED };
      case "REJECTED":
        throw new ProviderInitiationError("CALLERDESK", "NOT_DISPATCHED", "PROVIDER_REJECTED", "CallerDesk rejected the call request");
      case "UNCERTAIN":
        throw new ProviderInitiationError("CALLERDESK", "UNCERTAIN", outcome.code, "The CallerDesk response could not be confirmed");
    }
  }

  /**
   * CallerDesk does offer `live_call_v2` (running calls) and `call_list_v2` (reports), but call state is
   * driven by webhooks, so no polling is done.
   */
  async getCallStatus(_providerCallId: string): Promise<ProviderCallStatus | null> {
    return null;
  }

  normalizeWebhookEvent(rawPayload: unknown): NormalizeWebhookResult {
    return normalizeCallerDeskPayload(rawPayload, { timestampUtcOffset: this.config.timestampUtcOffset });
  }
}
