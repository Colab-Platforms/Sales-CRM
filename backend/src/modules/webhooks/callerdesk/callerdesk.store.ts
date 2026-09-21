import type { Prisma } from "@root/generated/prisma/client.js";
import { ActivityType, Role, UserStatus, WebhookStatus, type CallDirection, type CallStatus } from "@root/generated/prisma/enums.js";
import type { prisma as PrismaSingleton } from "@/lib/prisma.js";

/**
 * Persistence port for the CallerDesk webhook service.
 *
 * The service only talks to this interface, so it can be unit-tested with an
 * in-memory fake and never touches the live database in tests. The Prisma
 * implementation below is the only place that knows model/field names.
 */

export interface StoredWebhookEvent {
  id: string;
  status: WebhookStatus;
}

export interface NewWebhookEvent {
  provider: string;
  eventType: string;
  externalEventId: string | null;
  payload: Record<string, unknown>;
  status: WebhookStatus;
  errorMessage?: string | null;
  receivedAt: Date;
}

export interface WebhookEventPatch {
  status: WebhookStatus;
  errorMessage?: string | null;
  processedAt?: Date | null;
}

export interface StoredCall {
  id: string;
  leadId: string;
  agentId: string;
  provider: string;
  providerCallId: string | null;
  direction: CallDirection;
  status: CallStatus;
  startedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
}

export interface NewCall {
  leadId: string;
  agentId: string;
  virtualNumberId: string | null;
  provider: string;
  providerCallId: string;
  direction: CallDirection;
  status: CallStatus;
  agentNumber: string | null;
  customerNumber: string | null;
  startedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
}

export interface CallPatch {
  providerCallId?: string;
  status?: CallStatus;
  startedAt?: Date;
  answeredAt?: Date;
  endedAt?: Date;
  durationSeconds?: number;
}

export interface CandidateLead {
  id: string;
  ownerId: string | null;
}

export interface CandidateUser {
  id: string;
  phone: string;
}

export interface RecordingUpsert {
  callId: string;
  recordingUrl: string;
  storageProvider: string;
  durationSeconds: number | null;
  status: string;
}

export interface NewCallActivity {
  leadId: string;
  actorId: string | null;
  callId: string;
  title: string;
  description: string | null;
}

export interface LeadTouch {
  lastActivityAt: Date;
  lastContactedAt?: Date;
}

export interface CallEventTx {
  /** Serialises all processing for one provider call id across requests and instances. */
  lockCall(key: string): Promise<void>;

  findWebhookEvent(query: { provider: string; eventType: string; externalEventId: string }): Promise<StoredWebhookEvent | null>;
  createWebhookEvent(data: NewWebhookEvent): Promise<StoredWebhookEvent>;
  updateWebhookEvent(id: string, patch: WebhookEventPatch): Promise<void>;

  findCallByProviderCallId(query: { provider: string; providerCallId: string; direction?: CallDirection }): Promise<StoredCall | null>;
  createCall(data: NewCall): Promise<StoredCall>;
  updateCall(id: string, patch: CallPatch): Promise<StoredCall>;

  /** At most 2 rows are needed: 0 = no match, 1 = match, 2 = ambiguous. */
  findLeadsByNormalizedMobile(candidates: string[]): Promise<CandidateLead[]>;
  findActiveUsersWithPhone(): Promise<CandidateUser[]>;
  findVirtualNumberId(numbers: string[]): Promise<string | null>;

  /** Idempotent by `callId` (unique). Never creates a second recording row. */
  upsertRecording(data: RecordingUpsert): Promise<"created" | "updated" | "unchanged">;

  hasCallActivity(leadId: string, callId: string): Promise<boolean>;
  createCallActivity(data: NewCallActivity): Promise<void>;
  touchLead(leadId: string, patch: LeadTouch): Promise<void>;
}

export interface CallEventStore {
  transaction<T>(fn: (tx: CallEventTx) => Promise<T>): Promise<T>;
  /**
   * Persist a FAILED webhook event outside any (rolled-back) transaction so the
   * raw payload is never lost. Reuses the existing row for the same key if present.
   */
  recordFailure(data: NewWebhookEvent): Promise<void>;
}

const CALL_ACTIVITY_REFERENCE_TYPE = "Call";
const TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

type Db = Prisma.TransactionClient;

function asStoredCall(row: {
  id: string;
  leadId: string;
  agentId: string;
  provider: string;
  providerCallId: string | null;
  direction: CallDirection;
  status: CallStatus;
  startedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
}): StoredCall {
  return {
    id: row.id,
    leadId: row.leadId,
    agentId: row.agentId,
    provider: row.provider,
    providerCallId: row.providerCallId,
    direction: row.direction,
    status: row.status,
    startedAt: row.startedAt,
    answeredAt: row.answeredAt,
    endedAt: row.endedAt,
    durationSeconds: row.durationSeconds,
  };
}

