import { Router } from "express";
import {
  listLeads,
  getLead,
  createLead,
  updateLead,
  getAssignmentHistory,
  bulkAssignManager,
  bulkAssignSalesperson,
  previewImport,
  confirmImport,
  getImportBatch,
} from "./lead.controller.js";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { csvUpload } from "@/middlewares/upload.js";
import { Role } from "../../../generated/prisma/enums.js";

const router = Router();

router.use(requireAuth);

router.get("/leads", requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), listLeads);
router.get("/leads/:id", requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), getLead);
router.get("/leads/:id/assignments", requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), getAssignmentHistory);
router.post("/leads", requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), createLead);
router.patch("/leads/:id", requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), updateLead);

router.post("/leads/bulk/assign-manager", requireRole(Role.ADMIN), bulkAssignManager);
router.post("/leads/bulk/assign-salesperson", requireRole(Role.MANAGER), bulkAssignSalesperson);

router.post("/leads/import/preview", requireRole(Role.ADMIN), csvUpload.single("file"), previewImport);
router.post("/leads/import/:batchId/confirm", requireRole(Role.ADMIN), confirmImport);
router.get("/leads/import/:batchId", requireRole(Role.ADMIN), getImportBatch);

export default router;
