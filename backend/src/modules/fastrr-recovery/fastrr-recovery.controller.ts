import type { Response } from "express";
import { z } from "zod";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { validateSchema } from "@/utils/validate.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { FastrrRecoveryService } from "./fastrr-recovery.service.js";

const service = new FastrrRecoveryService();

const day = z.string({ error: "Date is required" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be in YYYY-MM-DD format");
const flag = z.preprocess((v) => (v === "true" || v === true ? true : v === "false" || v === false || v === undefined || v === "" ? false : v), z.boolean({ error: "includeConverted must be true or false" }));

const previewSchema = z.object({ from: day, to: day, includeConverted: flag });
// An import is only accepted with an explicit confirmation, and carries the missing count the user saw so a changed picture is refused instead of imported blindly.
const importSchema = z.object({
  from: day,
  to: day,
  includeConverted: flag,
  confirm: z.literal(true, { error: "The import must be explicitly confirmed" }),
  expectedMissing: z.coerce.number({ error: "expectedMissing must be a number" }).int().min(0).optional(),
});
const idSchema = z.object({ id: z.uuid({ error: "Invalid run id" }) });

const fail = (res: Response, error: any) => sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
const bad = (res: Response, message: string) => sendResponse(res, false, null, message, STATUS_CODES.BAD_REQUEST);

export const getRecoveryStatus = async (_req: AuthRequest, res: Response): Promise<void> => {
  sendResponse(res, true, { configured: service.isConfigured() }, "OK", STATUS_CODES.OK);
};

export const previewRecovery = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSchema<{ from: string; to: string; includeConverted: boolean }>(previewSchema, req.body ?? {});
    if (error) return void bad(res, error.message);
    sendResponse(res, true, await service.preview(value!.from, value!.to, { includeConverted: value!.includeConverted }), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const startRecoveryImport = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSchema<{ from: string; to: string; includeConverted: boolean; expectedMissing?: number }>(importSchema, req.body ?? {});
    if (error) return void bad(res, error.message);
    // The import runs on after this response; the page polls the run row for progress.
    const { run } = await service.startImport(req.user!, { from: value!.from, to: value!.to, includeConverted: value!.includeConverted, expectedMissing: value!.expectedMissing });
    sendResponse(res, true, run, "Import started", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const retryRecoveryRun = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSchema<{ id: string }>(idSchema, req.params);
    if (error) return void bad(res, error.message);
    const { run } = await service.retryRun(req.user!, value!.id);
    sendResponse(res, true, run, "Import started", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const listRecoveryRuns = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, { runs: await service.listRuns(20) }, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getRecoveryRun = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSchema<{ id: string }>(idSchema, req.params);
    if (error) return void bad(res, error.message);
    sendResponse(res, true, await service.getRun(value!.id), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const exportRecoveryExcel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateSchema<{ from: string; to: string; includeConverted: boolean }>(previewSchema, req.query ?? {});
    if (error) return void bad(res, error.message);
    const file = await service.exportWorkbook(value!.from, value!.to, { includeConverted: value!.includeConverted });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
    res.setHeader("Cache-Control", "no-store");
    res.status(STATUS_CODES.OK).send(file.buffer);
  } catch (error: any) {
    fail(res, error);
  }
};
