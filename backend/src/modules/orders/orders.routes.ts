import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { getOrderAudit } from "../audit/audit.controller.js";
import { getReconciliation } from "../reconciliation/reconciliation.controller.js";
import { getOrder, getOrderFilterOptions, getOrderStatusHistory, listOrders } from "./orders.controller.js";
import { createPaymentLink } from "../cashfree/cashfree.controller.js";
import { createShipment } from "../shiprocket/shiprocket.controller.js";
import {
  checkBookingServiceability,
  getBookingCatalog,
  lookupBookingLeads,
  quoteBooking,
} from "./orders.booking.controller.js";

const router = Router();

// Registered before "/:id" so "filter-options"/"reconciliation" are not read as an order id.
router.get("/filter-options", requireAuth, getOrderFilterOptions);
// Revenue & payment reconciliation is an org/team-level financial view, not a single order - only
// management roles get it, same as the rest of the manager/admin-only reporting endpoints.
router.get("/reconciliation", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), getReconciliation);
// --- E5: on-call order booking ---
const BOOKING_ROLES = [Role.ADMIN, Role.MANAGER, Role.SALESPERSON] as const;
router.get("/booking/leads", requireAuth, requireRole(...BOOKING_ROLES), lookupBookingLeads);
router.get("/booking/catalog", requireAuth, requireRole(...BOOKING_ROLES), getBookingCatalog);
router.get("/booking/serviceability", requireAuth, requireRole(...BOOKING_ROLES), checkBookingServiceability);
router.post("/booking/quote", requireAuth, requireRole(...BOOKING_ROLES), quoteBooking);
router.get("/", requireAuth, listOrders);
router.get("/:id", requireAuth, getOrder);
router.get("/:id/status-history", requireAuth, getOrderStatusHistory);
router.get("/:id/audit", requireAuth, getOrderAudit);

// Cashfree payment link for the order's exact pending amount. Every role may collect on orders inside their own lead scope.
router.post("/:orderId/payment-links", requireAuth, createPaymentLink);
// Shiprocket shipment for the order. Shipping is an operational step: ADMIN/MANAGER, within their lead scope.
router.post("/:orderId/shipments", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), createShipment);

export default router;
