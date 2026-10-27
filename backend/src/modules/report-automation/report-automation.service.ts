import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { buildReportData, fitDetailText, localInstant, periodLabel, resolvePeriod, shiftDate, type ReportPeriod, liveSources, localParts, normalizeOptions, parseSendTime, toTemplateParam, type ReportSources } from "./report-automation.report.js";
import { buildReportXlsx, reportFilename } from "./report-automation.xlsx.js";
import { classifyReportTemplates, createWhatsAppReportDetailSender, createWhatsAppReportDocumentSender, createWhatsAppReportSender, REPORT_TEMPLATE_NAME, ReportSendRejected, WINDOW_CLOSED_REASON, type ReportDetailSender, type ReportDocumentSender, type ReportSender } from "./report-automation.sender.js";
import { buildStructuredValues, type StructuredValues, type TemplateMetricsLoader } from "./report-automation.template-metrics.js";
import { loadTemplateMetrics } from "./report-automation.template-metrics.load.js";
import { normalizeMobile } from "@/lib/leadIdentity.js";
import { computeServiceWindow } from "../whatsapp/whatsapp.freetext.service.js";
import { recomputeRunStatus } from "./report-automation.run.js";
import type { ConfigInput } from "./report-automation.validators.js";

// WHATSAPP REPORT AUTOMATION. Admin and Manager only (checked here as well as on the routes). One automation per user: its owner's scope decides whose numbers are in the report; it can have several
// recipients, and each recipient has its OWN delivery result for every run.
//
// Scheduled delivery, on each tick, for every enabled automation:
//   1. due? local time in the automation's timezone has reached the send time (and stays due for the rest of that local day, so a restart, a sleeping host that wakes later, or a late start still sends that
//      day's report - once);
//   2. the day's RUN row (kind SCHEDULED, dedupeKey "<automation>:<report date>") is inserted with ON CONFLICT DO NOTHING - the unique index, not memory, decides who owns the day; the recipient list is
//      copied into per-recipient rows when the run is created;
//   3. each recipient row is CLAIMED with a compare-and-set (PENDING|FAILED -> SENDING at the same attempt count): only one instance can win a recipient, however many instances or ticks run;
//   4. the report is built once and sent to each claimed recipient independently. A definite refusal -> that recipient FAILED (retried after 5 and 15 minutes, 3 attempts in all). No answer from the
//      provider (timeout) -> that recipient UNCERTAIN: it may have been accepted, so it is NEVER re-sent automatically. A row left SENDING by a crash becomes UNCERTAIN for the same reason.
//      One recipient failing never stops the others.
// A test send is its own run (kind TEST, no dedupe key): it can never block, replace or be counted as the scheduled report.
// SENT = the provider ACCEPTED the message. DELIVERED / READ only ever come from the provider's own callbacks (report-automation.status.ts).

export const MAX_ATTEMPTS = 3;
export const RETRY_DELAYS_MIN = [5, 15];
export const STALE_SENDING_MS = 5 * 60_000;
export const MAX_RECIPIENTS = 10;
/** A scheduled occurrence that finds the server down is still sent for up to this long after its time (a restart, a deploy, a sleeping host that wakes). Later than that it is NOT sent - it is recorded as
 *  Missed, so nobody receives a stale "daily" report hours late and the page says what happened. */
/** One scheduled occurrence = one local date at one saved send time. Its run is owned by the unique key below, so repeated ticks, restarts and several instances can never create a second run for it, while
 *  changing the saved time (e.g. to test again later the same day) is a new occurrence that is sent at its new time. */
const periodOf = (a: { reportFor: string; reportDataDate: string | null }, anchor: string): ReportPeriod => resolvePeriod(a.reportFor, a.reportDataDate, anchor);
const periodKey = (p: ReportPeriod): string => (p.from === p.to ? p.to : `${p.from}_${p.to}`);
const occurrenceKey = (a: { id: string; sendTime: string; reportFor: string; reportDataDate: string | null }, occurrenceDate: string): string => `${a.id}:${occurrenceDate}:${a.sendTime}:${periodKey(periodOf(a, occurrenceDate))}`;
export const CATCH_UP_MS = 3 * 60 * 60_000;
export const MANUAL_RETRY_MAX_ATTEMPTS = 8;
/** A scheduler that has not ticked for this long is reported as not running. */
export const SCHEDULER_STALE_MS = 3 * 60_000;
/** A reply only releases a scheduled report from the last 48 hours; an older, never-opened report stays a manual retry. */
export const REPLY_LOOKBACK_MS = 48 * 60 * 60_000;

export interface ReportServiceDeps {
  now?: () => Date;
  sources?: ReportSources;
  send?: ReportSender;
  sendDocument?: ReportDocumentSender;
  sendDetail?: ReportDetailSender;
  /** Is the recipient inside WhatsApp's 24-hour customer-service window? Default: look for an inbound Meta message from that number. */
  windowOpen?: (phone: string, now: Date) => Promise<boolean>;
  /** The website-order and abandoned-checkout figures for the structured template. Default: the Orders Dashboard services (read-only). Only called if the approved template declares those variables. */
  templateMetrics?: TemplateMetricsLoader;
}

type DeliverAutomation = { id: string; templateName: string | null; languageCode: string; timezone: string; options: unknown; includedUserIds?: unknown };
const asIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** The two parts of a new recipient row: text (the template message) and the Excel document, each SKIPPED when switched off. */
const initialParts = (a: { sendText: boolean; sendExcel: boolean }, textStart: "PENDING" | "SENDING") => ({
  status: (a.sendText ? textStart : "SKIPPED") as "PENDING" | "SENDING" | "SKIPPED",
  attempts: a.sendText && textStart === "SENDING" ? 1 : 0,
  txtStatus: (a.sendText ? "PENDING" : "SKIPPED") as "PENDING" | "SKIPPED",
  docStatus: (a.sendExcel ? "PENDING" : "SKIPPED") as "PENDING" | "SKIPPED",
});

type AutomationRow = Prisma.ReportAutomationGetPayload<{ include: { recipients: true } }>;
type RunRow = Prisma.ReportDeliveryGetPayload<{ include: { recipientResults: true } }>;
type RecipientResult = Prisma.ReportDeliveryRecipientGetPayload<object>;

export const maskPhone = (phone: string): string => (phone.length <= 6 ? phone : `${phone.slice(0, 3)}${"•".repeat(phone.length - 5)}${phone.slice(-2)}`);

