import type { DbClient } from "@/lib/leadScope.js";
import { prisma } from "@/lib/prisma.js";
import { getWhatsAppProvider } from "../whatsapp/whatsapp.factory.js";
import { getMetaWhatsAppProvider } from "../whatsapp/whatsapp.meta.factory.js";
import { WhatsAppSendError } from "../whatsapp/whatsapp.provider.js";
import { XLSX_MIME } from "./report-automation.xlsx.js";

// Sends the report through the CRM's EXISTING WhatsApp providers (Meta Cloud API from Settings -> WhatsApp Config, or the env-configured AiSensy / Gupshup) - no new provider, no new credentials.
// A report goes to a number that is usually not a customer and has not messaged the business, so WhatsApp only allows a business-initiated message as an APPROVED TEMPLATE. The automation therefore
// names an approved template whose body has exactly ONE variable; the report text (one line, see toTemplateParam) is that variable.

/** The provider gave a definite "no" (or the setup is incomplete): nothing was sent, so a later retry cannot duplicate. */
export class ReportSendRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportSendRejected";
  }
}

/** THE template the report uses: Utility, one named body variable `report_text`, created and approved by an administrator in the Meta console and then synced into the CRM. No other template is ever used. */
export const REPORT_TEMPLATE_NAME = "daily_team_report";
export const REPORT_TEMPLATE_VARIABLE = "report_text";
/** Meta never lets a deleted template name be reused straight away, so the approved report template may be registered as e.g. "daily_team_report1". The family is "daily_team_report" plus an optional
 *  suffix; what makes a template usable is that, AND that it is approved, AND that its single variable is {{report_text}} - never an unrelated template (webinar_feedback_form, CRM Outbound Test). */
export const isReportTemplateName = (name: string): boolean => /^daily_team_report[A-Za-z0-9_]*$/.test(name);

/** Is this stored template usable by the report sender? The exact reason when not (shown to the admin instead of hiding the template). */
export function evaluateReportTemplate(t: { name: string; status: string; variables: unknown }): { ok: true } | { ok: false; reason: string } {
  if (t.status !== "APPROVED") return { ok: false, reason: `Not approved by the provider yet (status ${t.status})` };
  const list = Array.isArray(t.variables) ? t.variables : [];
  const first = list[0] as unknown;
  const name = typeof first === "string" ? first : first && typeof first === "object" && typeof (first as { name?: unknown }).name === "string" ? (first as { name: string }).name : null;
  if (list.length !== 1 || !name) return { ok: false, reason: `It has ${list.length} variables; the report needs exactly one, {{${REPORT_TEMPLATE_VARIABLE}}}` };
  if (name !== REPORT_TEMPLATE_VARIABLE && name !== "1") return { ok: false, reason: `Its variable is {{${name}}}; the report needs {{${REPORT_TEMPLATE_VARIABLE}}}` };
  return { ok: true };
}

export interface ReportSendInput {
  recipient: string;
  templateName: string;
  languageCode: string;
  text: string;
}

export interface ReportSendResult {
  providerMessageId: string | null;
  /** Which provider accepted it (META / AISENSY / GUPSHUP) - needed to match that provider's delivery callbacks. */
  provider?: string;
}

export type ReportSender = (input: ReportSendInput) => Promise<ReportSendResult>;

const safe = (text: string) => text.replace(/(authorization|bearer|access[_ -]?token|token|secret|password)\s*[:=]?\s*\S+/gi, "[redacted]").replace(/\s+/g, " ").slice(0, 300);

function firstVariableName(variables: unknown): { name: string | null; count: number } {
  const list = Array.isArray(variables) ? variables : [];
  const first = list[0] as unknown;
  const name = typeof first === "string" ? first : first && typeof first === "object" && typeof (first as { name?: unknown }).name === "string" ? (first as { name: string }).name : null;
  return { name, count: list.length };
}

export function createWhatsAppReportSender(db: DbClient = prisma): ReportSender {
  return async (input) => {
    if (!isReportTemplateName(input.templateName)) {
      throw new ReportSendRejected(`The report must use the dedicated template "${REPORT_TEMPLATE_NAME}", not "${input.templateName}". Select it in the settings.`);
    }
    // Templates are identified by name AND language. The saved language may not match how the template was registered (e.g. "en" saved, "en_GB" approved): when the exact language is not
    // approved but the name has ONE approved language, that language is used - it is the only one WhatsApp can accept. Several languages and no match is ambiguous, so it is refused with the list.
    const candidates = await db.whatsAppTemplate.findMany({
      where: { name: input.templateName, status: "APPROVED" },
      select: { name: true, provider: true, providerTemplateId: true, language: true, variables: true },
    });
    // Meta first (the only provider that can also send the Excel), then the saved language; a single approved language is used even if the saved code differs.
    candidates.sort((a, b) => Number(b.provider === "META") - Number(a.provider === "META"));
    const template = candidates.find((t) => t.language === input.languageCode) ?? (new Set(candidates.map((t) => t.language)).size === 1 ? candidates[0] : undefined);
    if (!template) {
      throw new ReportSendRejected(
        candidates.length > 1
          ? `The template "${input.templateName}" is approved in several languages (${candidates.map((t) => t.language).join(", ")}) but not in "${input.languageCode}". Re-select the template in the settings and save.`
          : `No APPROVED WhatsApp template named "${input.templateName}" exists in the CRM. Create it under WhatsApp templates (body with one variable for the report) and wait for approval.`,
      );
    }
    const variable = firstVariableName(template.variables);
    if (variable.count !== 1 || !variable.name) {
      throw new ReportSendRejected(`The template "${template.name}" must have exactly ONE variable (it carries the whole report); it has ${variable.count}.`);
    }
    // Named variable {{report_text}} (every template this CRM syncs from Meta is parameter_format "named"); a positional "1" is accepted for providers that only know positions.
    if (variable.name !== REPORT_TEMPLATE_VARIABLE && !/^1$/.test(variable.name)) {
      throw new ReportSendRejected(`The template "${template.name}" has the variable "${variable.name}" but the report needs {{${REPORT_TEMPLATE_VARIABLE}}}. Recreate it with that variable name, get it approved and sync templates.`);
    }
    const provider = template.provider === "META" ? await getMetaWhatsAppProvider(db) : getWhatsAppProvider();
    if (!provider || provider.id !== template.provider) {
      throw new ReportSendRejected(`WhatsApp (${template.provider}) is not configured, so the report cannot be sent.`);
    }
    try {
      const result = await provider.sendTemplateMessage({
        to: input.recipient,
        templateName: template.provider === "META" ? template.name : (template.providerTemplateId ?? template.name),
        params: [input.text],
        paramNames: [variable.name],
        ...(template.provider === "META" ? { languageCode: template.language } : {}),
      });
      // (the text goes in as the single variable and nowhere else: no media, no extra parameters)
      return { providerMessageId: result.providerMessageId, provider: template.provider };
    } catch (error) {
      // The provider answered and refused: definite, nothing was sent. Anything else (timeout, dropped connection) is NOT known to have failed - see the service.
      if (error instanceof WhatsAppSendError) throw new ReportSendRejected(safe(error.message));
      throw error;
    }
  };
}

