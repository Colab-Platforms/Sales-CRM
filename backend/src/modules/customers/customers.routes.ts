import { Router } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { getCustomerAudit } from "../audit/audit.controller.js";
import {
  deactivateCustomer,
  getCustomer360,
  getCustomerDeactivationImpact,
  getCustomerTimeline,
  getNextBestAction,
  listCustomers,
} from "./customers.controller.js";
import { listLiveCustomers } from "./customers.live.controller.js";

const router = Router();

// Registered before "/:leadId" so "/live" and "/" (the list) are never read as a customer id.
router.get("/live", requireAuth, listLiveCustomers);
router.get("/", requireAuth, listCustomers);
router.get("/:leadId", requireAuth, getCustomer360);
router.get("/:leadId/timeline", requireAuth, getCustomerTimeline);
router.get("/:leadId/audit", requireAuth, getCustomerAudit);
router.get("/:leadId/next-best-action", requireAuth, getNextBestAction);
// Part 8 (WhatsApp Inbox): the coarse "can this role ever deactivate a customer" gate - the real
// narrowing (which specific leads) happens inside the service via getLeadScope, same convention as
// every other destructive lead/order action (see orders.routes.ts's cancelOrder). Salespeople can send
// WhatsApp/create orders for their own leads but do not deactivate customer profiles.
router.get("/:leadId/deactivation-impact", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), getCustomerDeactivationImpact);
router.post("/:leadId/deactivate", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), deactivateCustomer);

export default router;
