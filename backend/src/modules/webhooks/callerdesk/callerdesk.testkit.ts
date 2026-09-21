import { randomUUID } from "node:crypto";
import { WebhookStatus, type CallStatus } from "@root/generated/prisma/enums.js";
import type {
  CallEventStore,
  CallEventTx,
  CandidateLead,
  CandidateUser,
  NewCall,
  NewWebhookEvent,
  StoredCall,
  StoredWebhookEvent,
} from "./callerdesk.store.js";

/**
 * In-memory CallEventStore for unit tests: no database, synthetic data only.
 * Transactions snapshot/restore state so a thrown error rolls everything back,
 * matching the real Prisma transaction.
 */

export interface FakeWebhookEvent extends StoredWebhookEvent {
  provider: string;
  eventType: string;
  externalEventId: string | null;
  payload: Record<string, unknown>;
  errorMessage: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface FakeRecording {
  callId: string;
  recordingUrl: string;
  storageProvider: string;
  durationSeconds: number | null;
  status: string;
}

export interface FakeActivity {
  leadId: string;
  actorId: string | null;
  callId: string;
  title: string;
  description: string | null;
}

interface FakeLead extends CandidateLead {
  normalizedMobile: string;
  lastActivityAt: Date | null;
  lastContactedAt: Date | null;
}

interface State {
  webhookEvents: FakeWebhookEvent[];
  calls: StoredCall[];
  leads: FakeLead[];
  users: CandidateUser[];
  virtualNumbers: { id: string; number: string }[];
  recordings: FakeRecording[];
  activities: FakeActivity[];
}

export type FailPoint = "createCall" | "updateCall" | "upsertRecording" | "createCallActivity";

export function createInMemoryCallEventStore() {
  const state: State = {
    webhookEvents: [],
    calls: [],
    leads: [],
    users: [],
    virtualNumbers: [],
    recordings: [],
    activities: [],
  };
  const lockKeys: string[] = [];
  /** Every NewCall the service asked to create (includes fields StoredCall does not echo, e.g. virtualNumberId). */
  const createdCallInputs: NewCall[] = [];
  let failAt: FailPoint | null = null;

  function maybeFail(point: FailPoint): void {
    if (failAt === point) {
      failAt = null;
      // Deliberately looks like a leaky DB error so tests can assert it never reaches logs/DB rows/responses.
      throw new Error("connection to FAKE-LEAK-CANARY failed");
    }
  }

  const tx: CallEventTx = {
    async lockCall(key) {
      lockKeys.push(key);
    },

    async findWebhookEvent({ provider, eventType, externalEventId }) {
      const found = [...state.webhookEvents]
        .reverse()
        .find((e) => e.provider === provider && e.eventType === eventType && e.externalEventId === externalEventId);
      return found ? { id: found.id, status: found.status } : null;
    },

    async createWebhookEvent(data: NewWebhookEvent) {
      const row: FakeWebhookEvent = {
        id: randomUUID(),
        provider: data.provider,
        eventType: data.eventType,
        externalEventId: data.externalEventId,
        payload: data.payload,
        status: data.status,
        errorMessage: data.errorMessage ?? null,
        receivedAt: data.receivedAt,
        processedAt: null,
      };
      state.webhookEvents.push(row);
      return { id: row.id, status: row.status };
    },

    async updateWebhookEvent(id, patch) {
      const row = state.webhookEvents.find((e) => e.id === id);
      if (!row) throw new Error("webhook event not found");
      row.status = patch.status;
      if (patch.errorMessage !== undefined) row.errorMessage = patch.errorMessage;
      if (patch.processedAt !== undefined) row.processedAt = patch.processedAt;
    },

    async findCallByProviderCallId({ provider, providerCallId, direction }) {
      return (
        state.calls.find(
          (c) => c.provider === provider && c.providerCallId === providerCallId && (!direction || c.direction === direction),
        ) ?? null
      );
    },

    async createCall(data: NewCall) {
      maybeFail("createCall");
      createdCallInputs.push({ ...data });
      const row: StoredCall = {
        id: randomUUID(),
        leadId: data.leadId,
        agentId: data.agentId,
        provider: data.provider,
        providerCallId: data.providerCallId,
        direction: data.direction,
        status: data.status,
        startedAt: data.startedAt,
        answeredAt: data.answeredAt,
        endedAt: data.endedAt,
        durationSeconds: data.durationSeconds,
      };
      state.calls.push(row);
      return { ...row };
    },

    async updateCall(id, patch) {
      maybeFail("updateCall");
      const row = state.calls.find((c) => c.id === id);
      if (!row) throw new Error("call not found");
      Object.assign(row, patch);
      return { ...row };
    },

    async findLeadsByNormalizedMobile(candidates) {
      return state.leads
        .filter((l) => candidates.includes(l.normalizedMobile))
        .slice(0, 2)
        .map((l) => ({ id: l.id, ownerId: l.ownerId }));
    },

    async findActiveUsersWithPhone() {
      return state.users.map((u) => ({ ...u }));
    },

    async findVirtualNumberId(numbers) {
      return state.virtualNumbers.find((v) => numbers.includes(v.number))?.id ?? null;
    },

    async upsertRecording(data) {
      maybeFail("upsertRecording");
      const existing = state.recordings.find((r) => r.callId === data.callId);
      if (!existing) {
        state.recordings.push({ ...data });
        return "created";
      }
      if (existing.recordingUrl === data.recordingUrl) return "unchanged";
      existing.recordingUrl = data.recordingUrl;
      return "updated";
    },

    async hasCallActivity(leadId, callId) {
      return state.activities.some((a) => a.leadId === leadId && a.callId === callId);
    },

    async createCallActivity(data) {
      maybeFail("createCallActivity");
      state.activities.push({ ...data });
    },

    async touchLead(leadId, patch) {
      const lead = state.leads.find((l) => l.id === leadId);
      if (!lead) throw new Error("lead not found");
      lead.lastActivityAt = patch.lastActivityAt;
      if (patch.lastContactedAt) lead.lastContactedAt = patch.lastContactedAt;
    },
  };

  const store: CallEventStore = {
    async transaction(fn) {
      const snapshot = structuredClone(state);
      try {
        return await fn(tx);
      } catch (err) {
        Object.assign(state, snapshot);
        throw err;
      }
    },

    async recordFailure(data) {
      const existing =
        data.externalEventId === null
          ? undefined
          : state.webhookEvents.find(
              (e) => e.provider === data.provider && e.eventType === data.eventType && e.externalEventId === data.externalEventId,
            );
      if (existing) {
        existing.status = WebhookStatus.FAILED;
        existing.errorMessage = data.errorMessage ?? null;
        return;
      }
      state.webhookEvents.push({
        id: randomUUID(),
        provider: data.provider,
        eventType: data.eventType,
        externalEventId: data.externalEventId,
        payload: data.payload,
        status: WebhookStatus.FAILED,
        errorMessage: data.errorMessage ?? null,
        receivedAt: data.receivedAt,
        processedAt: null,
      });
    },
  };

  return {
    store,
    state,
    lockKeys,
    createdCallInputs,
    failNext(point: FailPoint) {
      failAt = point;
    },
    addLead(lead: { id?: string; normalizedMobile: string; ownerId?: string | null }): string {
      const id = lead.id ?? randomUUID();
      state.leads.push({ id, normalizedMobile: lead.normalizedMobile, ownerId: lead.ownerId ?? null, lastActivityAt: null, lastContactedAt: null });
      return id;
    },
    addUser(user: { id?: string; phone: string }): string {
      const id = user.id ?? randomUUID();
      state.users.push({ id, phone: user.phone });
      return id;
    },
    addVirtualNumber(number: string): string {
      const id = randomUUID();
      state.virtualNumbers.push({ id, number });
      return id;
    },
    addCall(call: Partial<StoredCall> & { leadId: string; agentId: string; status: CallStatus }): StoredCall {
      const row: StoredCall = {
        id: randomUUID(),
        provider: "callerdesk",
        providerCallId: null,
        direction: "OUTBOUND",
        startedAt: null,
        answeredAt: null,
        endedAt: null,
        durationSeconds: null,
        ...call,
      };
      state.calls.push(row);
      return row;
    },
  };
}

export type InMemoryCallEventStore = ReturnType<typeof createInMemoryCallEventStore>;

/** Synthetic payloads modelled on CallerDesk's documented Sample Payload. */
export function inboundCallReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SourceNumber: "9876543210",
    DestinationNumber: "01204567890",
    DialWhomNumber: "9123456789",
    CallDuration: "18",
    coins: "1",
    Status: "ANSWER",
    StartTime: "2023-01-02 14:32:40",
    EndTime: "2023-01-02 14:32:58",
    CallSid: "1672649960.960001",
    CallRecordingUrl: "https://callrecords.callerdesk.io/incoming/01_2023test.mp3",
    Direction: "IVR",
    TalkDuration: "9",
    call_group: "TestGroup",
    receiver_name: "Test Agent",
    error_code: "16",
    ...overrides,
  };
}

