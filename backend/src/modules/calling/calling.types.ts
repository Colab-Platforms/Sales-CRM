export interface ClickToCallResult {
  callId: string;
  status: string;
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