function createTx(db: Db): CallEventTx {
  return {
    async lockCall(key) {
      // Transaction-scoped advisory lock: released automatically on commit/rollback.
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    },

    async findWebhookEvent({ provider, eventType, externalEventId }) {
      const row = await db.webhookEvent.findFirst({
        where: { provider, eventType, externalEventId },
        orderBy: { receivedAt: "desc" },
        select: { id: true, status: true },
      });
      return row;
    },

    async createWebhookEvent(data) {
      return db.webhookEvent.create({
        data: {
          provider: data.provider,
          eventType: data.eventType,
          externalEventId: data.externalEventId,
          payload: data.payload as Prisma.InputJsonValue,
          status: data.status,
          errorMessage: data.errorMessage ?? null,
          receivedAt: data.receivedAt,
        },
        select: { id: true, status: true },
      });
    },

    async updateWebhookEvent(id, patch) {
      await db.webhookEvent.update({
        where: { id },
        data: {
          status: patch.status,
          ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
          ...(patch.processedAt !== undefined ? { processedAt: patch.processedAt } : {}),
        },
      });
    },

    async findCallByProviderCallId({ provider, providerCallId, direction }) {
      const row = await db.call.findFirst({
        where: { provider, providerCallId, ...(direction ? { direction } : {}) },
        orderBy: { createdAt: "asc" },
      });
      return row ? asStoredCall(row) : null;
    },

    async createCall(data) {
      const row = await db.call.create({ data });
      return asStoredCall(row);
    },

    async updateCall(id, patch) {
      const row = await db.call.update({ where: { id }, data: patch });
      return asStoredCall(row);
    },

    async findLeadsByNormalizedMobile(candidates) {
      if (candidates.length === 0) return [];
      return db.lead.findMany({
        where: { normalizedMobile: { in: candidates } },
        select: { id: true, ownerId: true },
        take: 2,
      });
    },

    async findActiveUsersWithPhone() {
      const rows = await db.user.findMany({
        where: { status: UserStatus.ACTIVE, role: { in: [Role.SALESPERSON, Role.MANAGER] }, phone: { not: null } },
        select: { id: true, phone: true },
      });
      return rows.flatMap((row) => (row.phone ? [{ id: row.id, phone: row.phone }] : []));
    },

    async findVirtualNumberId(numbers) {
      if (numbers.length === 0) return null;
      const row = await db.virtualNumber.findFirst({
        where: { number: { in: numbers } },
        select: { id: true },
      });
      return row?.id ?? null;
    },

    async upsertRecording(data) {
      const existing = await db.callRecording.findUnique({
        where: { callId: data.callId },
        select: { id: true, recordingUrl: true },
      });

      if (!existing) {
        await db.callRecording.create({
          data: {
            callId: data.callId,
            recordingUrl: data.recordingUrl,
            storageProvider: data.storageProvider,
            durationSeconds: data.durationSeconds,
            status: data.status,
          },
        });
        return "created";
      }

      if (existing.recordingUrl === data.recordingUrl) return "unchanged";

      await db.callRecording.update({
        where: { id: existing.id },
        data: { recordingUrl: data.recordingUrl, durationSeconds: data.durationSeconds },
      });
      return "updated";
    },

    async hasCallActivity(leadId, callId) {
      const row = await db.activity.findFirst({
        where: { leadId, type: ActivityType.CALL, referenceType: CALL_ACTIVITY_REFERENCE_TYPE, referenceId: callId },
        select: { id: true },
      });
      return row !== null;
    },

    async createCallActivity(data) {
      await db.activity.create({
        data: {
          leadId: data.leadId,
          actorId: data.actorId,
          type: ActivityType.CALL,
          referenceType: CALL_ACTIVITY_REFERENCE_TYPE,
          referenceId: data.callId,
          title: data.title,
          description: data.description,
        },
      });
    },

    async touchLead(leadId, patch) {
      await db.lead.update({
        where: { id: leadId },
        data: {
          lastActivityAt: patch.lastActivityAt,
          ...(patch.lastContactedAt ? { lastContactedAt: patch.lastContactedAt } : {}),
        },
        // Return only the id: an unqualified update returns every lead column, which fails on any
        // database that is behind the schema (e.g. missing migrated columns).
        select: { id: true },
      });
    },
  };
}

export function createPrismaCallEventStore(prisma: typeof PrismaSingleton): CallEventStore {
  return {
    transaction(fn) {
      return prisma.$transaction((tx) => fn(createTx(tx)), TRANSACTION_OPTIONS);
    },

    async recordFailure(data) {
      const existing =
        data.externalEventId === null
          ? null
          : await prisma.webhookEvent.findFirst({
              where: { provider: data.provider, eventType: data.eventType, externalEventId: data.externalEventId },
              orderBy: { receivedAt: "desc" },
              select: { id: true },
            });

      if (existing) {
        await prisma.webhookEvent.update({
          where: { id: existing.id },
          data: { status: WebhookStatus.FAILED, errorMessage: data.errorMessage ?? null },
        });
        return;
      }

      await prisma.webhookEvent.create({
        data: {
          provider: data.provider,
          eventType: data.eventType,
          externalEventId: data.externalEventId,
          payload: data.payload as Prisma.InputJsonValue,
          status: WebhookStatus.FAILED,
          errorMessage: data.errorMessage ?? null,
          receivedAt: data.receivedAt,
        },
      });
    },
  };
}