// ------------------------------------------------------------------------------------------------ the Excel document

export interface ReportDocumentInput {
  recipient: string;
  filename: string;
  bytes: Buffer;
  caption: string;
  /** A media id already uploaded for this run - reused so the file is uploaded once, not once per recipient. */
  mediaId?: string | null;
}
export interface ReportDocumentResult {
  providerMessageId: string | null;
  mediaId: string;
  provider: string;
}
export type ReportDocumentSender = (input: ReportDocumentInput) => Promise<ReportDocumentResult>;

/** A document is a free-form WhatsApp message (a template cannot carry an arbitrary file), so WhatsApp delivers it only inside the 24-hour customer-service window opened by the recipient's last
 *  message to the business. Outside it Meta answers with error 131047; say what to do instead of a bare code. */
export function explainDocumentError(message: string): string {
  if (/131047|re-?engagement|24 ?hours?|24-hour/i.test(message)) {
    return "WhatsApp only delivers a file inside 24 hours of the recipient's last message to your business number. This recipient has not messaged recently: ask them to send any message (e.g. \"Hi\") to the business number, then Retry the Excel.";
  }
  return message;
}

/** Uploads the .xlsx to the configured provider (Meta Cloud API: POST /{phone-number-id}/media -> media id) and sends it as a document message by that id. Nothing is hosted on a public URL. Only Meta
 *  supports this flow in the CRM today; with AiSensy / Gupshup the document part fails with that exact reason instead of reporting a false success. */
export function createWhatsAppReportDocumentSender(db: DbClient = prisma, templateProvider?: () => Promise<string | null>): ReportDocumentSender {
  return async (input) => {
    const meta = await getMetaWhatsAppProvider(db);
    if (!meta) {
      const which = (await templateProvider?.()) ?? null;
      throw new ReportSendRejected(
        which && which !== "META"
          ? `The Excel file can only be sent through the Meta WhatsApp Cloud API. This report's template is sent through ${which}, which the CRM cannot use to send a file.`
          : "The Excel file can only be sent through the Meta WhatsApp Cloud API, and it is not configured.",
      );
    }
    try {
      const mediaId = input.mediaId || (await meta.uploadMedia(input.bytes, XLSX_MIME, input.filename));
      const result = await meta.sendDocument({ to: input.recipient, mediaId, filename: input.filename, caption: input.caption });
      return { providerMessageId: result.providerMessageId, mediaId, provider: "META" };
    } catch (error) {
      if (error instanceof WhatsAppSendError) throw new ReportSendRejected(explainDocumentError(safe(error.message)));
      throw error;
    }
  };
}

// ------------------------------------------------------------------------------------------------ the detailed text (free-form)

export interface ReportDetailInput {
  recipient: string;
  text: string;
}
export type ReportDetailSender = (input: ReportDetailInput) => Promise<{ providerMessageId: string | null; provider: string }>;

export const WINDOW_CLOSED_REASON =
  "WhatsApp only allows a free-form message (the detailed report and the Excel file) within 24 hours of the recipient's last message to your business number, and that window is closed for this number. Nothing was sent yet: it is sent automatically as soon as the recipient sends any message (e.g. \"Hi\") to the business number, and kept for 48 hours.";

/** Sends the formatted multi-line report as an ordinary WhatsApp text message (Meta Cloud API). Newlines and *bold* are fine in a normal text body. */
export function createWhatsAppReportDetailSender(db: DbClient = prisma): ReportDetailSender {
  return async (input) => {
    const meta = await getMetaWhatsAppProvider(db);
    if (!meta) throw new ReportSendRejected("The detailed report can only be sent through the Meta WhatsApp Cloud API, and it is not configured.");
    try {
      const result = await meta.sendText({ to: input.recipient, body: input.text });
      return { providerMessageId: result.providerMessageId, provider: "META" };
    } catch (error) {
      if (error instanceof WhatsAppSendError) throw new ReportSendRejected(explainDocumentError(safe(error.message)));
      throw error;
    }
  };
}
