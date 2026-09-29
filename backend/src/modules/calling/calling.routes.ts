import { Router } from "express";
import {
  initiateCall,
  listLeadCalls,
  listVirtualNumbers,
  listAllVirtualNumbers,
  createVirtualNumber,
  updateVirtualNumber,
  deleteVirtualNumber,
  receiveCallWebhook,
  listCallOutcomes,
  submitCallOutcome,
} from "./calling.controller.js";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";

const router = Router();

// Public: CallerDesk can't send a JWT, secured by verifyWebhookSecret instead.
router.post("/webhooks/callerdesk", receiveCallWebhook);

router.use(requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON));

router.get("/virtual-numbers", listVirtualNumbers);
router.post("/leads/:leadId/click-to-call", initiateCall);
router.get("/leads/:leadId/calls", listLeadCalls);
router.get("/call-outcomes", listCallOutcomes);
router.patch("/calls/:id/outcome", submitCallOutcome);

router.use("/virtual-numbers", requireRole(Role.ADMIN, Role.MANAGER));

router.get("/virtual-numbers/all", listAllVirtualNumbers);
router.post("/virtual-numbers", createVirtualNumber);
router.patch("/virtual-numbers/:id", updateVirtualNumber);
router.delete("/virtual-numbers/:id", deleteVirtualNumber);

export default router;
