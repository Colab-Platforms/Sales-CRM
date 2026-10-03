import { EventEmitter } from "node:events";

// In-process pub/sub between calling.transcription.ts (the pg-boss worker, same Node process as the
// API server) and calling.controller.ts's SSE stream - lets a transcript push to an open browser tab
// the instant it's written, instead of the tab polling for it. Only works within one server instance;
// if this app ever runs multiple backend instances behind a load balancer, a viewer connected to
// instance A won't hear a transcript written by instance B's worker - would need Redis pub/sub (or
// similar) at that point. Single instance today, so this is fine as-is.
export const transcriptEvents = new EventEmitter();
transcriptEvents.setMaxListeners(0); // unbounded - one listener per open stream, across every call being watched

export function transcriptEventName(callId: string): string {
  return `call:${callId}`;
}

export interface TranscriptEventPayload {
  callId: string;
  status: string | null;
  transcriptText: string | null;
}