const mapRecipient = (r: RecipientResult) => ({
  id: r.id,
  name: r.name,
  phone: maskPhone(r.phone),
  status: r.status,
  attempts: r.attempts,
  lastAttemptAt: r.lastAttemptAt,
  nextAttemptAt: r.nextAttemptAt,
  error: r.error,
  providerMessageId: r.providerMessageId,
  sentAt: r.sentAt,
  deliveredAt: r.deliveredAt,
  readAt: r.readAt,
  // only a DEFINITE failure can be retried; an accepted or unknown-outcome message is never re-sent
  canRetry: r.status === "FAILED",
  detail: {
    status: r.txtStatus,
    attempts: r.txtAttempts,
    lastAttemptAt: r.txtLastAttemptAt,
    error: r.txtError,
    providerMessageId: r.txtProviderMessageId,
    sentAt: r.txtSentAt,
    deliveredAt: r.txtDeliveredAt,
    readAt: r.txtReadAt,
    canRetry: r.txtStatus === "FAILED" || r.txtStatus === "WAITING_FOR_REPLY",
  },
  document: {
    status: r.docStatus,
    attempts: r.docAttempts,
    lastAttemptAt: r.docLastAttemptAt,
    error: r.docError,
    providerMessageId: r.docProviderMessageId,
    sentAt: r.docSentAt,
    deliveredAt: r.docDeliveredAt,
    readAt: r.docReadAt,
    // the Excel can be retried on its own once it definitely failed and the text is accepted (or off)
    canRetry: r.docStatus === "FAILED" || r.docStatus === "WAITING_FOR_REPLY",
  },
});

export const mapRun = (d: RunRow) => ({
  id: d.id,
  kind: d.kind,
  reportDate: d.reportDate,
  reportFrom: d.reportRangeStart ?? d.reportDate,
  scheduledFor: d.scheduledFor,
  status: d.status,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  recipients: [...d.recipientResults].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.phone.localeCompare(b.phone)).map(mapRecipient),
});

const defaultsFor = () => ({ enabled: false, recipients: [] as { id: string; name: string | null; phone: string }[], sendTime: "21:00", timezone: "Asia/Kolkata", reportFor: "TODAY" as "TODAY" | "YESTERDAY" | "DATE" | "LAST7DAYS", dataDate: null as string | null, templateName: null as string | null, languageCode: "en", options: normalizeOptions({}), includedUserIds: [] as string[], sendText: true, sendExcel: true });

const mapConfig = (a: AutomationRow | null) =>
  a
    ? {
        id: a.id,
        enabled: a.enabled,
        recipients: [...a.recipients].sort((x, y) => x.position - y.position || x.createdAt.getTime() - y.createdAt.getTime()).map((r) => ({ id: r.id, name: r.name, phone: r.phone })),
        sendTime: a.sendTime,
        timezone: a.timezone,
        reportFor: a.reportFor as "TODAY" | "YESTERDAY" | "DATE" | "LAST7DAYS",
        dataDate: a.reportDataDate,
        templateName: a.templateName,
        languageCode: a.languageCode,
        options: normalizeOptions(a.options),
        includedUserIds: asIds(a.includedUserIds),
        sendText: a.sendText,
        sendExcel: a.sendExcel,
        updatedAt: a.updatedAt,
      }
    : { id: null, ...defaultsFor(), updatedAt: null };

export interface ReplyOutcome {
  /** true when something was sent (or attempted) because of this message */
  handled: boolean;
  reason: string;
  runId?: string;
  reportDate?: string;
  /** What this reply released, and how each part ended. */
  parts?: { detail?: string; excel?: string };
}

class ReportAutomationService {
  constructor(
    private readonly db: DbClient = prisma,
    private readonly deps: ReportServiceDeps = {},
  ) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private assertAllowed(user: Pick<AuthUser, "role">): void {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
  }

  private loadAutomation(ownerId: string) {
    return this.db.reportAutomation.findUnique({ where: { ownerId }, include: { recipients: true } });
  }

  async getConfig(user: AuthUser) {
    this.assertAllowed(user);
    return mapConfig(await this.loadAutomation(user.id));
  }

  async saveConfig(user: AuthUser, input: ConfigInput) {
    this.assertAllowed(user);
    const recipients = input.recipients;
    if (input.reportFor === "DATE" && input.dataDate && input.dataDate > localParts(this.now(), input.timezone).date) {
      throw new ApiError("The report date cannot be in the future - choose today or an earlier date.", STATUS_CODES.BAD_REQUEST);
    }
    const data = {
      enabled: input.enabled,
      // kept equal to the first recipient so anything still reading the old single-number column sees the same number
      recipient: recipients[0]?.phone ?? null,
      sendTime: input.sendTime,
      timezone: input.timezone,
      reportFor: input.reportFor,
      reportDataDate: input.reportFor === "DATE" ? (input.dataDate ?? null) : null,
      templateName: input.templateName ? input.templateName : null,
      languageCode: input.languageCode,
      options: input.options as unknown as Prisma.InputJsonValue,
      sendText: input.sendText,
      sendExcel: input.sendExcel,
      includedUserIds: [...new Set(input.includedUserIds)] as unknown as Prisma.InputJsonValue,
    };
    // `updatedAt` = when these settings took effect. An occurrence at or after it is scheduled by them; one before it (they were saved after that time today) is not, so saving at 19:00 with a
    // 18:15 send time does not fire an immediate report - the first one is tomorrow. Stamped from the service clock (not the database default) so it is testable and consistent with the scheduler.
    const stamped = { ...data, updatedAt: this.now() };
    const row = await this.db.reportAutomation.upsert({ where: { ownerId: user.id }, create: { ownerId: user.id, ...stamped }, update: stamped });
    // The list is replaced as a set: numbers no longer listed are removed (past history keeps its own copy), the rest are added or renamed in the order given.
    await this.db.reportRecipient.deleteMany({ where: { automationId: row.id, phone: { notIn: recipients.map((r) => r.phone) } } });
    for (const [position, r] of recipients.entries()) {
      await this.db.reportRecipient.upsert({
        where: { automationId_phone: { automationId: row.id, phone: r.phone } },
        create: { automationId: row.id, phone: r.phone, name: r.name || null, position },
        update: { name: r.name || null, position },
      });
    }
    return mapConfig(await this.loadAutomation(user.id));
  }

  /** The report for `date` (default: today in the automation's timezone) exactly as it would be sent - read-only, nothing is stored or sent. */
  async preview(user: AuthUser, date?: string) {
    this.assertAllowed(user);
    const config = mapConfig(await this.loadAutomation(user.id));
    // No date asked for = the SAVED selection (today / yesterday / specific date / previous 7 days) as it would be sent today; an explicit date previews just that one day.
    const period: ReportPeriod = date ? { from: date, to: date } : periodOf({ reportFor: config.reportFor, reportDataDate: config.dataDate }, localParts(this.now(), config.timezone).date);
    const reportDate = period.to;
    const data = await buildReportData({ id: user.id, role: user.role }, period, config.timezone, this.deps.sources ?? liveSources, config.includedUserIds);
    const notification = toTemplateParam(data, config.options, true);
    const detail = fitDetailText(data, config.options);
    // `text` = the detailed report exactly as the free-form WhatsApp message (and the layout of the Excel summary); `whatsappText` = the short template notification
    return { reportDate, reportFrom: period.from, periodLabel: periodLabel(period), timezone: config.timezone, offsetMinutes: data.offsetMinutes, options: config.options, text: detail.text, whatsappText: notification.text, truncated: detail.truncated, data };
  }

