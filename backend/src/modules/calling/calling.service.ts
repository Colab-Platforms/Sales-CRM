import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import { triggerClickToCall } from "./callerdesk.client.js";
import { CallDirection, CallStatus, VirtualNumberStatus, ActivityType, Role } from "../../../generated/prisma/enums.js";
import { OUTCOME_LEAD_STATUS } from "./calling.outcomes.js";
import type {
  CallerDeskWebhookPayload,
  ClickToCallResult,
  VirtualNumberSummary,
  CreateVirtualNumberBody,
  UpdateVirtualNumberBody,
  SubmitCallOutcomeBody,
} from "./calling.types.js";
import type { AuthUser } from "@/middlewares/auth.js";

const PROVIDER = "CALLERDESK";

// CallerDesk's webhook `Status` values mapped to our CallStatus enum. Confirmed from real webhook
// traffic (2026-09-25): a `live_call` ping fires "Transferring Call to Agent" right after the agent's
// own leg picks up (call now dialing the customer), then "Picked" once the customer's leg picks up;
// the final `call_report` sends "ANSWER". The rest below are still guesses pending real samples.
const STATUS_MAP: Record<string, CallStatus> = {
  answer: CallStatus.COMPLETED,
  answered: CallStatus.COMPLETED,
  "agent engaged": CallStatus.AGENT_ANSWERED,
  "transferring call to agent": CallStatus.RINGING_CUSTOMER,
  picked: CallStatus.CONNECTED,
  busy: CallStatus.BUSY,
  abandonment: CallStatus.NO_ANSWER,
  cancel: CallStatus.FAILED,
};

// Fallback when the raw Status string doesn't match anything in STATUS_MAP. Only ever guesses a
// *terminal* status (COMPLETED/FAILED) for the final call_report — never for a mid-call `live_call`
// ping, which by definition isn't over yet and has no duration/recording to judge by regardless.
// Getting this wrong is exactly what happened before this comment was added: enabling Live Call sent
// an unrecognized mid-call Status with no recording yet, and the old fallback guessed FAILED on a
// call that was still ringing and went on to connect fine.
// Returns null when a live_call ping is unrecognized — nothing safe to record, so the caller skips
// the update rather than guess.
function mapWebhookStatus(status: string | undefined, isFinalReport: boolean, hasSignalOfConnection: boolean): CallStatus | null {
  if (status) {
    const mapped = STATUS_MAP[status.trim().toLowerCase()];
    if (mapped) return mapped;
    logger.warn(`[callerdesk] unrecognized webhook Status="${status}" (${isFinalReport ? "call_report" : "live_call"})`);
  }
  if (!isFinalReport) return null;
  return hasSignalOfConnection ? CallStatus.COMPLETED : CallStatus.FAILED;
}

