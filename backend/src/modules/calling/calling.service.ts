import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import { triggerClickToCall } from "./callerdesk.client.js";
import { CallDirection, CallStatus, VirtualNumberStatus, ActivityType, Role } from "../../../generated/prisma/enums.js";
import type {
  CallerDeskWebhookPayload,
  ClickToCallResult,
  VirtualNumberSummary,
  CreateVirtualNumberBody,
  UpdateVirtualNumberBody,
} from "./calling.types.js";
import type { AuthUser } from "@/middlewares/auth.js";

const PROVIDER = "CALLERDESK";

// CallerDesk's webhook `Status` values mapped to our CallStatus enum.
// "answer" confirmed from real webhook traffic (2026-09-23); the rest are still guesses
// pending real samples — unmapped values fall back to the duration/recording heuristic below.
const STATUS_MAP: Record<string, CallStatus> = {
  answer: CallStatus.COMPLETED,
  answered: CallStatus.COMPLETED,
  "agent engaged": CallStatus.AGENT_ANSWERED,
  busy: CallStatus.BUSY,
  abandonment: CallStatus.NO_ANSWER,
  cancel: CallStatus.FAILED,
};

// Fallback when the raw Status string doesn't match anything in STATUS_MAP (their exact
// wording was never confirmed against real webhook traffic). A recording or non-zero
// duration is strong evidence the call actually connected, so don't blindly mark it FAILED —
// that overwrites a call that clearly succeeded with a wrong status.
function mapWebhookStatus(status: string | undefined, hasSignalOfConnection: boolean): CallStatus {
  if (status) {
    const mapped = STATUS_MAP[status.trim().toLowerCase()];
    if (mapped) return mapped;
    logger.warn(`[callerdesk] unrecognized webhook Status="${status}" — falling back on duration/recording signal`);
  }
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
      include: { agent: { select: { id: true, name: true } }, recording: true },
      orderBy: { createdAt: "desc" },
    });

    // Salespersons see their own call log (status, duration) but can't hear the
    // recording — only managers/admins can listen.
    if (user.role === Role.SALESPERSON) {
      return calls.map((call) => (call.recording ? { ...call, recording: { ...call.recording, recordingUrl: null } } : call));
    }
    return calls;
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
      throw new ApiError("Missing campid/CallSid in webhook payload", STATUS_CODES.BAD_REQUEST);
    }

    const call = await prisma.call.findFirst({ where: { provider: PROVIDER, providerCallId: String(providerCallId) } });
    if (!call) {
      logger.warn(`[callerdesk] webhook for unknown call id=${providerCallId} — ignoring`);
      return;
    }

    logger.info(`[callerdesk] webhook payload for call=${call.id}: ${JSON.stringify(payload)}`);

    const durationSeconds = toSeconds(payload.CallDuration ?? payload.TalkDuration);
    const status = mapWebhookStatus(payload.Status, Boolean(durationSeconds) || Boolean(payload.CallRecordingUrl));

    await prisma.call.update({
      where: { id: call.id },
      data: {
        status,
        answeredAt: status === CallStatus.COMPLETED || status === CallStatus.AGENT_ANSWERED ? new Date() : call.answeredAt,
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
