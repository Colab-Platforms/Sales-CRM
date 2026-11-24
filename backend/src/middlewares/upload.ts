import os from "node:os";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";

const storage = multer.memoryStorage();

export const csvUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isCsv = file.mimetype === "text/csv" || file.originalname.toLowerCase().endsWith(".csv");
    if (!isCsv) {
      cb(new ApiError("Only CSV files are supported", STATUS_CODES.BAD_REQUEST));
      return;
    }
    cb(null, true);
  },
});

// Catalog imports can run to thousands of SKUs: the file is spooled to disk (never held in memory) and streamed by the importer, which deletes
// it when the job ends. The ceiling is a sanity bound on the upload, not on the number of SKUs (100 MB is hundreds of thousands of rows).
export const CATALOG_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const catalogUpload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir(), filename: (_req, _file, cb) => cb(null, `catalog-${randomUUID()}.csv`) }),
  limits: { fileSize: CATALOG_UPLOAD_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const isCsv = file.mimetype === "text/csv" || file.mimetype === "application/vnd.ms-excel" || file.originalname.toLowerCase().endsWith(".csv");
    if (!isCsv) {
      cb(new ApiError("Only CSV files are supported", STATUS_CODES.BAD_REQUEST));
      return;
    }
    cb(null, true);
  },
});

// Customer files (Excel / CSV) for the lead import: spooled to disk and streamed by the importer (which deletes the file when it is done), so a large workbook is never held in memory.
export const LEAD_IMPORT_MAX_BYTES = 60 * 1024 * 1024;
export const leadImportUpload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir(), filename: (_req, file, cb) => cb(null, `lead-import-${randomUUID()}${file.originalname.toLowerCase().endsWith(".csv") ? ".csv" : ".xlsx"}`) }),
  limits: { fileSize: LEAD_IMPORT_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    if (name.endsWith(".xls")) {
      cb(new ApiError("Old Excel files (.xls) are not supported. Save the file as .xlsx or .csv and upload it again.", STATUS_CODES.BAD_REQUEST));
      return;
    }
    if (!name.endsWith(".csv") && !name.endsWith(".xlsx")) {
      cb(new ApiError("Upload an Excel (.xlsx) or CSV (.csv) file.", STATUS_CODES.BAD_REQUEST));
      return;
    }
    cb(null, true);
  },
});