export function inboundLiveCall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SourceNumber: "9876543210",
    DestinationNumber: "01204567890",
    DialWhomNumber: "9123456789",
    Status: "ANSWER",
    StartTime: "2023-01-02 14:32:40",
    CallSid: "1672649960.960001",
    Direction: "IVR",
    ...overrides,
  };
}

export function outboundLiveCall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SourceNumber: "9123456789",
    DestinationNumber: "9876543210",
    Status: "Leg A Answer",
    StartTime: "2023-01-02 15:00:00",
    CallSid: "1672650000.960002",
    Direction: "WEBOBD",
    campid: "11387004",
    ...overrides,
  };
}

export function outboundCallReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SourceNumber: "9123456789",
    DestinationNumber: "9876543210",
    CallDuration: "40",
    Status: "Leg B Answer",
    StartTime: "2023-01-02 15:00:00",
    EndTime: "2023-01-02 15:00:40",
    CallSid: "1672650000.960002",
    Direction: "WEBOBD",
    campid: "11387004",
    TalkDuration: "25",
    LegA_Picked_time: "2023-01-02 15:00:05",
    LegB_Start_time: "2023-01-02 15:00:06",
    LegB_Picked_time: "2023-01-02 15:00:15",
    CallRecordingUrl: "https://callrecords.callerdesk.io/outgoing/01_2023test.mp3",
    ...overrides,
  };
}
