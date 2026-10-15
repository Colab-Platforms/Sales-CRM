import type { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import RecruitmentService from "./recruitment.service.js";
import {
  validateAssign,
  validateCreateApplication,
  validateCreateJob,
  validateIdParam,
  validateImportPreview,
  validateListQuery,
  validateUpdateApplication,
  validateUpdateJob,
} from "./recruitment.validators.js";

const service = new RecruitmentService();

type Handler = (req: AuthRequest, res: Response) => Promise<void>;

// Every handler shares the same envelope and error mapping.
const handle =
  (fn: (req: AuthRequest, res: Response) => Promise<void>): Handler =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (error: any) {
      sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
    }
  };

const badRequest = (res: Response, message: string) => sendResponse(res, false, null, message, STATUS_CODES.BAD_REQUEST);

export const listJobs = handle(async (_req, res) => {
  sendResponse(res, true, await service.listJobs(), "OK", STATUS_CODES.OK);
});

export const getJob = handle(async (req, res) => {
  const { error, value } = validateIdParam(req.params);
  if (error) return badRequest(res, error.message);
  sendResponse(res, true, await service.getJob(value.id), "OK", STATUS_CODES.OK);
});

export const createJob = handle(async (req, res) => {
  const { error, value } = validateCreateJob(req.body);
  if (error) return badRequest(res, error.message);
  sendResponse(res, true, await service.createJob(req.user!, value), "Job created successfully.", STATUS_CODES.CREATED);
});

export const updateJob = handle(async (req, res) => {
  const { error: paramError, value: params } = validateIdParam(req.params);
  if (paramError) return badRequest(res, paramError.message);
  const { error, value } = validateUpdateJob(req.body);
  if (error) return badRequest(res, error.message);
  sendResponse(res, true, await service.updateJob(params.id, value), "Job updated successfully.", STATUS_CODES.OK);
});

export const previewImport = handle(async (req, res) => {
  const { error: paramError, value: params } = validateIdParam(req.params);
  if (paramError) return badRequest(res, paramError.message);
  if (!req.file) return badRequest(res, "CSV file is required");

  let columnMapping: unknown;
  try {
    columnMapping = JSON.parse(req.body.columnMapping ?? "{}");
  } catch {
    return badRequest(res, "columnMapping must be valid JSON");
  }
  const { error, value } = validateImportPreview({ columnMapping });
  if (error) return badRequest(res, error.message);

  const result = await service.previewImport(req.user!, params.id, req.file, value.columnMapping);
  sendResponse(res, true, result, "Import previewed successfully.", STATUS_CODES.OK);
});

export const confirmImport = handle(async (req, res) => {
  const { error, value } = validateIdParam({ id: req.params.batchId });
  if (error) return badRequest(res, error.message);
  sendResponse(res, true, await service.confirmImport(value.id), "Applications imported successfully.", STATUS_CODES.CREATED);
});

export const listJobApplications = handle(async (req, res) => {
  const { error: paramError, value: params } = validateIdParam(req.params);
  if (paramError) return badRequest(res, paramError.message);
  const { error, value } = validateListQuery(req.query);
  if (error) return badRequest(res, error.message);
  sendResponse(res, true, await service.listApplications(req.user!, value, params.id), "OK", STATUS_CODES.OK);
});

// Recruiter's own queue (and HR/admin's org-wide list): the service scopes a recruiter to what is assigned to them.
export const listApplications = handle(async (req, res) => {
  const { error, value } = validateListQuery(req.query);
  if (error) return badRequest(res, error.message);
  sendResponse(res, true, await service.listApplications(req.user!, value), "OK", STATUS_CODES.OK);
});

export const createApplication = handle(async (req, res) => {
  const { error, value } = validateCreateApplication(req.body);
  if (error) return badRequest(res, error.message);
  sendResponse(res, true, await service.createApplication(req.user!, value), "Application added.", STATUS_CODES.CREATED);
});

export const getApplication = handle(async (req, res) => {
  const { error, value } = validateIdParam(req.params);
  if (error) return badRequest(res, error.message);
  sendResponse(res, true, await service.getApplication(req.user!, value.id), "OK", STATUS_CODES.OK);
});

export const updateApplication = handle(async (req, res) => {
  const { error: paramError, value: params } = validateIdParam(req.params);
  if (paramError) return badRequest(res, paramError.message);
  const { error, value } = validateUpdateApplication(req.body);
  if (error) return badRequest(res, error.message);
  sendResponse(res, true, await service.updateApplication(req.user!, params.id, value), "Application updated.", STATUS_CODES.OK);
});

export const assignApplications = handle(async (req, res) => {
  const { error, value } = validateAssign(req.body);
  if (error) return badRequest(res, error.message);
  sendResponse(res, true, await service.assign(req.user!, value), "Applications assigned.", STATUS_CODES.OK);
});

export const getDistribution = handle(async (req, res) => {
  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : undefined;
  sendResponse(res, true, await service.distribution(jobId), "OK", STATUS_CODES.OK);
});

export const exportJobApplications = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateIdParam(req.params);
    if (error) return badRequest(res, error.message);
    const { filename, csv } = await service.exportCsv(value.id);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
