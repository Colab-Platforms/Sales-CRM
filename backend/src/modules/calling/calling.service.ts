import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import { triggerClickToCall } from "./callerdesk.client.js";
import { ApplicationStatus, CallDirection, CallStatus, VirtualNumberStatus, ActivityType, Role, TaskType, WorkStatus } from "../../../generated/prisma/enums.js";
import { OUTCOME_APPLICATION_STATUS, OUTCOME_LEAD_STATUS } from "./calling.outcomes.js";
import { completePendingFollowUps, parseFollowUpAt, scheduleFollowUp } from "../tasks/tasks.followup.js";
import { enqueueTranscription } from "./calling.transcription.js";
import { normalizeMobile } from "@/lib/leadIdentity.js";
import {
  agentIdMatchesPlivoFrom,
  buildDialXml,
  buildHangupXml,
  createBrowserToken,
  publicBackendUrl,
} from "./plivo.client.js";
import { attendanceService } from "../attendance/attendance.service.js";
import { ENDED_CALL_STATUSES } from "../attendance/attendance.constants.js";
import type {
  CallerDeskWebhookPayload,
  ClickToCallResult,
  WebCallResult,
  PlivoWebhookParams,
  VirtualNumberSummary,
  CreateVirtualNumberBody,
  UpdateVirtualNumberBody,
  SubmitCallOutcomeBody,
} from "./calling.types.js";
import type { AuthUser } from "@/middlewares/auth.js";

const PROVIDER = "CALLERDESK";
const PLIVO_PROVIDER = "PLIVO";
// A web call row is single-use: the browser must reach the answer URL within this window of creating it.
const WEB_CALL_ANSWER_WINDOW_MS = 2 * 60 * 1000;

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
  // Hangup-style values a live_call ping may carry when either side cuts the call. Unconfirmed
  // guesses - the warn log in mapWebhookStatus prints the real string if one still slips through.
  hangup: CallStatus.COMPLETED,
  "customer hangup": CallStatus.COMPLETED,
  "agent hangup": CallStatus.COMPLETED,
  completed: CallStatus.COMPLETED,
  disconnected: CallStatus.COMPLETED,
  "no answer": CallStatus.NO_ANSWER,
  noanswer: CallStatus.NO_ANSWER,
};

