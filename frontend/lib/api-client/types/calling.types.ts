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
}

export interface ClickToCallResult {
  callId: string;
  status: CallStatus;
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
