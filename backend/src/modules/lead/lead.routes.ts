import { Router } from "express";
import {
  listLeads,
  getLead,
  createLead,
  updateLead,
  deleteLead,
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
// Deletion is destructive and irreversible, so - unlike edit - it is restricted to ADMIN only,
// on top of the same RBAC/lead-scope check every other single-lead route already applies.
router.delete("/leads/:id", requireRole(Role.ADMIN), deleteLead);

router.post("/leads/bulk/assign-manager", requireRole(Role.ADMIN), bulkAssignManager);
router.post("/leads/bulk/assign-salesperson", requireRole(Role.MANAGER), bulkAssignSalesperson);

router.post(
  "/leads/import/preview",
  requireRole(Role.ADMIN, Role.MANAGER),
  csvUpload.single("file"),
  previewImport,
);
router.post("/leads/import/:batchId/confirm", requireRole(Role.ADMIN, Role.MANAGER), confirmImport);
router.get("/leads/import/:batchId", requireRole(Role.ADMIN, Role.MANAGER), getImportBatch);

export default router;
