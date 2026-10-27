import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { isValidTimezone } from "./report-automation.report.js";
import { isReportTemplateName, REPORT_TEMPLATE_NAME } from "./report-automation.sender.js";

// Recipient: an international number in E.164 form (+, country code, digits). Spaces, dashes and brackets typed by a person are removed first.
export const normalizeRecipient = (value: string): string => value.trim().replace(/[\s\-().]/g, "");
export const E164 = /^\+[1-9]\d{9,14}$/;

const optionsSchema = z
  .object({ teamSummary: z.boolean(), calls: z.boolean(), leads: z.boolean(), sales: z.boolean(), followUps: z.boolean() })
  .refine((o) => o.calls || o.leads || o.sales || o.followUps, { error: "Choose at least one metric group" });

export const MAX_RECIPIENTS = 10;
/** E.164, and an Indian (+91) number must have exactly 10 digits after the country code, starting 6-9. A number one digit short (+91932614025) is valid E.164 but can never match the sender Meta reports (919321614025), so its reply window would stay closed forever. */
export const isValidRecipient = (v: string): boolean => E164.test(v) && (!v.startsWith("+91") || /^\+91[6-9]\d{9}$/.test(v));
const phoneSchema = z.string().trim().max(40).transform(normalizeRecipient).refine(isValidRecipient, { error: "Each recipient must be a WhatsApp number with country code, e.g. +919876543210 (an Indian +91 number has exactly 10 digits after +91)" });
const recipientSchema = z.object({ name: z.string().trim().max(100, { error: "A recipient name can be at most 100 characters" }).optional(), phone: phoneSchema });

// The pre-multi-recipient form sent one "recipient" string; it is still accepted and means a list of one.
const withLegacyRecipient = (body: unknown): unknown => {
  if (body && typeof body === "object" && !("recipients" in body) && typeof (body as { recipient?: unknown }).recipient === "string") {
    const { recipient, ...rest } = body as { recipient: string };
    return { ...rest, recipients: recipient.trim() === "" ? [] : [{ phone: recipient }] };
  }
  return body;
};

const configObject = z
  .object({
    enabled: z.boolean(),
    recipients: z
      .array(recipientSchema)
      .max(MAX_RECIPIENTS, { error: `At most ${MAX_RECIPIENTS} recipients` })
      .refine((list) => new Set(list.map((r) => r.phone)).size === list.length, { error: "The same number is listed more than once" }),
    sendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Send time must be HH:mm (24-hour)" }),
    timezone: z.string().trim().min(1).max(64).refine(isValidTimezone, { error: "Unknown timezone" }),
    reportFor: z.enum(["TODAY", "YESTERDAY", "DATE", "LAST7DAYS"], { error: "reportFor must be TODAY, YESTERDAY, DATE or LAST7DAYS" }),
    dataDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "The report date must be YYYY-MM-DD" }).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, { error: "The report date is not a real calendar date" }).nullish(),
    templateName: z.string().trim().max(150).optional(),
    languageCode: z.string().trim().min(2).max(20).default("en"),
    options: optionsSchema,
    includedUserIds: z.array(z.uuid({ error: "Invalid telecaller id" })).max(200).default([]),
    sendText: z.boolean().default(true),
    sendExcel: z.boolean().default(true),
  })
  .refine((c) => !c.enabled || c.recipients.length > 0, { path: ["recipients"], error: "At least one recipient is required to enable the automation" })
  .refine((c) => !c.enabled || !c.sendText || Boolean(c.templateName), { path: ["templateName"], error: `The approved template "${REPORT_TEMPLATE_NAME}" is required to enable the text message` })
  .refine((c) => !c.templateName || isReportTemplateName(c.templateName), { path: ["templateName"], error: `The report uses the dedicated template "${REPORT_TEMPLATE_NAME}" (or its renamed copy) only` })
  .refine((c) => c.reportFor !== "DATE" || Boolean(c.dataDate), { path: ["dataDate"], error: "Select the date the report should cover" })
  .refine((c) => !c.enabled || c.sendText || c.sendExcel, { path: ["sendText"], error: "Turn on the text message, the Excel file, or both" });
const configSchema = z.preprocess(withLegacyRecipient, configObject);

export interface ConfigInput {
  enabled: boolean;
  recipients: { name?: string; phone: string }[];
  sendTime: string;
  timezone: string;
  reportFor: "TODAY" | "YESTERDAY" | "DATE" | "LAST7DAYS";
  dataDate?: string | null;
  templateName?: string;
  languageCode: string;
  options: { teamSummary: boolean; calls: boolean; leads: boolean; sales: boolean; followUps: boolean };
  includedUserIds: string[];
  sendText: boolean;
  sendExcel: boolean;
}

export const validateConfigInput = (body: unknown) => validateSchema<ConfigInput>(configSchema, body);

const previewSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "date must be YYYY-MM-DD" }).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), { error: "Invalid date" }).optional() });
export const validatePreviewQuery = (query: unknown) => validateSchema<{ date?: string }>(previewSchema, query);

const testSchema = z.object({ confirm: z.literal(true, { error: "Confirm the test send" }), recipientIds: z.array(z.uuid()).max(MAX_RECIPIENTS).optional() });
export const validateTestSendBody = (body: unknown) => validateSchema<{ confirm: true; recipientIds?: string[] }>(testSchema, body);

export const validateRetryBody = (body: unknown) => validateSchema<{ part: "TEXT" | "DETAIL" | "DOCUMENT" }>(z.object({ part: z.enum(["TEXT", "DETAIL", "DOCUMENT"]).default("TEXT") }), body ?? {});

export const validateIdParam = (params: unknown) => validateSchema<{ id: string }>(z.object({ id: z.uuid({ error: "Invalid id" }) }), params);

const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
export const validateHistoryQuery = (query: unknown) => validateSchema<{ page: number; pageSize: number }>(pageSchema, query);
