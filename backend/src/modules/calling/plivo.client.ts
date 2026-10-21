import plivoModule from "plivo";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";

// The SDK's bundled typings only cover part of its surface (no AccessToken/Response constructors), so type the
// pieces used here.
interface PlivoXml {
  addRecord(attrs: Record<string, unknown>): void;
  addDial(attrs: Record<string, unknown>): { addNumber(number: string): void };
  addSpeak(text: string): void;
  addHangup(): void;
  toXML(): string;
}
interface PlivoSdk {
  Response: new () => PlivoXml;
  validateV3Signature(method: string, uri: string, nonce: string, authToken: string, signature: string, params?: object): boolean;
}
const plivo = plivoModule as unknown as PlivoSdk;

// Plivo Browser SDK calling: the agent's browser logs in with a short-lived JWT minted here, then dials. Plivo
// fetches our answer URL (routes under /api/webhooks/plivo) which replies with <Dial> XML naming the customer.
//   PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN - Plivo console overview; the token also verifies webhook signatures.
const TOKEN_LIFETIME_SECONDS = 5 * 60;

function getCredentials(): { authId: string; authToken: string } {
  const authId = process.env.PLIVO_AUTH_ID;
  const authToken = process.env.PLIVO_AUTH_TOKEN;
  if (!authId || !authToken) throw new ApiError("Plivo is not configured", STATUS_CODES.SERVER_ERROR);
  return { authId, authToken };
}

export function isPlivoConfigured(): boolean {
  return Boolean(process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN);
}

// Endpoint username the browser logs in as. Derived from the agent id so the answer URL can tell which agent
// is dialing (a forged X-PH-CallId can't be used by anyone but the agent the Call row belongs to).
export function plivoUsernameForAgent(agentId: string): string {
  return `crm${agentId.replace(/-/g, "")}`;
}

export function agentIdMatchesPlivoFrom(agentId: string, from: string | undefined): boolean {
  if (!from) return false;
  return from.toLowerCase().includes(plivoUsernameForAgent(agentId).toLowerCase());
}

// Plivo rejects locally signed JWTs (INVALID_ACCESS_TOKEN) - the token must come from their REST API.
// Docs: https://www.plivo.com/docs/voice/sdk/browser/jwt-authentication (max 24h, ~5 min recommended).
export async function createBrowserToken(agentId: string): Promise<{ token: string; username: string; expiresInSeconds: number }> {
  const { authId, authToken } = getCredentials();
  const username = plivoUsernameForAgent(agentId);
  const nbf = Math.floor(Date.now() / 1000) - 10; // small back-dating tolerates clock skew
  const exp = nbf + TOKEN_LIFETIME_SECONDS;

  const response = await fetch(`https://api.plivo.com/v1/Account/${authId}/JWT/Token/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${authId}:${authToken}`).toString("base64")}`,
    },
    body: JSON.stringify({
      iss: authId,
      sub: username,
      nbf,
      exp,
      per: { voice: { incoming_allow: false, outgoing_allow: true } }, // outbound only
      ...(process.env.PLIVO_APP_ID ? { app: process.env.PLIVO_APP_ID } : {}),
    }),
  });
  const raw = (await response.json().catch(() => null)) as { token?: string; error?: string } | null;
  if (!response.ok || !raw?.token) {
    logger.error(`[plivo] JWT request failed status=${response.status}`, raw);
    throw new ApiError("Could not get a calling token from Plivo", STATUS_CODES.SERVER_ERROR);
  }
  return { token: raw.token, username, expiresInSeconds: TOKEN_LIFETIME_SECONDS };
}

export function publicBackendUrl(): string | undefined {
  const base = process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL;
  return base ? base.replace(/\/+$/, "") : undefined;
}

// Fails closed: no token configured, no public URL, or a missing/mismatched signature all reject.
export function verifyPlivoSignature(input: {
  method: string;
  originalUrl: string;
  headers: Record<string, unknown>;
  params: Record<string, unknown>;
}): boolean {
  const authToken = process.env.PLIVO_AUTH_TOKEN;
  const base = publicBackendUrl();
  if (!authToken || !base) return false;

  const signature = input.headers["x-plivo-signature-v3"];
  const nonce = input.headers["x-plivo-signature-v3-nonce"];
  if (typeof signature !== "string" || typeof nonce !== "string") return false;

  try {
    return Boolean(plivo.validateV3Signature(input.method, `${base}${input.originalUrl}`, nonce, authToken, signature, input.params));
  } catch {
    return false;
  }
}

export interface DialXmlInput {
  customerNumber: string;
  callerId: string;
  dialCallbackUrl: string;
  recordingCallbackUrl: string;
}

export function buildDialXml(input: DialXmlInput): string {
  const response = new plivo.Response();
  response.addRecord({
    recordSession: true,
    redirect: false,
    fileFormat: "mp3",
    callbackUrl: input.recordingCallbackUrl,
    callbackMethod: "POST",
  });
  const dial = response.addDial({
    callerId: input.callerId,
    callbackUrl: input.dialCallbackUrl,
    callbackMethod: "POST",
    redirect: false,
  });
  dial.addNumber(input.customerNumber);
  return response.toXML();
}

export function buildHangupXml(reason: string): string {
  const response = new plivo.Response();
  response.addSpeak(reason);
  response.addHangup();
  return response.toXML();
}
