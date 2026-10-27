import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { cronTick, getConfig, getStatus, listDeliveries, previewReport, addApprovedTemplate, listApprovedTemplates, retryDelivery, sendTestReport, updateConfig } from "./report-automation.controller.js";

// WhatsApp Report Automation: Admin and Manager only, on every route (the UI hides the page for other roles, but this is the enforcement). Nothing here is public.
// The secret-protected external trigger is mounted BEFORE the user routes (it has no user): see cronTick.
export const cronRouter = Router();
cronRouter.post("/tick", cronTick);

const router = Router();
router.use(requireAuth, requireRole(Role.ADMIN, Role.MANAGER));

router.get("/config", getConfig);
router.put("/config", updateConfig);
router.get("/preview", previewReport);
router.post("/test-send", sendTestReport);
router.get("/deliveries", listDeliveries);
router.get("/status", getStatus);
router.post("/deliveries/:id/retry", retryDelivery);
router.get("/templates/approved", requireRole(Role.ADMIN), listApprovedTemplates); // Admin only: Meta's live APPROVED list (read-only)
router.post("/templates/add", requireRole(Role.ADMIN), addApprovedTemplate);

export default router;
