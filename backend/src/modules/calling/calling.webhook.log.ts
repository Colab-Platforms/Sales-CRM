import type { CallerDeskWebhookPayload } from "./calling.types.js";

/** Strips anything that could break or forge a log line, and bounds the length. */
const token = (value: unknown, max = 40): string => {
  if (value === undefined || value === null || value === "") return "none";
  return String(value).replace(/[^\w.\-|:() ]/g, "?").slice(0, max);
};

/**
 * One safe log line for a click-to-call webhook delivery. Deliberately a fixed allow-list: the raw payload
 * contains the customer's and the agent's phone numbers (SourceNumber / DestinationNumber / DialWhomNumber)
 * and a provider recording URL, none of which belong in application logs.
 */
export function summarizeWebhookForLog(callId: string, payload: CallerDeskWebhookPayload): string {
  return (
    `[callerdesk] webhook for call=${token(callId, 60)} type=${token(payload.type)} status=${token(payload.Status)} ` +
    `direction=${token(payload.Direction)} callDuration=${token(payload.CallDuration)} talkDuration=${token(payload.TalkDuration)} ` +
    `hasRecording=${Boolean(payload.CallRecordingUrl)} hasEndTime=${Boolean(payload.EndTime)}`
  );
}
