export type CallDirection = "INBOUND" | "OUTBOUND";
export type CallStatus =
  | "INITIATED"
  | "RINGING_AGENT"
  | "AGENT_ANSWERED"
  | "RINGING_CUSTOMER"
  | "CONNECTED"
  | "COMPLETED"
  | "NO_ANSWER"
  | "BUSY"
  | "NOT_REACHABLE"
  | "FAILED";

export type CallOutcomeCategory = "CONNECTED" | "NOT_CONNECTED" | "FOLLOW_UP" | "INTERESTED" | "NOT_INTERESTED" | "OTHER";

export interface CallOutcomeOption {
  id: string;
  name: string;
  code: string;
  category: CallOutcomeCategory;
  requiresFollowup: boolean;
  requiresNote: boolean;
}

export interface Call {
  id: string;
  provider: string;
  direction: CallDirection;
  status: CallStatus;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  recording: { recordingUrl: string | null } | null;
  agent?: { id: string; name: string };
  notes: string | null;
  outcome: { id: string; name: string; code: string } | null;
}

export interface ClickToCallResult {
  callId: string;
  status: CallStatus;
}

export interface SubmitCallOutcomePayload {
  outcomeId: string;
  notes?: string;
}

export interface VirtualNumber {
  id: string;
  number: string;
  displayName: string | null;
  provider: string;
}

export type VirtualNumberStatus = "ACTIVE" | "INACTIVE";

export interface VirtualNumberRecord extends VirtualNumber {
  providerNumberId: string | null;
  groupId: string | null;
  status: VirtualNumberStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVirtualNumberPayload {
  number: string;
  displayName?: string;
  provider: string;
  providerNumberId?: string;
  groupId?: string;
}

export interface UpdateVirtualNumberPayload {
  displayName?: string;
  provider?: string;
  providerNumberId?: string;
  groupId?: string;
  status?: VirtualNumberStatus;
}
