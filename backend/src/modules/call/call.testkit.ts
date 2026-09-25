import { randomUUID } from "node:crypto";
import { CallStatus, type CallDirection } from "@root/generated/prisma/enums.js";
import {
  ACTIVE_CALL_STATUSES,
  pickCallingIdentity,
  type AgentForCall,
  type CallInitiationStore,
  type CallingIdentity,
  type LeadForCall,
  type NewOutboundCall,
} from "./call.store.js";

/** In-memory CallInitiationStore for unit tests: no database, synthetic data only. */

export interface FakeCall extends NewOutboundCall {
  id: string;
  direction: CallDirection;
  status: CallStatus;
  providerCallId: string | null;
  updatedAt: Date;
}

export function createInMemoryCallInitiationStore(clock: { now: () => Date } = { now: () => new Date() }) {
  const leads = new Map<string, LeadForCall>();
  const agents = new Map<string, AgentForCall>();
  const identities: (CallingIdentity & { groupId: string | null })[] = [];
  const calls: FakeCall[] = [];
  let failMarkInitiated = false;

  const store: CallInitiationStore = {
    async findLead(leadId) {
      return leads.get(leadId) ?? null;
    },

    async findAgent(userId) {
      return agents.get(userId) ?? null;
    },

    async findCallingIdentity(groupId) {
      const picked = pickCallingIdentity(identities, groupId);
      return picked ? { virtualNumberId: picked.virtualNumberId, number: picked.number, displayName: picked.displayName } : null;
    },

    // Check-then-create runs with no `await` in between, so it is atomic on the single JS thread -
    // the same guarantee the advisory locks give in the Prisma implementation.
    async createCallUnlessActive(data, activeSince) {
      const active = calls.find(
        (c) =>
          ACTIVE_CALL_STATUSES.includes(c.status) &&
          c.updatedAt >= activeSince &&
          (c.leadId === data.leadId || c.agentId === data.agentId),
      );
      if (active) return { created: false, activeCallId: active.id };

      const call: FakeCall = {
        ...data,
        id: randomUUID(),
        direction: "OUTBOUND",
        status: CallStatus.INITIATED,
        providerCallId: null,
        updatedAt: clock.now(),
      };
      calls.push(call);
      return { created: true, callId: call.id };
    },

    async markInitiated(callId, patch) {
      if (failMarkInitiated) throw new Error("db down: FAKE-LEAK-CANARY");
      const call = calls.find((c) => c.id === callId)!;
      call.provider = patch.provider;
      if (patch.providerCallId) call.providerCallId = patch.providerCallId;
      call.updatedAt = clock.now();
    },

    async markFailed(callId) {
      const call = calls.find((c) => c.id === callId)!;
      call.status = CallStatus.FAILED;
      call.updatedAt = clock.now();
    },
  };

  return {
    store,
    calls,
    failMarkInitiatedOnce() {
      failMarkInitiated = true;
    },
    addLead(lead: Partial<LeadForCall> & { id?: string } = {}): LeadForCall {
      const row: LeadForCall = {
        id: lead.id ?? randomUUID(),
        normalizedMobile: "919876543210",
        mobile: "+91 98765 43210",
        ownerId: null,
        assignedManagerId: null,
        groupId: null,
        ...lead,
      };
      leads.set(row.id, row);
      return row;
    },
    addAgent(agent: Partial<AgentForCall> & { id?: string } = {}): AgentForCall {
      const row: AgentForCall = { id: agent.id ?? randomUUID(), phone: "+91 91234 56789", isActive: true, ...agent };
      agents.set(row.id, row);
      return row;
    },
    addIdentity(identity: { number?: string; displayName?: string | null; groupId?: string | null } = {}): CallingIdentity {
      const row = {
        virtualNumberId: randomUUID(),
        number: identity.number ?? "01204567890",
        displayName: identity.displayName === undefined ? "Avatar Sales" : identity.displayName,
        groupId: identity.groupId ?? null,
      };
      identities.push(row);
      return row;
    },
  };
}

export type InMemoryCallInitiationStore = ReturnType<typeof createInMemoryCallInitiationStore>;
