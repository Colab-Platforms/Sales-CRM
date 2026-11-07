import type { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { REPORT_TZ_OFFSET_MINUTES } from "../attendance/attendance.constants.js";
import { todayString } from "../attendance/attendance.calc.js";
import { NOT_SET_UP, incentivesService, isMissingTable } from "./incentives.service.js";
import * as v from "./incentives.validators.js";

const thisMonth = () => todayString(new Date(), REPORT_TZ_OFFSET_MINUTES).slice(0, 7);

/** Runs a handler: validation errors are 400s, ApiErrors keep their status, anything else is logged as a 500. */
function handle(what: string, fn: (req: AuthRequest, res: Response) => Promise<unknown>) {
  return async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const data = await fn(req, res);
      if (data !== undefined) sendResponse(res, true, data, "OK", STATUS_CODES.OK);
    } catch (error: any) {
      // Saving before the incentives migration is applied: say what to do instead of a raw database error.
      if (isMissingTable(error)) return void sendResponse(res, false, null, NOT_SET_UP, STATUS_CODES.SERVICE_UNAVAILABLE);
      if (!error.statusCode) logger.error(`Incentives ${what} failed`, error);
      sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
    }
  };
}

function bad(res: Response, message: string) {
  sendResponse(res, false, null, message, STATUS_CODES.BAD_REQUEST);
  return undefined;
}

// Salesperson: their own month only - the user id always comes from the login, never from the request.
export const getMyMonth = handle("my month", async (req, res) => {
  const { error, value } = v.validateMonthQuery(req.query);
  if (error) return bad(res, error.message);
  return incentivesService.month(req.user!.id, value.month ?? thisMonth());
});

export const raiseQuery = handle("query", async (req, res) => {
  const { error, value } = v.validateQueryBody(req.body);
  if (error) return bad(res, error.message);
  return incentivesService.raiseQuery(req.user!, value.month, value.message);
});

// Admin.
export const getOverview = handle("overview", async (req, res) => {
  const { error, value } = v.validateOverviewQuery(req.query);
  if (error) return bad(res, error.message);
  return incentivesService.overview(req.user!, value.month ?? thisMonth(), value.from && value.to ? { from: value.from, to: value.to } : undefined);
});

export const rejectMonth = handle("reject", async (req, res) => {
  const p = v.validateMonthParams(req.params);
  if (p.error) return bad(res, p.error.message);
  const b = v.validateRejectBody(req.body);
  if (b.error) return bad(res, b.error.message);
  return incentivesService.reject(req.user!, p.value.userId, p.value.month, b.value.reason);
});

export const reopenMonth = handle("reopen", async (req, res) => {
  const p = v.validateMonthParams(req.params);
  if (p.error) return bad(res, p.error.message);
  return incentivesService.reopen(req.user!, p.value.userId, p.value.month);
});

export const getSalespersonMonth = handle("salesperson month", async (req, res) => {
  const { error, value } = v.validateMonthParams(req.params);
  if (error) return bad(res, error.message);
  return incentivesService.month(value.userId, value.month);
});

export const getPolicy = handle("policy", async () => incentivesService.policy());

export const setPolicy = handle("policy update", async (req, res) => {
  const { error, value } = v.validatePolicyBody(req.body);
  if (error) return bad(res, error.message);
  return incentivesService.setPolicy(req.user!, value);
});

export const approveMonth = handle("approve", async (req, res) => {
  const p = v.validateMonthParams(req.params);
  if (p.error) return bad(res, p.error.message);
  const b = v.validateApproveBody(req.body);
  if (b.error) return bad(res, b.error.message);
  return incentivesService.approve(req.user!, p.value.userId, p.value.month, b.value.note);
});

export const recordPayment = handle("payment", async (req, res) => {
  const p = v.validateMonthParams(req.params);
  if (p.error) return bad(res, p.error.message);
  const b = v.validatePaymentBody(req.body);
  if (b.error) return bad(res, b.error.message);
  return incentivesService.recordPayment(req.user!, p.value.userId, p.value.month, b.value);
});

export const listQueries = handle("queries", async (req, res) => {
  const { error, value } = v.validateQueryList(req.query);
  if (error) return bad(res, error.message);
  return incentivesService.listQueries(value.status);
});

export const resolveQuery = handle("query answer", async (req, res) => {
  const { error, value } = v.validateResolveBody(req.body);
  if (error) return bad(res, error.message);
  return incentivesService.resolveQuery(req.user!, String(req.params.id), value.response);
});

export const getAudit = handle("audit", async (req, res) => {
  const { error, value } = v.validateAuditQuery(req.query);
  if (error) return bad(res, error.message);
  return incentivesService.auditLog(value);
});
