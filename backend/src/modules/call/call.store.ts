import { CallDirection, CallStatus, VirtualNumberStatus, UserStatus } from "@root/generated/prisma/enums.js";
import type { prisma as PrismaSingleton } from "@/lib/prisma.js";

/**
 * Persistence port for `POST /api/calls`. The service depends only on this interface, so it can be
 * unit-tested against an in-memory fake and never touches the live database in tests.
 */

export interface LeadForCall {
  id: string;
  normalizedMobile: string | null;
  mobile: string | null;
  ownerId: string | null;
  assignedManagerId: string | null;
  groupId: string | null;
}

export interface AgentForCall {
  id: string;
  phone: string | null;
  isActive: boolean;
}

export interface CallingIdentity {
  virtualNumberId: string;
  /** Digits exactly as stored in `virtual_numbers.number` (CallerDesk `deskphone`). */
  number: string;
  displayName: string | null;
}

export interface NewOutboundCall {
  leadId: string;
  agentId: string;
  virtualNumberId: string;
  provider: string;
  agentNumber: string;
  customerNumber: string;
}

export type CreateCallResult = { created: true; callId: string } | { created: false; activeCallId: string };

export interface CallInitiationStore {
  findLead(leadId: string): Promise<LeadForCall | null>;
  findAgent(userId: string): Promise<AgentForCall | null>;
  /** Group-specific active number first, then a group-less (global) one; deterministic tie-break. */
  findCallingIdentity(groupId: string | null): Promise<CallingIdentity | null>;
  /**
   * Atomically: serialise per agent and per lead, refuse if an active call already exists for either,
   * otherwise create the OUTBOUND Call row (status INITIATED). This is what prevents duplicate calls
   * from double-clicks and concurrent requests - the schema has no unique constraint to do it.
   */
  createCallUnlessActive(data: NewOutboundCall, activeSince: Date): Promise<CreateCallResult>;
  markInitiated(callId: string, patch: { provider: string; providerCallId: string | null }): Promise<void>;
  markFailed(callId: string): Promise<void>;
}

/** Non-terminal states: a call in any of these is still (potentially) live. */
export const ACTIVE_CALL_STATUSES: readonly CallStatus[] = [
  CallStatus.INITIATED,
  CallStatus.RINGING_AGENT,
  CallStatus.AGENT_ANSWERED,
  CallStatus.RINGING_CUSTOMER,
  CallStatus.CONNECTED,
];

/**
 * Selection rule for the business number: a number assigned to the lead's group wins; otherwise a
 * group-less (global) number; otherwise none. `rows` must already be ordered oldest-first so the
 * tie-break is deterministic.
 */
export function pickCallingIdentity<T extends { groupId: string | null }>(rows: readonly T[], groupId: string | null): T | null {
  const groupSpecific = groupId ? rows.find((row) => row.groupId === groupId) : undefined;
  return groupSpecific ?? rows.find((row) => row.groupId === null) ?? null;
}

export function createPrismaCallInitiationStore(prisma: typeof PrismaSingleton): CallInitiationStore {
  return {
    findLead(leadId) {
      return prisma.lead.findUnique({
        where: { id: leadId },
        select: { id: true, normalizedMobile: true, mobile: true, ownerId: true, assignedManagerId: true, groupId: true },
      });
    },

    async findAgent(userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, phone: true, status: true } });
      return user ? { id: user.id, phone: user.phone, isActive: user.status === UserStatus.ACTIVE } : null;
    },

    async findCallingIdentity(groupId) {
      const rows = await prisma.virtualNumber.findMany({
        where: {
          status: VirtualNumberStatus.ACTIVE,
          provider: { equals: "callerdesk", mode: "insensitive" },
          OR: groupId ? [{ groupId }, { groupId: null }] : [{ groupId: null }],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, number: true, displayName: true, groupId: true },
      });

      const chosen = pickCallingIdentity(rows, groupId);
      if (!chosen) return null;

      return { virtualNumberId: chosen.id, number: chosen.number.replace(/\D/g, ""), displayName: chosen.displayName };
    },

    createCallUnlessActive(data, activeSince) {
      return prisma.$transaction(
        async (tx) => {
          // Fixed acquisition order (agent, then lead) so two requests can never deadlock each other.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`call-init:agent:${data.agentId}`}))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`call-init:lead:${data.leadId}`}))`;

          const active = await tx.call.findFirst({
            where: {
              status: { in: [...ACTIVE_CALL_STATUSES] },
              updatedAt: { gte: activeSince },
              OR: [{ leadId: data.leadId }, { agentId: data.agentId }],
            },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          });
          if (active) return { created: false as const, activeCallId: active.id };

          const call = await tx.call.create({
            data: {
              leadId: data.leadId,
              agentId: data.agentId,
              virtualNumberId: data.virtualNumberId,
              provider: data.provider,
              direction: CallDirection.OUTBOUND,
              status: CallStatus.INITIATED,
              agentNumber: data.agentNumber,
              customerNumber: data.customerNumber,
            },
            select: { id: true },
          });
          return { created: true as const, callId: call.id };
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
    },

    async markInitiated(callId, patch) {
      await prisma.call.update({
        where: { id: callId },
        data: { provider: patch.provider, ...(patch.providerCallId ? { providerCallId: patch.providerCallId } : {}) },
      });
    },

    async markFailed(callId) {
      await prisma.call.update({ where: { id: callId }, data: { status: CallStatus.FAILED } });
    },
  };
}
