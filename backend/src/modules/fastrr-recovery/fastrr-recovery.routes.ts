import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { exportRecoveryExcel, getRecoveryRun, getRecoveryStatus, listRecoveryRuns, previewRecovery, retryRecoveryRun, startRecoveryImport } from "./fastrr-recovery.controller.js";

const router = Router();

// Mounted at /api/fastrr-recovery. Admin and Manager only (the same roles that may import abandoned leads from a CSV). Credentials never reach the browser: the server reads them from its own environment.
const roles = requireRole(Role.ADMIN, Role.MANAGER);

router.get("/status", requireAuth, roles, getRecoveryStatus);
router.post("/preview", requireAuth, roles, previewRecovery);
router.post("/import", requireAuth, roles, startRecoveryImport);
router.get("/export", requireAuth, roles, exportRecoveryExcel);
router.get("/runs", requireAuth, roles, listRecoveryRuns);
router.get("/runs/:id", requireAuth, roles, getRecoveryRun);
router.post("/runs/:id/retry", requireAuth, roles, retryRecoveryRun);

export default router;
