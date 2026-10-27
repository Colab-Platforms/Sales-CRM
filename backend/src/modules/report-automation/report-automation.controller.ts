import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import type { AuthRequest } from "@/middlewares/auth.js";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import ReportAutomationService from "./report-automation.service.js";
import { validateCancelBody, validateConfigInput, validateEnabledBody, validateHistoryQuery, validateIdParam, validatePreviewQuery, validateRetryBody, validateTestSendBody } from "./report-automation.validators.js";

import WhatsAppTemplateService from "../whatsapp/whatsapp.template.service.js";
import { addPickerTemplate, listPickerTemplates } from "./report-automation.template-picker.js";

const templates = new WhatsAppTemplateService();
const service = new ReportAutomationService();

const fail = (res: Response, error: { message: string; statusCode?: number }) => sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);

export const getConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await service.getConfig(req.user!), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const updateConfig = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateConfigInput(req.body);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await service.saveConfig(req.user!, value), "Saved", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const previewReport = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validatePreviewQuery(req.query);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await service.preview(req.user!, value.date), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const sendTestReport = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateTestSendBody(req.body);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    const run = await service.sendTest(req.user!, value.recipientIds);
    const accepted = run.recipients.filter((r) => r.status === "SENT").length;
    sendResponse(res, true, run, `${accepted} of ${run.recipients.length} test messages accepted by WhatsApp`, STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const listDeliveries = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateHistoryQuery(req.query);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await service.history(req.user!, value.page, value.pageSize), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await service.status(req.user!), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getScheduled = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await service.scheduled(req.user!), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const listApprovedTemplates = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await listPickerTemplates(req.user!, templates), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const addApprovedTemplate = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    sendResponse(res, true, await addPickerTemplate(req.user!, templates, String(b.name ?? ""), String(b.language ?? "")), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const cancelScheduled = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCancelBody(req.body);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await service.cancelOccurrence(req.user!, value.occurrenceDate), "Cancelled", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const deleteDelivery = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateIdParam(req.params);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await service.deleteRun(req.user!, value.id), "Removed from history", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const setAutomationEnabled = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateEnabledBody(req.body);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await service.setEnabled(req.user!, value.enabled), value.enabled ? "Automation turned on" : "Automation turned off", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const retryDelivery = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateIdParam(req.params);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    const body = validateRetryBody(req.body);
    if (body.error) return void sendResponse(res, false, null, body.error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await service.retryRecipient(req.user!, value.id, body.value!.part), "Retry attempted", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

/**
 * POST /api/report-automation/cron/tick - for an EXTERNAL scheduler (cron job, uptime pinger, GitHub Actions ...) that also wakes a sleeping host. NOT a user endpoint: it needs the secret
 * REPORT_CRON_SECRET in the x-cron-secret header (compared in constant time) and is a 404 while that variable is unset. It can only run the report schedule that users already configured - due reports
 * only, each at most once per day and recipient - and it can neither read nor change any setting, nor send an ad-hoc message. The answer is counts only.
 */
export const cronTick = async (req: Request, res: Response): Promise<void> => {
  const secret = process.env.REPORT_CRON_SECRET?.trim();
  if (!secret) return void sendResponse(res, false, null, "Not found", STATUS_CODES.NOT_FOUND);
  const given = Buffer.from(String(req.headers["x-cron-secret"] ?? ""));
  const wanted = Buffer.from(secret);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return void sendResponse(res, false, null, "Unauthorized", STATUS_CODES.UNAUTHORIZED);
  try {
    sendResponse(res, true, await service.runDue("cron"), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};