const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set([
  CallStatus.COMPLETED,
  CallStatus.NO_ANSWER,
  CallStatus.BUSY,
  CallStatus.NOT_REACHABLE,
  CallStatus.FAILED,
]);

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
    const normalized = status.trim().toLowerCase();
    const mapped = STATUS_MAP[normalized];
    if (mapped) return mapped;
    // Real final-report values look like "cancel-Customer" (customer cut/never picked up).
    // "cancel-Customer" / "cancel-Agent": someone hung up before any conversation - no answer either way.
    if (isFinalReport && normalized.startsWith("cancel")) {
      return hasSignalOfConnection ? CallStatus.COMPLETED : CallStatus.NO_ANSWER;
    }
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
    if (virtualNumber.provider.toUpperCase() === PLIVO_PROVIDER) {
      throw new ApiError("This number is for browser calls only - use the browser call button", STATUS_CODES.BAD_REQUEST);
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

      // Shift tracking must never break calling.
      attendanceService
        .setSystemStatus(agent.id, WorkStatus.ON_CALL)
        .catch((e) => logger.error("[attendance] could not set ON_CALL", e));

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
        transcript: { select: { transcriptText: true, diarizedText: true, status: true } },
        outcome: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Salespersons see their own call log (status, duration) but can't hear the recording or read
    // the transcript — only managers/admins can, same gate as the recording itself.
    if (user.role === Role.SALESPERSON) {
      return calls.map((call) => ({
        ...call,
        recording: call.recording ? { ...call.recording, recordingUrl: null } : null,
        transcript: null,
      }));
    }
    return calls;
  }

  // Manager/admin-only, same gate as the recording/transcript fields in listCallsForLead - backs the
  // transcript SSE stream's initial check and its authorization (a call this user can't see a
  // transcript for also isn't one they should be allowed to open a stream for).
  async getTranscriptForCall(user: AuthUser, callId: string) {
    if (user.role === Role.SALESPERSON || user.role === Role.RECRUITER) throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);

    const call = await prisma.call.findUnique({ where: { id: callId }, include: { lead: true, transcript: true } });
    if (!call) throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);
    // A recruiter call (no lead) is only visible to admin/HR.
    if (user.role === Role.MANAGER && (!call.lead || call.lead.assignedManagerId !== user.id)) {
      throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);
    }

    return call.transcript;
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
    const call = await prisma.call.findUnique({ where: { id: callId }, include: { lead: true, application: true } });
    if (!call) throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);

    if (call.application) return this.submitApplicationCallOutcome(user, call, call.application, data);

    const lead = call.lead;
    if (!lead || user.role === Role.RECRUITER || user.role === Role.HR) throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);
    if (user.role === Role.MANAGER && lead.assignedManagerId !== user.id) {
      throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);
    }
    if (user.role === Role.SALESPERSON && lead.ownerId !== user.id) {
      throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);
    }
    if (user.role === Role.SALESPERSON && call.agentId !== user.id) {
      throw new ApiError(
        "You cannot modify feedback or notes from another salesperson. This record is read-only.",
        STATUS_CODES.FORBIDDEN
      );
    }

    const outcome = await prisma.callOutcome.findUnique({ where: { id: data.outcomeId } });
    if (!outcome || !outcome.isActive) throw new ApiError("Unknown call outcome", STATUS_CODES.BAD_REQUEST);
    if (outcome.requiresNote && !data.notes?.trim()) {
      throw new ApiError(`A note is required for "${outcome.name}"`, STATUS_CODES.BAD_REQUEST);
    }

    const newStatus = OUTCOME_LEAD_STATUS[outcome.code];
    // Call back / follow up outcomes need a time to remind the salesperson at.
    const followUpAt = outcome.requiresFollowup ? parseFollowUpAt(data.followUpAt, outcome.name.toLowerCase()) : null;

    await prisma.$transaction(async (tx) => {
      await tx.call.update({ where: { id: callId }, data: { outcomeId: outcome.id, notes: data.notes?.trim() || null } });

      // This call answers whatever reminder was pending on the lead; a new one replaces it if needed.
      await completePendingFollowUps(tx, lead.id);
      if (followUpAt) {
        await scheduleFollowUp(tx, {
          leadId: lead.id,
          leadName: [lead.firstName, lead.lastName].filter(Boolean).join(" "),
          assignedToId: lead.ownerId ?? user.id,
          actor: { id: user.id, role: user.role },
          type: newStatus === "CALL_BACK" ? TaskType.CALLBACK : TaskType.FOLLOW_UP,
          scheduledAt: followUpAt,
          note: data.notes,
        });
      }

      if (newStatus && newStatus !== lead.workingStatus) {
        await tx.lead.update({ where: { id: lead.id }, data: { workingStatus: newStatus } });
      }

      await tx.activity.create({
        data: {
          leadId: lead.id,
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

  // ---- Recruitment: calls on a job application (the recruiter equivalent of a lead call) ----

  private async getApplicationForUserOrThrow(user: AuthUser, applicationId: string) {
    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    // 404 rather than 403 so an application someone else holds is indistinguishable from a missing one.
    if (!application) throw new ApiError("Application not found", STATUS_CODES.NOT_FOUND);
    if (user.role === Role.RECRUITER && application.recruiterId !== user.id) {
      throw new ApiError("Application not found", STATUS_CODES.NOT_FOUND);
    }
    return application;
  }

  async initiateApplicationCall(user: AuthUser, applicationId: string, virtualNumberId: string): Promise<ClickToCallResult> {
    const application = await this.getApplicationForUserOrThrow(user, applicationId);
    if (user.role !== Role.RECRUITER) throw new ApiError("Only the assigned recruiter can call an applicant", STATUS_CODES.FORBIDDEN);

    const agent = await prisma.user.findUnique({ where: { id: user.id } });
    if (!agent?.phone) {
      throw new ApiError("Your profile has no phone number configured", STATUS_CODES.BAD_REQUEST);
    }

    const virtualNumber = await prisma.virtualNumber.findUnique({ where: { id: virtualNumberId } });
    if (!virtualNumber || virtualNumber.status !== VirtualNumberStatus.ACTIVE) {
      throw new ApiError("Virtual number not found or inactive", STATUS_CODES.BAD_REQUEST);
    }
    if (virtualNumber.provider.toUpperCase() === PLIVO_PROVIDER) {
      throw new ApiError("This number is for browser calls only - use the browser call button", STATUS_CODES.BAD_REQUEST);
    }

    const call = await prisma.call.create({
      data: {
        applicationId: application.id,
        agentId: agent.id,
        virtualNumberId: virtualNumber.id,
        provider: PROVIDER,
        direction: CallDirection.OUTBOUND,
        status: CallStatus.INITIATED,
        agentNumber: agent.phone,
        customerNumber: application.mobile,
        startedAt: new Date(),
      },
    });

    try {
      const { providerCallId } = await triggerClickToCall({
        agentNumber: agent.phone,
        customerNumber: application.mobile,
        callerId: virtualNumber.number,
        leadId: application.id,
      });

      const updated = await prisma.call.update({
        where: { id: call.id },
        data: { providerCallId, status: CallStatus.RINGING_AGENT },
      });

      attendanceService
        .setSystemStatus(agent.id, WorkStatus.ON_CALL)
        .catch((e) => logger.error("[attendance] could not set ON_CALL", e));

      return { callId: updated.id, status: updated.status };
    } catch (error: any) {
      await prisma.call.update({
        where: { id: call.id },
        data: { status: CallStatus.FAILED, notes: error.message ?? "Failed to initiate call" },
      });
      throw error;
    }
  }

  async listCallsForApplication(user: AuthUser, applicationId: string) {
    await this.getApplicationForUserOrThrow(user, applicationId);
    const calls = await prisma.call.findMany({
      where: { applicationId },
      include: {
        agent: { select: { id: true, name: true } },
        recording: true,
        outcome: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    // Recruiters see their call log but, like salespersons, can't play the recording back.
    if (user.role === Role.RECRUITER) {
      return calls.map((call) => ({ ...call, recording: call.recording ? { ...call.recording, recordingUrl: null } : null }));
    }
    return calls;
  }

  private async submitApplicationCallOutcome(
    user: AuthUser,
    call: { id: string; agentId: string },
    application: { id: string; status: ApplicationStatus; recruiterId: string | null },
    data: SubmitCallOutcomeBody,
  ) {
    if (user.role !== Role.RECRUITER || application.recruiterId !== user.id || call.agentId !== user.id) {
      throw new ApiError("Call not found", STATUS_CODES.NOT_FOUND);
    }

    const outcome = await prisma.callOutcome.findUnique({ where: { id: data.outcomeId } });
    if (!outcome || !outcome.isActive) throw new ApiError("Unknown call outcome", STATUS_CODES.BAD_REQUEST);
    if (outcome.requiresNote && !data.notes?.trim()) {
      throw new ApiError(`A note is required for "${outcome.name}"`, STATUS_CODES.BAD_REQUEST);
    }

    const newStatus = OUTCOME_APPLICATION_STATUS[outcome.code];
    const note = data.notes?.trim() || null;

    await prisma.$transaction(async (tx) => {
      await tx.call.update({ where: { id: call.id }, data: { outcomeId: outcome.id, notes: note } });
      await tx.application.update({
        where: { id: application.id },
        data: { ...(newStatus ? { status: newStatus } : {}), ...(note ? { notes: note } : {}) },
      });
    });

    return prisma.call.findUnique({
      where: { id: call.id },
      include: { agent: { select: { id: true, name: true } }, recording: true, outcome: true },
    });
  }

  // ---- Browser (Plivo WebRTC) calling ----

  // Plivo only accepts numbers it rents to us as caller ID (anything else fails with PLIVO_UNKNOWN_CALLER_ID),
  // so a browser call must use a PLIVO virtual number.
  private async getActiveVirtualNumberOrThrow(virtualNumberId: string) {
    const virtualNumber = await prisma.virtualNumber.findUnique({ where: { id: virtualNumberId } });
    if (!virtualNumber || virtualNumber.status !== VirtualNumberStatus.ACTIVE) {
      throw new ApiError("Virtual number not found or inactive", STATUS_CODES.BAD_REQUEST);
    }
    if (virtualNumber.provider.toUpperCase() !== PLIVO_PROVIDER) {
      throw new ApiError("Browser calls need a Plivo number as caller ID", STATUS_CODES.BAD_REQUEST);
    }
    return virtualNumber;
  }

  // Plivo wants digits only with the country code (919876543210), no "+".
  private toDialNumber(raw: string | null | undefined): string {
    const normalized = normalizeMobile(raw);
    if (!normalized) throw new ApiError("Phone number is not valid for calling", STATUS_CODES.BAD_REQUEST);
    return normalized.replace(/\D/g, "");
  }

  private async createWebCall(
    agentId: string,
    target: { leadId: string } | { applicationId: string },
    dialNumber: string,
    virtualNumber: { id: string },
  ): Promise<WebCallResult> {
    const call = await prisma.call.create({
      data: {
        ...target,
        agentId,
        virtualNumberId: virtualNumber.id,
        provider: PLIVO_PROVIDER,
        direction: CallDirection.OUTBOUND,
        status: CallStatus.INITIATED,
        customerNumber: dialNumber,
        startedAt: new Date(),
      },
    });

    try {
      const { token, username, expiresInSeconds } = await createBrowserToken(agentId);
      return {
        callId: call.id,
        status: call.status,
        token,
        username,
        tokenExpiresInSeconds: expiresInSeconds,
        destination: dialNumber,
      };
    } catch (error: any) {
      await prisma.call.update({
        where: { id: call.id },
        data: { status: CallStatus.FAILED, notes: error.message ?? "Failed to start web call" },
      });
      throw error;
    }
  }

  async initiateWebCall(user: AuthUser, leadId: string, virtualNumberId: string): Promise<WebCallResult> {
    const lead = await this.getLeadOrThrow(leadId);
    if (user.role === Role.MANAGER && lead.assignedManagerId !== user.id) {
      throw new ApiError("Lead not found", STATUS_CODES.NOT_FOUND);
    }
    if (user.role === Role.SALESPERSON && lead.ownerId !== user.id) {
      throw new ApiError("Lead not found", STATUS_CODES.NOT_FOUND);
    }
    const dialNumber = this.toDialNumber(lead.mobile);
    const virtualNumber = await this.getActiveVirtualNumberOrThrow(virtualNumberId);

    const result = await this.createWebCall(user.id, { leadId: lead.id }, dialNumber, virtualNumber);

    await prisma.activity.create({
      data: {
        leadId: lead.id,
        actorId: user.id,
        type: ActivityType.CALL,
        referenceType: "CALL",
        referenceId: result.callId,
        title: "Call initiated",
        description: `Browser call to ${lead.mobile} via ${virtualNumber.displayName ?? virtualNumber.number}`,
      },
    });
    return result;
  }

  async initiateApplicationWebCall(user: AuthUser, applicationId: string, virtualNumberId: string): Promise<WebCallResult> {
    const application = await this.getApplicationForUserOrThrow(user, applicationId);
    if (user.role !== Role.RECRUITER) throw new ApiError("Only the assigned recruiter can call an applicant", STATUS_CODES.FORBIDDEN);
    const dialNumber = this.toDialNumber(application.mobile);
    const virtualNumber = await this.getActiveVirtualNumberOrThrow(virtualNumberId);
    return this.createWebCall(user.id, { applicationId: application.id }, dialNumber, virtualNumber);
  }

  // Plivo hits this when the browser dials. The number to ring comes from our Call row, found through the
  // X-PH-CallId header the browser sent - the row must belong to the dialing endpoint's agent, still be
  // untouched (INITIATED) and fresh, and is claimed atomically so a replay can't dial twice.
  async handlePlivoAnswer(params: PlivoWebhookParams): Promise<string> {
    const callId = params["X-PH-CallId"] ?? params["X-PH-Callid"] ?? params["X-Ph-Callid"];
    const base = publicBackendUrl();
    if (!callId || !base) return buildHangupXml("Call could not be placed.");

    const call = await prisma.call.findFirst({
      where: { id: callId, provider: PLIVO_PROVIDER, status: CallStatus.INITIATED },
      include: { virtualNumber: true },
    });
    const fresh = call?.startedAt && Date.now() - call.startedAt.getTime() <= WEB_CALL_ANSWER_WINDOW_MS;
    if (!call || !fresh || !call.customerNumber || !call.virtualNumber || !agentIdMatchesPlivoFrom(call.agentId, params.From)) {
      logger.warn(`[plivo] rejected answer-url request callId=${callId} from=${params.From}`);
      return buildHangupXml("Call could not be placed.");
    }

    const claimed = await prisma.call.updateMany({
      where: { id: call.id, status: CallStatus.INITIATED },
      data: { status: CallStatus.RINGING_CUSTOMER, providerCallId: params.CallUUID ?? null },
    });
    if (claimed.count === 0) return buildHangupXml("Call could not be placed.");

    attendanceService
      .setSystemStatus(call.agentId, WorkStatus.ON_CALL)
      .catch((e) => logger.error("[attendance] could not set ON_CALL", e));

    return buildDialXml({
      customerNumber: call.customerNumber,
      callerId: this.toDialNumber(call.virtualNumber.number),
      dialCallbackUrl: `${base}/api/webhooks/plivo/dial?callId=${call.id}`,
      recordingCallbackUrl: `${base}/api/webhooks/plivo/recording?callId=${call.id}`,
    });
  }

  // Mid-call state from the <Dial> callback: customer's phone ringing / picked up.
  async handlePlivoDialEvent(callId: string, params: PlivoWebhookParams): Promise<void> {
    const call = await prisma.call.findFirst({ where: { id: callId, provider: PLIVO_PROVIDER } });
    if (!call) return;
    if (TERMINAL_STATUSES.has(call.status)) return;

    const raw = `${params.Event ?? ""} ${params.DialStatus ?? ""} ${params.DialBLegStatus ?? ""} ${params.DialAction ?? ""}`.toLowerCase();
    // The customer leg ended; the hangup webhook sets the final status. Log why, since a rejected leg
    // (e.g. PLIVO_UNKNOWN_CALLER_ID for a caller ID Plivo doesn't own) is otherwise invisible.
    if (/hangup/.test(raw)) {
      logger.info(
        `[plivo] customer leg ended call=${call.id} cause=${params.DialBLegHangupCauseName ?? params.DialBLegHangupCause ?? "unknown"} ` +
          `from=${params.DialBLegFrom} to=${params.DialBLegTo}`,
      );
      return;
    }
    let status: CallStatus | null = null;
    if (/answer|connect/.test(raw)) status = CallStatus.CONNECTED;
    else if (/ring/.test(raw)) status = CallStatus.RINGING_CUSTOMER;

    if (!status) {
      logger.warn(`[plivo] unrecognized dial event for call=${call.id}: ${JSON.stringify(params)}`);
      return;
    }
    if (status === CallStatus.RINGING_CUSTOMER && call.status === CallStatus.CONNECTED) return;

    await prisma.call.update({
      where: { id: call.id },
      data: { status, answeredAt: status === CallStatus.CONNECTED ? (call.answeredAt ?? new Date()) : call.answeredAt },
    });
  }

  // Final word on the call (hangup_url on the Plivo application).
  async handlePlivoHangup(params: PlivoWebhookParams): Promise<void> {
    const callUuid = params.CallUUID;
    if (!callUuid) return;
    const call = await prisma.call.findFirst({ where: { provider: PLIVO_PROVIDER, providerCallId: callUuid } });
    if (!call) {
      logger.warn(`[plivo] hangup for unknown CallUUID=${callUuid} - ignoring`);
      return;
    }

    const endedAt = new Date();
    const spoke = Boolean(call.answeredAt) || call.status === CallStatus.CONNECTED;
    const cause = (params.CallStatus ?? params.HangupCause ?? "").toLowerCase();

    let status: CallStatus;
    if (spoke) status = CallStatus.COMPLETED;
    else if (cause.includes("busy")) status = CallStatus.BUSY;
    else if (cause.includes("fail") || cause.includes("reject") || cause.includes("unreach")) status = CallStatus.FAILED;
    else status = CallStatus.NO_ANSWER;

    const answeredAt = call.answeredAt ?? (spoke ? endedAt : null);
    const durationSeconds = spoke && call.answeredAt ? Math.max(0, Math.round((endedAt.getTime() - call.answeredAt.getTime()) / 1000)) : 0;

    await prisma.call.update({
      where: { id: call.id },
      data: { status, answeredAt, endedAt, durationSeconds },
    });

    attendanceService
      .restoreFromCall(call.agentId)
      .catch((e) => logger.error("[attendance] could not restore status after call", e));

    if (status === CallStatus.NO_ANSWER && !call.outcomeId) {
      await this.autoLogNoAnswer(call.id, call.leadId, call.applicationId, call.agentId).catch((e) =>
        logger.error("[plivo] could not auto-log no-answer outcome", e),
      );
    }

    if (!call.leadId) return;
    await prisma.activity.create({
      data: {
        leadId: call.leadId,
        actorId: call.agentId,
        type: ActivityType.CALL,
        referenceType: "CALL",
        referenceId: call.id,
        title: `Call ${status.toLowerCase().replace("_", " ")}`,
        description: durationSeconds ? `Duration: ${durationSeconds}s` : undefined,
      },
    });
  }

  async handlePlivoRecording(callId: string, params: PlivoWebhookParams): Promise<void> {
    const recordUrl = params.RecordUrl;
    if (!recordUrl) return;
    const call = await prisma.call.findFirst({ where: { id: callId, provider: PLIVO_PROVIDER } });
    if (!call) return;

    const durationSeconds = toSeconds(params.RecordingDuration);
    await prisma.callRecording.upsert({
      where: { callId: call.id },
      create: { callId: call.id, providerRecordingId: params.RecordingID, recordingUrl: recordUrl, durationSeconds },
      update: { providerRecordingId: params.RecordingID, recordingUrl: recordUrl, durationSeconds },
    });
    void enqueueTranscription(call.id);
  }

  verifyWebhookSecret(headers: Record<string, unknown>, query: Record<string, unknown>): boolean {
    const expected = process.env.CALLERDESK_WEBHOOK_SECRET;
    if (!expected) return true; // not configured yet — accept until a secret is set up
    const provided = headers["x-callerdesk-secret"] ?? query["secret"];
    return provided === expected;
  }

  private async autoLogNoAnswer(callId: string, leadId: string | null, applicationId: string | null, agentId: string): Promise<void> {
    const outcome = await prisma.callOutcome.findFirst({ where: { code: "RINGING_NO_ANSWER", isActive: true } });
    if (!outcome) return;

    if (!leadId) {
      if (!applicationId) return;
      await prisma.$transaction(async (tx) => {
        await tx.call.update({ where: { id: callId }, data: { outcomeId: outcome.id } });
        await tx.application.update({ where: { id: applicationId }, data: { status: ApplicationStatus.RINGING } });
      });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.call.update({ where: { id: callId }, data: { outcomeId: outcome.id } });
      const newStatus = OUTCOME_LEAD_STATUS[outcome.code];
      if (newStatus) await tx.lead.update({ where: { id: leadId }, data: { workingStatus: newStatus } });
      await tx.activity.create({
        data: {
          leadId,
          actorId: agentId,
          type: ActivityType.STATUS_CHANGE,
          referenceType: "CALL",
          referenceId: callId,
          title: `Call outcome: ${outcome.name}`,
          description: "Logged automatically - call was not answered",
        },
      });
    });
  }

  async handleCallWebhook(payload: CallerDeskWebhookPayload): Promise<void> {
    // triggerClickToCall only gets `campid` back at dial time (no CallSid), so that's what
    // we stored as providerCallId — match on it first, falling back to CallSid in case a
    // future trigger response starts returning one instead.
    // A live_call ping with an empty campid is the early "ringing the agent" event (it fires before
    // the agent's leg picks up), so it must not match a call by CallSid and claim we're already
    // dialing the customer. Only the final report may fall back to CallSid.
    const providerCallId = payload.campid || (payload.type === "live_call" ? undefined : payload.CallSid);
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
    // CallDuration includes ring time (58s on a call nobody picked up); only TalkDuration proves the
    // customer actually spoke. Recording URL is present even on unanswered calls, so it's no signal.
    const talkSeconds = toSeconds(payload.TalkDuration);
    const status = mapWebhookStatus(payload.Status, isFinalReport, Boolean(talkSeconds));
    if (status === null) {
      // An unrecognized live_call ping - nothing safe to record yet, wait for the next update.
      return;
    }

    // Webhooks can arrive out of order: a late live_call "Picked" must never drag an already-ended
    // call back to CONNECTED (the UI would show "On call…" forever). Only the final report may
    // revise a terminal call, e.g. to attach the recording and duration.
    if (!isFinalReport && TERMINAL_STATUSES.has(call.status)) {
      logger.info(`[callerdesk] ignoring late live_call ${status} for already-ended call=${call.id} (${call.status})`);
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

    if (ENDED_CALL_STATUSES.has(status)) {
      attendanceService
        .restoreFromCall(call.agentId)
        .catch((e) => logger.error("[attendance] could not restore status after call", e));
    }

    // Nobody spoke, so there's nothing for the salesperson to log: record "Ringing / no answer" for them.
    if (isFinalReport && status === CallStatus.NO_ANSWER && !call.outcomeId) {
      await this.autoLogNoAnswer(call.id, call.leadId, call.applicationId, call.agentId).catch((e) =>
        logger.error("[callerdesk] could not auto-log no-answer outcome", e)
      );
    }

    if (payload.CallRecordingUrl) {
      await prisma.callRecording.upsert({
        where: { callId: call.id },
        create: { callId: call.id, recordingUrl: payload.CallRecordingUrl, durationSeconds },
        update: { recordingUrl: payload.CallRecordingUrl, durationSeconds },
      });
      // Fire-and-forget: queues the job and returns immediately, so this webhook's response never
      // waits on transcription (which happens off-request - see calling.transcription.ts).
      void enqueueTranscription(call.id);
    }

    // Recruiter calls have no lead, so nothing to put on a lead's activity timeline.
    if (!call.leadId) return;

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
