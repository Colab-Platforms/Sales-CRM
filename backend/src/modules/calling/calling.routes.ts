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
  streamCallTranscript,
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
// Manager/admin-only, same gate as the recording/transcript fields on the call itself - the service
// method enforces it too, this is just the fast path (SALESPERSON never opens the connection).
router.get("/calls/:id/transcript-stream", requireRole(Role.ADMIN, Role.MANAGER), streamCallTranscript);

router.use("/virtual-numbers", requireRole(Role.ADMIN, Role.MANAGER));

router.get("/virtual-numbers/all", listAllVirtualNumbers);
router.post("/virtual-numbers", createVirtualNumber);
router.patch("/virtual-numbers/:id", updateVirtualNumber);
router.delete("/virtual-numbers/:id", deleteVirtualNumber);

export default router;
