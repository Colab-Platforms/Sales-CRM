import type { Response } from "express";
import type { AuthRequest } from "@/middlewares/auth.js";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import OrdersDashboardService from "./orders.dashboard.service.js";
import LiveWebsiteDashboardService from "./orders.dashboard.live.service.js";
import AbandonedDashboardService from "./abandoned.dashboard.service.js";
import { validateAbandonedFilters, validateAbandonedList, validateChart, validateFilters, validateList } from "./orders.dashboard.validators.js";

// Website Orders: read live from Shopify (nothing imported or stored). The database-backed service remains for the other sections.
const service = new OrdersDashboardService();
/** The live Shopify-backed service (replaceable so tests never reach Shopify). */
export const dependencies = { live: new LiveWebsiteDashboardService() };
const abandoned = new AbandonedDashboardService();
const fail = (res: Response, error: { message: string; statusCode?: number }) => sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);

export const getDashboard = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateList(req.query);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    const { page, pageSize, ...filters } = value;
    sendResponse(res, true, await (filters.scope === "WEBSITE" ? dependencies.live : service).overview(req.user!, filters, page, pageSize), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const exportDashboard = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateFilters(req.query);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    const file = await (value.scope === "WEBSITE" ? dependencies.live : service).exportXlsx(req.user!, value);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.setHeader("X-Export-Rows", String(file.rows));
    res.setHeader("X-Export-Truncated", String(file.truncated));
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Export-Rows, X-Export-Truncated");
    res.status(STATUS_CODES.OK).send(file.buffer);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getAbandoned = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateAbandonedList(req.query);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    const { page, pageSize, ...filters } = value;
    sendResponse(res, true, await abandoned.overview(req.user!, filters, page, pageSize), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const exportAbandoned = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateAbandonedFilters(req.query);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    const file = await abandoned.exportXlsx(req.user!, value);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.setHeader("X-Export-Rows", String(file.rows));
    res.setHeader("X-Export-Truncated", String(file.truncated));
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Export-Rows, X-Export-Truncated");
    res.status(STATUS_CODES.OK).send(file.buffer);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getChart = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateChart(req.query);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    const { interval, ...range } = value;
    sendResponse(res, true, await dependencies.live.chart(req.user!, range, interval), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getAbandonedChart = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateChart(req.query);
    if (error) return void sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
    const { interval, ...range } = value;
    sendResponse(res, true, await abandoned.chart(req.user!, range, interval), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};