function toSeconds(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

class CallingService {
  private async getLeadOrThrow(leadId: string) {
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new ApiError("Lead not found", STATUS_CODES.NOT_FOUND);
    return lead;
  }

  async listActiveVirtualNumbers(): Promise<VirtualNumberSummary[]> {
    return prisma.virtualNumber.findMany({
      where: { status: VirtualNumberStatus.ACTIVE },
      select: { id: true, number: true, displayName: true, provider: true },
      orderBy: { displayName: "asc" },
    });
  }

  async listVirtualNumbers() {
    return prisma.virtualNumber.findMany({ orderBy: { createdAt: "desc" } });
  }

  private async getVirtualNumberOrThrow(id: string) {
    const virtualNumber = await prisma.virtualNumber.findUnique({ where: { id } });
    if (!virtualNumber) throw new ApiError("Virtual number not found", STATUS_CODES.NOT_FOUND);
    return virtualNumber;
  }

  async createVirtualNumber(data: CreateVirtualNumberBody) {
    const existing = await prisma.virtualNumber.findUnique({ where: { number: data.number } });
    if (existing) throw new ApiError("A virtual number with this number already exists", STATUS_CODES.CONFLICT);

    return prisma.virtualNumber.create({
      data: {
        number: data.number,
        displayName: data.displayName,
        provider: data.provider,
        providerNumberId: data.providerNumberId,
        groupId: data.groupId,
      },
    });
  }

  async updateVirtualNumber(id: string, data: UpdateVirtualNumberBody) {
    await this.getVirtualNumberOrThrow(id);
    return prisma.virtualNumber.update({
      where: { id },
      data: {
        displayName: data.displayName,
        provider: data.provider,
        providerNumberId: data.providerNumberId,
        groupId: data.groupId,
        status: data.status as VirtualNumberStatus | undefined,
      },
    });
  }

  async deleteVirtualNumber(id: string) {
    await this.getVirtualNumberOrThrow(id);
    const inUse = await prisma.call.findFirst({ where: { virtualNumberId: id } });
    if (inUse) {
      throw new ApiError("Virtual number has call history and can't be deleted — deactivate it instead", STATUS_CODES.CONFLICT);
    }
    await prisma.virtualNumber.delete({ where: { id } });
  }

  async initiateCall(user: AuthUser, leadId: string, virtualNumberId: string): Promise<ClickToCallResult> {
    const lead = await this.getLeadOrThrow(leadId);
    if (!lead.mobile) {
      throw new ApiError("Lead has no phone number", STATUS_CODES.BAD_REQUEST);
    }

    const agent = await prisma.user.findUnique({ where: { id: user.id } });
    if (!agent?.phone) {
      throw new ApiError("Your profile has no phone number configured", STATUS_CODES.BAD_REQUEST);
    }

    const virtualNumber = await prisma.virtualNumber.findUnique({ where: { id: virtualNumberId } });
    if (!virtualNumber || virtualNumber.status !== VirtualNumberStatus.ACTIVE) {
      throw new ApiError("Virtual number not found or inactive", STATUS_CODES.BAD_REQUEST);
    }

    const call = await prisma.call.create({
      data: {
        leadId: lead.id,
        agentId: agent.id,
        virtualNumberId: virtualNumber.id,
        provider: PROVIDER,
        direction: CallDirection.OUTBOUND,
        status: CallStatus.INITIATED,
        agentNumber: agent.phone,
        customerNumber: lead.mobile,
        startedAt: new Date(),
      },
    });

    try {
      const { providerCallId } = await triggerClickToCall({
        agentNumber: agent.phone,
        customerNumber: lead.mobile,
        callerId: virtualNumber.number,
        leadId: lead.id,
      });

      const updated = await prisma.call.update({
        where: { id: call.id },
        data: { providerCallId, status: CallStatus.RINGING_AGENT },
      });

      await prisma.activity.create({
        data: {
          leadId: lead.id,
          actorId: agent.id,
          type: ActivityType.CALL,
          referenceType: "CALL",
          referenceId: call.id,
          title: "Call initiated",
          description: `${agent.name} called ${lead.mobile} via ${virtualNumber.displayName ?? virtualNumber.number}`,
        },
      });

      return { callId: updated.id, status: updated.status };
    } catch (error: any) {
      await prisma.call.update({
        where: { id: call.id },
        data: { status: CallStatus.FAILED, notes: error.message ?? "Failed to initiate call" },
      });
      throw error;
    }
  }

  async listCallsForLead(user: AuthUser, leadId: string) {
    const lead = await this.getLeadOrThrow(leadId);

    if (user.role === Role.MANAGER && lead.assignedManagerId !== user.id) {
      throw new ApiError("Lead not found", STATUS_CODES.NOT_FOUND);
    }
    if (user.role === Role.SALESPERSON && lead.ownerId !== user.id) {
      throw new ApiError("Lead not found", STATUS_CODES.NOT_FOUND);
    }

    const calls = await prisma.call.findMany({
      where: { leadId },
      include: {
        agent: { select: { id: true, name: true } },
        recording: true,
        outcome: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Salespersons see their own call log (status, duration) but can't hear the
    // recording — only managers/admins can listen.
    if (user.role === Role.SALESPERSON) {
      return calls.map((call) => (call.recording ? { ...call, recording: { ...call.recording, recordingUrl: null } } : call));
    }
    return calls;
  }

  async listCallOutcomes() {
    return prisma.callOutcome.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true, category: true, requiresFollowup: true, requiresNote: true },
      orderBy: { createdAt: "asc" },
    });
  }

  // The note (and the status it drives) is what a salesperson fills in by hand once the call is
  // actually over - this never runs off the CallerDesk webhook, which only knows connection state,
  // never what was actually said.
  async submitCallOutcome(user: AuthUser, callId: string, data: SubmitCallOutcomeBody) {
    const call = await prisma.call.findUnique({ where: { id: callId }, include: { lead: true } });
    if (!call) throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);
    if (user.role === Role.MANAGER && call.lead.assignedManagerId !== user.id) {
      throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);
    }
    if (user.role === Role.SALESPERSON && call.lead.ownerId !== user.id) {
      throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);
    }

    const outcome = await prisma.callOutcome.findUnique({ where: { id: data.outcomeId } });
    if (!outcome || !outcome.isActive) throw new ApiError("Unknown call outcome", STATUS_CODES.BAD_REQUEST);
    if (outcome.requiresNote && !data.notes?.trim()) {
      throw new ApiError(`A note is required for "${outcome.name}"`, STATUS_CODES.BAD_REQUEST);
    }

    const newStatus = OUTCOME_LEAD_STATUS[outcome.code];

    await prisma.$transaction(async (tx) => {
      await tx.call.update({ where: { id: callId }, data: { outcomeId: outcome.id, notes: data.notes?.trim() || null } });

      if (newStatus && newStatus !== call.lead.workingStatus) {
        await tx.lead.update({ where: { id: call.lead.id }, data: { workingStatus: newStatus } });
      }

      await tx.activity.create({
        data: {
          leadId: call.lead.id,
          actorId: user.id,
          actorRole: user.role,
          type: ActivityType.STATUS_CHANGE,
          referenceType: "CALL",
          referenceId: callId,
          title: `Call outcome: ${outcome.name}`,
          description: data.notes?.trim() || undefined,
        },
      });
    });

    return prisma.call.findUnique({
      where: { id: callId },
      include: { agent: { select: { id: true, name: true } }, recording: true, outcome: true },
    });
  }

  verifyWebhookSecret(headers: Record<string, unknown>, query: Record<string, unknown>): boolean {
    const expected = process.env.CALLERDESK_WEBHOOK_SECRET;
    if (!expected) return true; // not configured yet — accept until a secret is set up
    const provided = headers["x-callerdesk-secret"] ?? query["secret"];
    return provided === expected;
  }

  async handleCallWebhook(payload: CallerDeskWebhookPayload): Promise<void> {
    // triggerClickToCall only gets `campid` back at dial time (no CallSid), so that's what
    // we stored as providerCallId — match on it first, falling back to CallSid in case a
    // future trigger response starts returning one instead.
    const providerCallId = payload.campid ?? payload.CallSid;
    if (!providerCallId) {
      // Seen in real traffic for an early, pre-dial event that isn't about a call we've created yet -
      // harmless (the controller acks CallerDesk regardless), just not something to act on.
      logger.warn(`[callerdesk] webhook with no campid/CallSid — ignoring: ${JSON.stringify(payload)}`);
      return;
    }

    const call = await prisma.call.findFirst({ where: { provider: PROVIDER, providerCallId: String(providerCallId) } });
    if (!call) {
      logger.warn(`[callerdesk] webhook for unknown call id=${providerCallId} — ignoring`);
      return;
    }

    logger.info(`[callerdesk] webhook payload for call=${call.id}: ${JSON.stringify(payload)}`);

    // Only `call_report` is the final word on a call; anything else (live_call, or no `type` at all
    // on an older payload shape) is a mid-call ping and must never be allowed to guess COMPLETED/FAILED.
    const isFinalReport = payload.type !== "live_call";
    const durationSeconds = toSeconds(payload.CallDuration ?? payload.TalkDuration);
    const status = mapWebhookStatus(payload.Status, isFinalReport, Boolean(durationSeconds) || Boolean(payload.CallRecordingUrl));
    if (status === null) {
      // An unrecognized live_call ping - nothing safe to record yet, wait for the next update.
      return;
    }

    await prisma.call.update({
      where: { id: call.id },
      data: {
        status,
        // AGENT_ANSWERED is the agent's own leg; CONNECTED is the customer actually picking up -
        // both are genuinely "answered", COMPLETED just confirms it after the fact.
        answeredAt:
          status === CallStatus.COMPLETED || status === CallStatus.AGENT_ANSWERED || status === CallStatus.CONNECTED
            ? new Date()
            : call.answeredAt,
        endedAt: payload.EndTime ? new Date(payload.EndTime) : call.endedAt,
        durationSeconds: durationSeconds ?? call.durationSeconds,
      },
    });

    if (payload.CallRecordingUrl) {
      await prisma.callRecording.upsert({
        where: { callId: call.id },
        create: { callId: call.id, recordingUrl: payload.CallRecordingUrl, durationSeconds },
        update: { recordingUrl: payload.CallRecordingUrl, durationSeconds },
      });
    }

    await prisma.activity.create({
      data: {
        leadId: call.leadId,
        actorId: call.agentId,
        type: ActivityType.CALL,
        referenceType: "CALL",
        referenceId: call.id,
        title: `Call ${status.toLowerCase().replace("_", " ")}`,
        description: [
          durationSeconds ? `Duration: ${durationSeconds}s` : null,
          payload.CallRecordingUrl ? `Recording: ${payload.CallRecordingUrl}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
      },
    });
  }
}

export default CallingService;
