export interface ClickToCallResult {
  callId: string;
  status: string;
}

// Returned to the browser, which logs into the Plivo Browser SDK with `token` and dials `destination`.
// The number actually dialed is looked up server-side from the Call row on the answer URL, never trusted
// from the browser.
export interface WebCallResult {
  callId: string;
  status: string;
  token: string;
  username: string;
  tokenExpiresInSeconds: number;
  destination: string;
}

// Plivo posts form-encoded fields; custom SDK headers arrive as X-PH-* fields.
export type PlivoWebhookParams = Record<string, string | undefined>;

export interface SubmitCallOutcomeBody {
  outcomeId: string;
  notes?: string;
  // Required when the outcome needs a follow-up (call back / follow up): when to remind the salesperson.
  followUpAt?: string;
}

export interface VirtualNumberSummary {
  id: string;
  number: string;
  displayName: string | null;
  provider: string;
}

export interface VirtualNumberRecord extends VirtualNumberSummary {
  providerNumberId: string | null;
  groupId: string | null;
  status: "ACTIVE" | "INACTIVE";
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateVirtualNumberBody {
  number: string;
  displayName?: string;
  provider: string;
  providerNumberId?: string;
  groupId?: string;
}

export interface UpdateVirtualNumberBody {
  displayName?: string;
  provider?: string;
  providerNumberId?: string;
  groupId?: string;
  status?: "ACTIVE" | "INACTIVE";
}

export interface CallerDeskWebhookPayload {
  // "live_call" fires mid-call (ringing/transferring/picked) once Live Call is enabled on the
  // CallerDesk dashboard; "call_report" is the one final, authoritative report per call. Absent on
  // older/legacy payload shapes, which are treated as final (see isFinalReport in calling.service.ts).
  type?: "live_call" | "call_report" | string;
  SourceNumber?: string;
  DestinationNumber?: string;
  DialWhomNumber?: string;
  CallDuration?: string | number;
  TalkDuration?: string | number;
  Status?: string;
  StartTime?: string;
  EndTime?: string;
  CallSid?: string;
  CallRecordingUrl?: string;
  Direction?: string;
  campid?: string;
  error_code?: string;
  [key: string]: unknown;
}