  async history(user: AuthUser, page: number, pageSize: number) {
    this.assertAllowed(user);
    const automation = await this.db.reportAutomation.findUnique({ where: { ownerId: user.id }, select: { id: true } });
    if (!automation) return { items: [], pagination: { page, pageSize, totalItems: 0, totalPages: 1 } };
    const where = { automationId: automation.id };
    const [rows, total] = await Promise.all([
      this.db.reportDelivery.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize, include: { recipientResults: true } }),
      this.db.reportDelivery.count({ where }),
    ]);
    return { items: rows.map(mapRun), pagination: { page, pageSize, totalItems: total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
  }

  /** What the page needs to say WHY nothing would be sent: is the scheduler alive, is WhatsApp set up, which approved templates fit. Read-only. */
  async status(user: AuthUser) {
    this.assertAllowed(user);
    const now = this.now();
    const [state, templates, metaConfigs] = await Promise.all([
      this.db.reportSchedulerState.findUnique({ where: { id: 1 } }),
      this.db.whatsAppTemplate.findMany({ where: {}, select: { name: true, provider: true, language: true, variables: true, status: true }, orderBy: [{ name: "asc" }] }),
      this.db.whatsAppConfig.count({ where: { isActive: true } }),
    ]);
    // Report-template candidates: the daily_team_report family, or any template carrying {{report_text}}. Usable ones go in the dropdown; the others are listed WITH the exact reason, never hidden.
    const { usable, unusable } = classifyReportTemplates(templates);
    const ageMs = state?.lastTickAt ? now.getTime() - state.lastTickAt.getTime() : null;
    return {
      scheduler: {
        lastTickAt: state?.lastTickAt ?? null,
        lastSource: state?.lastSource ?? null,
        lastError: state?.lastError ?? null,
        running: ageMs !== null && ageMs <= SCHEDULER_STALE_MS,
        secondsSinceLastTick: ageMs === null ? null : Math.round(ageMs / 1000),
      },
      whatsapp: { metaConfigured: metaConfigs > 0, envProviderConfigured: Boolean(process.env.WHATSAPP_PROVIDER?.trim()), templates: usable, unusableTemplates: unusable },
      externalCronConfigured: Boolean(process.env.REPORT_CRON_SECRET?.trim()),
      nextRun: await this.nextRun(user.id, now),
      lastScheduled: await this.lastScheduled(user.id),
      requiredTemplate: REPORT_TEMPLATE_NAME,
    };
  }

  /** The most recent SCHEDULED run (test sends are never shown here) and what happened to each of its three messages. */
  private async lastScheduled(ownerId: string) {
    const a = await this.db.reportAutomation.findUnique({ where: { ownerId }, select: { id: true } });
    if (!a) return null;
    const run = await this.db.reportDelivery.findFirst({ where: { automationId: a.id, kind: "SCHEDULED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { recipientResults: true } });
    return run ? mapRun(run) : null;
  }

  /** When the next scheduled report goes out, or why none is scheduled. The send time is read in the automation's own timezone (so 18:15 Asia/Kolkata is 12:45 UTC). */
  private async nextRun(ownerId: string, now: Date): Promise<{ at: Date | null; dueNow: boolean; reason: string | null }> {
    const a = await this.loadAutomation(ownerId);
    if (!a) return { at: null, dueNow: false, reason: "Automatic sending has not been set up yet." };
    if (!a.enabled) return { at: null, dueNow: false, reason: "Automatic sending is turned OFF - nothing will be sent on a schedule until you turn it on and save." };
    if (a.recipients.length === 0) return { at: null, dueNow: false, reason: "No recipients are saved." };
    if (!a.sendText && !a.sendExcel) return { at: null, dueNow: false, reason: "Neither the text message nor the Excel file is switched on." };
    if (a.sendText && !a.templateName) return { at: null, dueNow: false, reason: `No template is saved: select "${REPORT_TEMPLATE_NAME}".` };
    // The next occurrence of the SAVED time in the SAVED timezone: yesterday's, today's or tomorrow's local date, whichever is the first that is still to come or is due and not yet run.
    const local = localParts(now, a.timezone);
    const sendMinutes = parseSendTime(a.sendTime);
    for (const offset of [-1, 0, 1]) {
      const occurrenceDate = shiftDate(local.date, offset);
      const at = localInstant(occurrenceDate, sendMinutes, a.timezone);
      if (at.getTime() < a.updatedAt.getTime()) continue; // before these settings were saved: not scheduled by them
      const run = await this.db.reportDelivery.findUnique({ where: { dedupeKey: occurrenceKey(a, occurrenceDate) }, select: { id: true } });
      if (run) continue; // this occurrence (this date at this saved time) already has its run
      if (at.getTime() > now.getTime()) return { at, dueNow: false, reason: null };
      if (now.getTime() - at.getTime() > CATCH_UP_MS) continue; // too old to send; recorded as Missed by the scheduler
      return { at, dueNow: true, reason: "The report is due now and goes out on the next scheduler check." };
    }
    return { at: null, dueNow: false, reason: "No upcoming occurrence could be calculated." };
  }

  // ------------------------------------------------------------------------------------------ test send

  /** A test send: its own TEST run, sent now to the saved recipients (or the chosen ones) with the real template. Never a scheduled run, never auto-retried, never blocks the scheduled report. */
  async sendTest(user: AuthUser, recipientIds?: string[]) {
    this.assertAllowed(user);
    const automation = await this.loadAutomation(user.id);
    const chosen = (automation?.recipients ?? []).filter((r) => !recipientIds || recipientIds.includes(r.id));
    if (!automation || chosen.length === 0) throw new ApiError("Save at least one recipient and the report template before sending a test", STATUS_CODES.BAD_REQUEST);
    if (automation.sendText && !automation.templateName) throw new ApiError("Save at least one recipient and the report template before sending a test", STATUS_CODES.BAD_REQUEST);
    if (!automation.sendText && !automation.sendExcel) throw new ApiError("Turn on the text message, the Excel file, or both", STATUS_CODES.BAD_REQUEST);
    const now = this.now();
    const period = periodOf(automation, localParts(now, automation.timezone).date);
    const run = await this.db.reportDelivery.create({ data: { automationId: automation.id, kind: "TEST", reportDate: period.to, reportRangeStart: period.from === period.to ? null : period.from, recipient: chosen[0]!.phone, status: "SENDING", attempts: 1, scheduledFor: now } });
    await this.db.reportDeliveryRecipient.createMany({ data: chosen.map((r) => ({ deliveryId: run.id, name: r.name, phone: r.phone, ...initialParts(automation, "SENDING") })) });
    const rows = await this.db.reportDeliveryRecipient.findMany({ where: { deliveryId: run.id } });
    await this.deliver(rows.filter((r) => r.status === "SENDING"), automation, { id: user.id, role: user.role }, run.id, period, false, null);
    return mapRun(await this.db.reportDelivery.findUniqueOrThrow({ where: { id: run.id }, include: { recipientResults: true } }));
  }

  /** Retry ONE part (the text message or the Excel document) of ONE recipient whose message definitely failed. Never for an accepted message or one whose outcome is unknown (it may have been
   *  delivered). The other part is never touched, so a retried Excel cannot re-send the text and vice versa. */
  async retryRecipient(user: AuthUser, recipientResultId: string, part: "TEXT" | "DETAIL" | "DOCUMENT" = "TEXT") {
    this.assertAllowed(user);
    const row = await this.db.reportDeliveryRecipient.findUnique({ where: { id: recipientResultId }, include: { delivery: { include: { automation: { include: { recipients: true } } } } } });
    // another user's delivery looks the same as a missing one
    if (!row || row.delivery.automation.ownerId !== user.id) throw new ApiError("Delivery not found", STATUS_CODES.NOT_FOUND);
    const automation = row.delivery.automation;
    const viewer = { id: user.id, role: user.role };
    const notRetryable = new ApiError("Only a delivery that definitely failed can be retried. A message that was accepted, or whose outcome is unknown, is never sent again automatically.", STATUS_CODES.CONFLICT);
    if (part === "TEXT") {
      if (row.status !== "FAILED") throw notRetryable;
      if (row.attempts >= MANUAL_RETRY_MAX_ATTEMPTS) throw new ApiError("This delivery has already been retried the maximum number of times.", STATUS_CODES.CONFLICT);
      if (!automation.templateName) throw new ApiError("No WhatsApp template is configured.", STATUS_CODES.BAD_REQUEST);
      const claim = await this.db.reportDeliveryRecipient.updateMany({ where: { id: row.id, status: "FAILED", attempts: row.attempts }, data: { status: "SENDING", attempts: { increment: 1 }, nextAttemptAt: null, error: null } });
      if (claim.count !== 1) throw new ApiError("This delivery is already being retried.", STATUS_CODES.CONFLICT);
      const claimed = await this.db.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: row.id } });
      await this.deliver([claimed], automation, viewer, row.deliveryId, { from: row.delivery.reportRangeStart ?? row.delivery.reportDate, to: row.delivery.reportDate }, false, [row.id]);
    } else if (part === "DETAIL") {
      if (row.txtStatus !== "FAILED" && row.txtStatus !== "WAITING_FOR_REPLY") throw notRetryable;
      if (row.txtAttempts >= MANUAL_RETRY_MAX_ATTEMPTS) throw new ApiError("The detailed report has already been retried the maximum number of times.", STATUS_CODES.CONFLICT);
      const claim = await this.db.reportDeliveryRecipient.updateMany({ where: { id: row.id, txtStatus: row.txtStatus, txtAttempts: row.txtAttempts }, data: { txtStatus: "SENDING", txtAttempts: { increment: 1 }, txtError: null } });
      if (claim.count !== 1) throw new ApiError("This delivery is already being retried.", STATUS_CODES.CONFLICT);
      await this.deliver([], automation, viewer, row.deliveryId, { from: row.delivery.reportRangeStart ?? row.delivery.reportDate, to: row.delivery.reportDate }, false, [row.id]);
    } else {
      if (row.docStatus !== "FAILED" && row.docStatus !== "WAITING_FOR_REPLY") throw notRetryable;
      if (row.docAttempts >= MANUAL_RETRY_MAX_ATTEMPTS) throw new ApiError("The Excel file has already been retried the maximum number of times.", STATUS_CODES.CONFLICT);
      const claim = await this.db.reportDeliveryRecipient.updateMany({ where: { id: row.id, docStatus: row.docStatus, docAttempts: row.docAttempts }, data: { docStatus: "SENDING", docAttempts: { increment: 1 }, docError: null } });
      if (claim.count !== 1) throw new ApiError("This delivery is already being retried.", STATUS_CODES.CONFLICT);
      await this.deliver([], automation, viewer, row.deliveryId, { from: row.delivery.reportRangeStart ?? row.delivery.reportDate, to: row.delivery.reportDate }, false, [row.id]);
    }
    return mapRecipient(await this.db.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: row.id } }));
  }

  /**
   * A recipient of the Daily Team Report wrote to the business WhatsApp number (any text message). That message opens WhatsApp's 24-hour window, which is exactly what the detailed report and the Excel file
   * were waiting for: the scheduled run could only send the approved template (the short summary) while the window was closed, and marked the free-form parts "Failed - window closed". This sends those two parts
   * now, from the run that was held back, for THAT run's report date and timezone (the report is rebuilt by the same generator - nothing is fabricated or abbreviated).
   *
   * Who may trigger it: only a number that is on the automation's CURRENT recipient list, for an ENABLED automation whose owner is still an active Admin / Manager - the same people the scheduled report goes to.
   * Anyone else gets nothing (no reply, no hint that a report exists). Idempotent: a part is claimed with a compare-and-set (FAILED / PENDING -> SENDING), so a second message, a duplicate webhook or two parallel
   * calls cannot send it twice; a part already SENT, SKIPPED, SENDING or UNCERTAIN is never sent again. A definite provider refusal leaves the part FAILED, so the next reply (or the page's Retry) tries again.
   */
  async sendPendingOnReply(phone: string): Promise<ReplyOutcome> {
    const contact = normalizeMobile(phone);
    if (!contact) return { handled: false, reason: "not a valid phone number" };
    const now = this.now();
    await this.recoverStaleParts(contact);
    const rows = await this.db.reportDeliveryRecipient.findMany({
      where: {
        delivery: { kind: "SCHEDULED", createdAt: { gte: new Date(now.getTime() - REPLY_LOOKBACK_MS) } },
        status: { notIn: ["PENDING", "SENDING"] }, // the notification step of that run is finished (the scheduled run owns it until then)
        OR: [{ txtStatus: { in: ["WAITING_FOR_REPLY", "FAILED", "PENDING"] } }, { docStatus: { in: ["WAITING_FOR_REPLY", "FAILED", "PENDING"] } }],
      },
      include: { delivery: { include: { automation: { include: { recipients: true } } } } },
    });
    const mine = rows
      .filter((r) => normalizeMobile(r.phone) === contact)
      .filter((r) => r.delivery.automation.enabled && r.delivery.automation.recipients.some((x) => normalizeMobile(x.phone) === contact))
      .sort((a, b) => b.delivery.createdAt.getTime() - a.delivery.createdAt.getTime());
    const row = mine[0];
    if (!row) return { handled: false, reason: "no held-back report for this number" };
    const automation = row.delivery.automation;
    const owner = await this.db.user.findUnique({ where: { id: automation.ownerId }, select: { id: true, role: true, status: true } });
    if (!owner || owner.status !== UserStatus.ACTIVE || (owner.role !== Role.ADMIN && owner.role !== Role.MANAGER)) {
      return { handled: false, reason: "the automation's owner is no longer an active Admin or Manager" };
    }

    const claimable = (status: string, attempts: number) => (status === "WAITING_FOR_REPLY" || status === "FAILED" || status === "PENDING") && attempts < MANUAL_RETRY_MAX_ATTEMPTS;
    let detail = false;
    let excel = false;
    if (claimable(row.txtStatus, row.txtAttempts)) {
      detail = (await this.db.reportDeliveryRecipient.updateMany({ where: { id: row.id, txtStatus: row.txtStatus, txtAttempts: row.txtAttempts }, data: { txtStatus: "SENDING", txtAttempts: { increment: 1 }, txtError: null } })).count === 1;
    }
    if (claimable(row.docStatus, row.docAttempts)) {
      excel = (await this.db.reportDeliveryRecipient.updateMany({ where: { id: row.id, docStatus: row.docStatus, docAttempts: row.docAttempts }, data: { docStatus: "SENDING", docAttempts: { increment: 1 }, docError: null } })).count === 1;
    }
    if (!detail && !excel) return { handled: false, reason: "nothing left to send (already sent, being sent, or retried the maximum number of times)", runId: row.deliveryId };

    const period = { from: row.delivery.reportRangeStart ?? row.delivery.reportDate, to: row.delivery.reportDate };
    try {
      await this.deliver([], automation, { id: owner.id, role: owner.role }, row.deliveryId, period, false, [row.id], { txt: detail, doc: excel });
    } catch (error) {
      // An unexpected failure after the parts were claimed: they must not stay "sending" forever. They may or may not have reached the provider, so they are UNCERTAIN (never resent automatically).
      // Conditional on THIS claim (status SENDING and the attempt number this call set), so a part that finished, or one another worker has since claimed, is left exactly as it is.
      const why = "The send was interrupted by an unexpected error before its outcome was recorded. It may have been delivered, so it was not sent again automatically.";
      if (detail) await this.db.reportDeliveryRecipient.updateMany({ where: { id: row.id, txtStatus: "SENDING", txtAttempts: row.txtAttempts + 1 }, data: { txtStatus: "UNCERTAIN", txtError: why, txtLastAttemptAt: this.now() } }).catch(() => undefined);
      if (excel) await this.db.reportDeliveryRecipient.updateMany({ where: { id: row.id, docStatus: "SENDING", docAttempts: row.docAttempts + 1 }, data: { docStatus: "UNCERTAIN", docError: why, docLastAttemptAt: this.now() } }).catch(() => undefined);
      await recomputeRunStatus(this.db, row.deliveryId).catch(() => undefined);
      logger.error(`Report reply: delivery for run ${row.deliveryId} failed after its parts were claimed; they were marked uncertain`, error instanceof Error ? error.message.split(String.fromCharCode(10))[0] : "unknown error");
      throw error;
    }
    const after = await this.db.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: row.id } });
    return { handled: true, reason: "sent on the recipient's reply", runId: row.deliveryId, reportDate: row.delivery.reportDate, parts: { ...(detail ? { detail: after.txtStatus } : {}), ...(excel ? { excel: after.docStatus } : {}) } };
  }

  /**
   * Parts of THIS number's reports left "sending" for longer than STALE_SENDING_MS were interrupted (a restart, a crash): the provider may or may not have accepted them, so they become UNCERTAIN - never FAILED
   * (which a retry would resend) and never resent automatically. Same state transition and timeout the scheduled run applies to its own occurrence; here it also covers runs the scheduler no longer revisits.
   * Each update is conditional on the status AND attempt number read here, so a part another worker has meanwhile finished or re-claimed is not overwritten.
   */
  private async recoverStaleParts(contact: string): Promise<void> {
    const stale = new Date(this.now().getTime() - STALE_SENDING_MS);
    const rows = await this.db.reportDeliveryRecipient.findMany({
      where: { updatedAt: { lt: stale }, OR: [{ status: "SENDING" }, { txtStatus: "SENDING" }, { docStatus: "SENDING" }] },
      select: { id: true, phone: true, deliveryId: true, status: true, attempts: true, txtStatus: true, txtAttempts: true, docStatus: true, docAttempts: true },
    });
    const interrupted = "The send was interrupted (restart or crash) before the outcome was recorded. It may have been delivered, so it was not sent again automatically.";
    const runs = new Set<string>();
    for (const r of rows.filter((x) => normalizeMobile(x.phone) === contact)) {
      let changed = 0;
      if (r.status === "SENDING") changed += (await this.db.reportDeliveryRecipient.updateMany({ where: { id: r.id, status: "SENDING", attempts: r.attempts }, data: { status: "UNCERTAIN", error: interrupted } })).count;
      if (r.txtStatus === "SENDING") changed += (await this.db.reportDeliveryRecipient.updateMany({ where: { id: r.id, txtStatus: "SENDING", txtAttempts: r.txtAttempts }, data: { txtStatus: "UNCERTAIN", txtError: interrupted } })).count;
      if (r.docStatus === "SENDING") changed += (await this.db.reportDeliveryRecipient.updateMany({ where: { id: r.id, docStatus: "SENDING", docAttempts: r.docAttempts }, data: { docStatus: "UNCERTAIN", docError: interrupted } })).count;
      if (changed > 0) runs.add(r.deliveryId);
    }
    for (const id of runs) await recomputeRunStatus(this.db, id);
  }

  // ------------------------------------------------------------------------------------------ scheduling

  /** One scheduler tick. Safe to call from several processes at once and after any restart. Records a heartbeat so the page can show whether ticks are really happening. */
  /** A part that has waited for a reply longer than REPLY_LOOKBACK_MS is closed as FAILED (so it gets the normal manual Retry) - conditional on still waiting, so a reply that released it meanwhile wins. */
  private async expireWaitingParts(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - REPLY_LOOKBACK_MS);
    const why = "No reply was received within 48 hours, so the report was not sent. Ask the recipient to message the business number, then press Retry.";
    const old = { delivery: { kind: "SCHEDULED" as const, createdAt: { lt: cutoff } } };
    const t = await this.db.reportDeliveryRecipient.findMany({ where: { ...old, txtStatus: "WAITING_FOR_REPLY" }, select: { deliveryId: true } });
    const d = await this.db.reportDeliveryRecipient.findMany({ where: { ...old, docStatus: "WAITING_FOR_REPLY" }, select: { deliveryId: true } });
    await this.db.reportDeliveryRecipient.updateMany({ where: { ...old, txtStatus: "WAITING_FOR_REPLY" }, data: { txtStatus: "FAILED", txtError: why } });
    await this.db.reportDeliveryRecipient.updateMany({ where: { ...old, docStatus: "WAITING_FOR_REPLY" }, data: { docStatus: "FAILED", docError: why } });
    for (const id of new Set([...t, ...d].map((x) => x.deliveryId))) await recomputeRunStatus(this.db, id);
  }

  async runDue(source: "scheduler" | "cron" = "scheduler"): Promise<{ checked: number; started: number }> {
    await this.expireWaitingParts().catch((error) => logger.error("Expiring report parts that waited for a reply failed", error instanceof Error ? error.message : String(error)));
    const automations = await this.db.reportAutomation.findMany({ where: { enabled: true }, include: { recipients: true } });
    let started = 0;
    let lastError: string | null = null;
    for (const automation of automations) {
      try {
        if (await this.processScheduled(automation)) started++;
      } catch (error) {
        lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        logger.error(`Report automation ${automation.id} tick failed`, lastError);
      }
    }
    try {
      const state = { lastTickAt: this.now(), lastChecked: automations.length, lastStarted: started, lastError, lastSource: source };
      await this.db.reportSchedulerState.upsert({ where: { id: 1 }, create: { id: 1, ...state }, update: state });
    } catch (error) {
      logger.error("Report scheduler heartbeat could not be recorded", error instanceof Error ? error.message : String(error));
    }
    return { checked: automations.length, started };
  }

  /** The occurrences this automation owes right now: the SAVED time on today's and yesterday's local date (yesterday's covers the midnight boundary), each only if it has already passed and was scheduled by
   *  the current settings (at or after they were saved). Within CATCH_UP_MS it is sent; older and never run, it is recorded as Missed. */
  private async processScheduled(automation: AutomationRow): Promise<boolean> {
    const now = this.now();
    const local = localParts(now, automation.timezone);
    const sendMinutes = parseSendTime(automation.sendTime);
    let started = false;
    for (const offset of [-1, 0]) {
      const occurrenceDate = shiftDate(local.date, offset);
      const at = localInstant(occurrenceDate, sendMinutes, automation.timezone);
      if (at.getTime() > now.getTime() || at.getTime() < automation.updatedAt.getTime()) continue; // not due yet / not scheduled by the saved settings
      const period = periodOf(automation, occurrenceDate); // from the SAVED mode / date, relative to the occurrence's day - never the tick's clock
      if (now.getTime() - at.getTime() > CATCH_UP_MS) {
        await this.recordMissed(automation, occurrenceDate, period, at);
        continue;
      }
      if (await this.processOccurrence(automation, occurrenceDate, period)) started = true;
    }
    return started;
  }

  /** An occurrence that nobody was running for (and is too old to send) becomes a visible Missed run - once - instead of silently vanishing or being sent hours late. */
  private async recordMissed(automation: AutomationRow, occurrenceDate: string, period: ReportPeriod, at: Date): Promise<void> {
    const list = [...automation.recipients].sort((a, b) => a.position - b.position);
    if (list.length === 0 || (!automation.sendText && !automation.sendExcel)) return;
    const dedupeKey = occurrenceKey(automation, occurrenceDate);
    if (await this.db.reportDelivery.findUnique({ where: { dedupeKey }, select: { id: true } })) return;
    const created = await this.db.reportDelivery.createMany({ data: [{ automationId: automation.id, kind: "SCHEDULED", reportDate: period.to, reportRangeStart: period.from === period.to ? null : period.from, dedupeKey, recipient: list[0]!.phone, status: "FAILED", scheduledFor: at }], skipDuplicates: true });
    if (created.count !== 1) return; // another instance recorded it
    const run = await this.db.reportDelivery.findUniqueOrThrow({ where: { dedupeKey } });
    const why = `Missed: the report scheduled for this time was not sent because the server was not running within ${CATCH_UP_MS / 3_600_000} hours of it. It was not sent late.`;
    await this.db.reportDeliveryRecipient.createMany({ data: list.map((r) => ({ deliveryId: run.id, name: r.name, phone: r.phone, status: "FAILED" as const, txtStatus: "FAILED" as const, docStatus: "FAILED" as const, error: why, txtError: why, docError: why, lastAttemptAt: this.now() })), skipDuplicates: true });
    await recomputeRunStatus(this.db, run.id);
    logger.error(`Report automation ${automation.id}: scheduled occurrence ${occurrenceDate} missed (server down beyond the catch-up window)`);
  }

  private async processOccurrence(automation: AutomationRow, occurrenceDate: string, period: ReportPeriod): Promise<boolean> {
    const now = this.now();
    const list = [...automation.recipients].sort((a, b) => a.position - b.position);
    if (list.length === 0) return false;
    if (!automation.sendText && !automation.sendExcel) return false;
    const dedupeKey = occurrenceKey(automation, occurrenceDate);

    // The unique dedupeKey decides, atomically, who owns this day's run. DO NOTHING on a repeat - no error, no second row.
    await this.db.reportDelivery.createMany({ data: [{ automationId: automation.id, kind: "SCHEDULED", reportDate: period.to, reportRangeStart: period.from === period.to ? null : period.from, dedupeKey, recipient: list[0]!.phone, status: "PENDING", scheduledFor: now }], skipDuplicates: true });
    const run = await this.db.reportDelivery.findUnique({ where: { dedupeKey } });
    if (!run) return false;
    // The recipient list (and which parts are on) is copied once, when the run is first seen (a recipient added later joins tomorrow's run); a repeat or a crash in between adds nothing twice.
    if ((await this.db.reportDeliveryRecipient.count({ where: { deliveryId: run.id } })) === 0) {
      await this.db.reportDeliveryRecipient.createMany({ data: list.map((r) => ({ deliveryId: run.id, name: r.name, phone: r.phone, ...initialParts(automation, "PENDING") })), skipDuplicates: true });
    }

    // A part left SENDING by a crash may or may not have reached the provider: closed as UNCERTAIN, never re-sent.
    const stale = new Date(now.getTime() - STALE_SENDING_MS);
    const interrupted = "The send was interrupted (restart or crash) before the outcome was recorded. It may have been delivered, so it was not sent again automatically.";
    await this.db.reportDeliveryRecipient.updateMany({ where: { deliveryId: run.id, status: "SENDING", updatedAt: { lt: stale } }, data: { status: "UNCERTAIN", error: interrupted } });
    await this.db.reportDeliveryRecipient.updateMany({ where: { deliveryId: run.id, docStatus: "SENDING", updatedAt: { lt: stale } }, data: { docStatus: "UNCERTAIN", docError: interrupted } });
    await this.db.reportDeliveryRecipient.updateMany({ where: { deliveryId: run.id, txtStatus: "SENDING", updatedAt: { lt: stale } }, data: { txtStatus: "UNCERTAIN", txtError: interrupted } });

    const owner = await this.db.user.findUnique({ where: { id: automation.ownerId }, select: { id: true, role: true, status: true } });
    if (!owner || owner.status !== UserStatus.ACTIVE || (owner.role !== Role.ADMIN && owner.role !== Role.MANAGER)) {
      const why = "The automation's owner is no longer an active Admin or Manager, so the report was not generated.";
      await this.db.reportDeliveryRecipient.updateMany({ where: { deliveryId: run.id, status: "PENDING" }, data: { status: "FAILED", lastAttemptAt: now, error: why } });
      await this.db.reportDeliveryRecipient.updateMany({ where: { deliveryId: run.id, docStatus: "PENDING" }, data: { docStatus: "FAILED", docLastAttemptAt: now, docError: why } });
      await this.db.reportDeliveryRecipient.updateMany({ where: { deliveryId: run.id, txtStatus: "PENDING" }, data: { txtStatus: "FAILED", txtLastAttemptAt: now, txtError: why } });
      await recomputeRunStatus(this.db, run.id);
      return false;
    }

    const rows = await this.db.reportDeliveryRecipient.findMany({ where: { deliveryId: run.id } });
    const eligible = rows.filter((r) => r.status === "PENDING" || (r.status === "FAILED" && r.attempts < MAX_ATTEMPTS && r.nextAttemptAt !== null && r.nextAttemptAt <= now));
    const claimed: RecipientResult[] = [];
    for (const r of eligible) {
      // Compare-and-set claim: exactly one caller moves this recipient's text to SENDING at this attempt count.
      const claim = await this.db.reportDeliveryRecipient.updateMany({ where: { id: r.id, status: { in: ["PENDING", "FAILED"] }, attempts: r.attempts }, data: { status: "SENDING", attempts: { increment: 1 }, nextAttemptAt: null, error: null } });
      if (claim.count === 1) claimed.push(await this.db.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: r.id } }));
    }
    const didWork = await this.deliver(claimed, automation, { id: owner.id, role: owner.role }, run.id, { from: run.reportRangeStart ?? run.reportDate, to: run.reportDate }, true, null);
    return didWork;
  }

  /** Build the report ONCE, then send each recipient up to THREE separate WhatsApp messages and record every outcome per recipient and per part:
   *   1. NOTIFICATION - the approved template (`status`): a short headline in {{report_text}};
   *   2. DETAIL - the formatted multi-line report as a free-form text (`txt*`);
   *   3. EXCEL - the .xlsx document (`doc*`).
   *  2 and 3 are free-form messages, which WhatsApp allows only inside the recipient's 24-hour window: when it is closed they are NOT attempted and are marked Failed with the exact restriction (retry after
   *  the recipient writes to the business number). `claimed` = recipients whose notification is already claimed (SENDING); `partIds` limits steps 2-3 to those recipients (null = whole run).
   *  `retryable` = a scheduled run (automatic retries of the notification only). A part that succeeded, or whose outcome is unknown, is never sent again. */
  private async deliver(claimed: RecipientResult[], automation: DeliverAutomation, viewer: { id: string; role: Role }, runId: string, period: ReportPeriod, retryable: boolean, partIds: string[] | null, only?: { txt: boolean; doc: boolean }): Promise<boolean> {
    const at = () => this.now();
    const failNote = async (r: RecipientResult, message: string, status: "FAILED" | "UNCERTAIN") => {
      const retryAt = status === "FAILED" && retryable && r.attempts < MAX_ATTEMPTS ? new Date(at().getTime() + (RETRY_DELAYS_MIN[r.attempts - 1] ?? 15) * 60_000) : null;
      await this.db.reportDeliveryRecipient.update({ where: { id: r.id }, data: { status, error: message.slice(0, 500), lastAttemptAt: at(), nextAttemptAt: retryAt } });
    };
    const failPart = (kind: "txt" | "doc", id: string, message: string, status: "FAILED" | "UNCERTAIN" | "WAITING_FOR_REPLY") =>
      this.db.reportDeliveryRecipient.update({ where: { id }, data: kind === "txt" ? { txtStatus: status, txtError: message.slice(0, 500), txtLastAttemptAt: at() } : { docStatus: status, docError: message.slice(0, 500), docLastAttemptAt: at() } });

    // The structured template's figures (read once per delivery, and only if a send actually needs them): the dashboards' own numbers for this report's dates, labelled with the report date in its timezone.
    let structuredCache: Promise<StructuredValues> | null = null;
    const structuredFor = (who: { id: string; role: Role }, p: ReportPeriod) => (): Promise<StructuredValues> => {
      structuredCache ??= (this.deps.templateMetrics ?? loadTemplateMetrics)(who, { from: p.from, to: p.to }).then((m) => buildStructuredValues(periodLabel({ from: p.from, to: p.to }), m));
      return structuredCache;
    };
    const windows = new Map<string, boolean>();
    const windowOpen = async (phone: string): Promise<boolean> => {
      if (!windows.has(phone)) windows.set(phone, await (this.deps.windowOpen ?? ((p: string, n: Date) => customerWindowOpen(this.db, p, n)))(phone, at()));
      return windows.get(phone)!;
    };
    let data: Awaited<ReturnType<typeof buildReportData>> | null = null;
    const report = async () => (data ??= await buildReportData(viewer, period, automation.timezone, this.deps.sources ?? liveSources, asIds(automation.includedUserIds)));
    const options = normalizeOptions(automation.options);
    let worked = claimed.length > 0;

    // Parts of this run that are due: already claimed (a manual retry), or PENDING once the notification has been tried (a free-form message does not depend on the template message succeeding).
    const duePart = async (kind: "txt" | "doc"): Promise<RecipientResult[]> => {
      if (only && !only[kind]) return []; // a reply sends exactly the parts IT claimed - a part another worker is sending is theirs
      const rows = await this.db.reportDeliveryRecipient.findMany({ where: { deliveryId: runId, ...(partIds ? { id: { in: partIds } } : {}) } });
      const out: RecipientResult[] = [];
      for (const r of rows) {
        const st = kind === "txt" ? r.txtStatus : r.docStatus;
        const attempts = kind === "txt" ? r.txtAttempts : r.docAttempts;
        if (st === "SENDING") out.push(r);
        else if (st === "PENDING" && r.status !== "PENDING" && r.status !== "SENDING") {
          const where = kind === "txt" ? { id: r.id, txtStatus: "PENDING" as const, txtAttempts: attempts } : { id: r.id, docStatus: "PENDING" as const, docAttempts: attempts };
          const data2 = kind === "txt" ? { txtStatus: "SENDING" as const, txtAttempts: { increment: 1 }, txtError: null } : { docStatus: "SENDING" as const, docAttempts: { increment: 1 }, docError: null };
          if ((await this.db.reportDeliveryRecipient.updateMany({ where, data: data2 })).count === 1) out.push(await this.db.reportDeliveryRecipient.findUniqueOrThrow({ where: { id: r.id } }));
        }
      }
      return out;
    };

    // ---- 1. the template notification - ONLY when it is needed. A template is the one message WhatsApp lets a business start; once the recipient's 24-hour window is open the detailed report and the Excel go
    // straight to them, and a short "report follows" message in front of them would just be noise. So on the first attempt, if the free-form parts are on AND the window is open, the template is not sent
    // (recorded as "Not needed", never as a success). If the window is closed it is sent - it is then the only thing that can reach them - and says so. If a free-form message is later refused because the
    // window turned out to be closed after all, the template is sent as the fallback (below).
    const skippedAsRedundant: string[] = [];
    let buildFailed = false;
    if (claimed.length > 0) {
      try {
        await report();
      } catch (error) {
        buildFailed = true;
        logger.error(`Report automation ${automation.id}: building the report failed`, error instanceof Error ? error.message : String(error));
        for (const r of claimed) await failNote(r, "The report could not be generated (database error). Nothing was sent.", "FAILED");
      }
    }
    for (const r of buildFailed ? [] : claimed) {
      try {
        if (r.attempts <= 1 && (r.txtStatus !== "SKIPPED" || r.docStatus !== "SKIPPED") && (await windowOpen(r.phone))) {
          await this.db.reportDeliveryRecipient.update({ where: { id: r.id }, data: { status: "SKIPPED", error: "Not sent - not needed: the recipient's 24-hour window is open, so the detailed report and Excel are sent directly.", lastAttemptAt: at(), nextAttemptAt: null } });
          skippedAsRedundant.push(r.id);
          continue;
        }
        if (!automation.templateName) {
          await failNote(r, "No WhatsApp template is configured. Nothing was sent.", "FAILED");
          continue;
        }
        const text = toTemplateParam(await report(), options, await windowOpen(r.phone)).text;
        const send = this.deps.send ?? createWhatsAppReportSender(this.db);
        const result = await send({ recipient: r.phone, templateName: automation.templateName, languageCode: automation.languageCode, text, structured: structuredFor(viewer, period) });
        await this.db.reportDeliveryRecipient.update({ where: { id: r.id }, data: { status: "SENT", provider: result.provider ?? null, providerMessageId: result.providerMessageId, sentAt: at(), lastAttemptAt: at(), error: null, nextAttemptAt: null } });
      } catch (error) {
        if (error instanceof ReportSendRejected) await failNote(r, error.message, "FAILED");
        else {
          logger.error(`Report automation ${automation.id}: no answer from the WhatsApp provider`, error instanceof Error ? error.message : String(error));
          await failNote(r, "No answer from the WhatsApp provider. The message may have been delivered, so it was not retried automatically.", "UNCERTAIN");
        }
      }
    }

    // ---- 2. the detailed text and 3. the Excel file (free-form: only inside the 24-hour window)
    for (const kind of ["txt", "doc"] as const) {
      const rows = await duePart(kind);
      if (rows.length === 0) continue;
      worked = true;
      let payload: { text?: string; bytes?: Buffer } | null = null;
      try {
        payload = kind === "txt" ? { text: fitDetailText(await report(), options).text } : { bytes: await buildReportXlsx(await report(), options) };
      } catch (error) {
        logger.error(`Report automation ${automation.id}: building the ${kind === "txt" ? "detailed text" : "Excel file"} failed`, error instanceof Error ? error.message : String(error));
        for (const r of rows) await failPart(kind, r.id, "The report could not be generated (database error). Nothing was sent.", "FAILED");
        continue;
      }
      const sendDetail = this.deps.sendDetail ?? createWhatsAppReportDetailSender(this.db);
      const sendDocument = this.deps.sendDocument ?? createWhatsAppReportDocumentSender(this.db, async () => (await this.db.whatsAppTemplate.findFirst({ where: { name: automation.templateName ?? "", status: "APPROVED" }, select: { provider: true } }))?.provider ?? null);
      let mediaId: string | null = null; // the Excel is uploaded once and reused for the other recipients
      for (const r of rows) {
        try {
          if (!(await windowOpen(r.phone))) {
            await failPart(kind, r.id, WINDOW_CLOSED_REASON, "WAITING_FOR_REPLY"); // not a failure: kept until the recipient replies (sendPendingOnReply)
            continue;
          }
          if (kind === "txt") {
            const result = await sendDetail({ recipient: r.phone, text: payload.text! });
            await this.db.reportDeliveryRecipient.update({ where: { id: r.id }, data: { txtStatus: "SENT", txtProviderMessageId: result.providerMessageId, txtSentAt: at(), txtLastAttemptAt: at(), txtError: null } });
          } else {
            const result = await sendDocument({ recipient: r.phone, filename: reportFilename(period.to, period.from), bytes: payload.bytes!, mediaId, caption: `AyushWellness Daily Team Report - ${periodLabel(period)}. Full details attached.` });
            mediaId = result.mediaId;
            await this.db.reportDeliveryRecipient.update({ where: { id: r.id }, data: { docStatus: "SENT", docProviderMessageId: result.providerMessageId, docMediaId: result.mediaId, docSentAt: at(), docLastAttemptAt: at(), docError: null } });
          }
        } catch (error) {
          if (error instanceof ReportSendRejected) await failPart(kind, r.id, error.message, "FAILED");
          else {
            logger.error(`Report automation ${automation.id}: no answer from the WhatsApp provider for the ${kind === "txt" ? "detailed text" : "Excel file"}`, error instanceof Error ? error.message : String(error));
            await failPart(kind, r.id, "No answer from the WhatsApp provider. The message may have been delivered, so it was not retried automatically.", "UNCERTAIN");
          }
        }
      }
    }

    // ---- fallback: a free-form message was refused for the 24-hour window although we believed it open -> the template is the only way left to reach them
    for (const id of skippedAsRedundant) {
      const row = await this.db.reportDeliveryRecipient.findUniqueOrThrow({ where: { id } });
      const windowRefused = (["FAILED", "WAITING_FOR_REPLY"].includes(row.txtStatus) && /24 hours/.test(row.txtError ?? "")) || (["FAILED", "WAITING_FOR_REPLY"].includes(row.docStatus) && /24 hours/.test(row.docError ?? ""));
      if (!windowRefused || !automation.templateName) continue;
      try {
        const send = this.deps.send ?? createWhatsAppReportSender(this.db);
        const result = await send({ recipient: row.phone, templateName: automation.templateName, languageCode: automation.languageCode, text: toTemplateParam(await report(), options, false).text, structured: structuredFor(viewer, period) });
        await this.db.reportDeliveryRecipient.update({ where: { id }, data: { status: "SENT", provider: result.provider ?? null, providerMessageId: result.providerMessageId, sentAt: at(), lastAttemptAt: at(), error: null } });
      } catch (error) {
        await this.db.reportDeliveryRecipient.update({ where: { id }, data: error instanceof ReportSendRejected ? { status: "FAILED", error: error.message.slice(0, 500), lastAttemptAt: at() } : { status: "UNCERTAIN", error: "No answer from the WhatsApp provider. The message may have been delivered, so it was not retried automatically.", lastAttemptAt: at() } });
      }
    }
    await recomputeRunStatus(this.db, runId);
    return worked;
  }
}

/** Is the recipient's 24-hour customer-service window open? True only if that number messaged our Meta business number within the last 24 hours (the same rule the WhatsApp inbox uses for free text). */
export async function customerWindowOpen(db: DbClient, phone: string, now: Date): Promise<boolean> {
  const contact = normalizeMobile(phone);
  if (!contact) return false;
  const last = await db.whatsAppMessage.findFirst({ where: { normalizedContact: contact, provider: "META", direction: "INBOUND" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { receivedAt: true, createdAt: true } });
  return computeServiceWindow(last ? (last.receivedAt ?? last.createdAt) : null, now).open;
}

export default ReportAutomationService;
