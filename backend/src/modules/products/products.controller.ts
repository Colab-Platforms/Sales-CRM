import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import ProductsService from "./products.service.js";
import { unlink } from "node:fs/promises";
import { failedRowsCsv, getCatalogImportJob, hasRunningCatalogImport, NotACatalogError, startCatalogImport } from "./products.catalog-import.js";
import { validateIdParam, validateListProductsQuery, validateWeightBody } from "./products.validators.js";

const productsService = new ProductsService();

export const setProductWeight = (kind: "product" | "variant") => async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateIdParam(req.params);
    if (params.error) return void sendResponse(res, false, null, params.error.message, STATUS_CODES.BAD_REQUEST);
    const body = validateWeightBody(req.body ?? {});
    if (body.error) return void sendResponse(res, false, null, body.error.message, STATUS_CODES.BAD_REQUEST);
    const target = kind === "product" ? { productId: params.value.id } : { variantId: params.value.id };
    sendResponse(res, true, await productsService.setWeight(target, body.value.weightKg), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const listProducts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListProductsQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await productsService.listProducts(value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// Shiprocket catalog import (ADMIN / MANAGER): the upload returns at once with a job id; the client polls for progress and the summary.
export const startCatalogImportRequest = async (req: AuthRequest, res: Response): Promise<void> => {
  const file = (req as AuthRequest & { file?: { path: string; originalname: string } }).file;
  if (!file) return void sendResponse(res, false, null, "Choose a CSV file to import", STATUS_CODES.BAD_REQUEST);
  const cleanup = () => unlink(file.path).catch(() => undefined);
  try {
    if (hasRunningCatalogImport()) {
      await cleanup();
      return void sendResponse(res, false, null, "A catalog import is already running. Wait for it to finish.", STATUS_CODES.CONFLICT);
    }
    const job = await startCatalogImport({ path: file.path, fileName: file.originalname, cleanup });
    sendResponse(res, true, { jobId: job.id }, "Import started", 202);
  } catch (error: any) {
    await cleanup();
    sendResponse(res, false, null, error.message, error instanceof NotACatalogError ? STATUS_CODES.BAD_REQUEST : error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

const jobView = (job: NonNullable<ReturnType<typeof getCatalogImportJob>>) => ({ ...job, failedRows: undefined, failedRowCount: job.failedRows.length, failedRowsTruncated: job.summary.skipped + job.summary.unmatched + job.summary.errors > job.failedRows.length, failedRowsPreview: job.failedRows.slice(0, 50) });

export const getCatalogImportStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const job = getCatalogImportJob(String(req.params.jobId));
  if (!job) return void sendResponse(res, false, null, "Import not found (it may have expired). Upload the file again - importing is safe to repeat.", STATUS_CODES.NOT_FOUND);
  sendResponse(res, true, jobView(job), "OK", STATUS_CODES.OK);
};

export const downloadCatalogImportFailures = async (req: AuthRequest, res: Response): Promise<void> => {
  const job = getCatalogImportJob(String(req.params.jobId));
  if (!job) return void sendResponse(res, false, null, "Import not found", STATUS_CODES.NOT_FOUND);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="catalog-import-failed-rows.csv"');
  res.send(failedRowsCsv(job.failedRows));
};
