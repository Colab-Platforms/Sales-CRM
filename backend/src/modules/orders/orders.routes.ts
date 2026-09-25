import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { getOrderAudit } from "../audit/audit.controller.js";
import { getReconciliation } from "../reconciliation/reconciliation.controller.js";
import { cancelOrder, createOrder, getLastShippingAddress, getOrder, getOrderFilterOptions, getOrderStatusHistory, listOrders, pushOrderToShopify } from "./orders.controller.js";
import { createPaymentLink } from "../cashfree/cashfree.controller.js";
import { createShipment } from "../shiprocket/shiprocket.controller.js";

const router = Router();

// Registered before "/:id" so "filter-options"/"reconciliation" are not read as an order id.
router.get("/filter-options", requireAuth, getOrderFilterOptions);
// Prefill for the Create Order form (a customer's most recent shipping address); before "/:id" like the others.
router.get("/last-address", requireAuth, getLastShippingAddress);
// Revenue & payment reconciliation is an org/team-level financial view, not a single order - only
// management roles get it, same as the rest of the manager/admin-only reporting endpoints.
router.get("/reconciliation", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), getReconciliation);
router.get("/", requireAuth, listOrders);
router.get("/:id", requireAuth, getOrder);
router.get("/:id/status-history", requireAuth, getOrderStatusHistory);
router.get("/:id/audit", requireAuth, getOrderAudit);

// E7.8 (WhatsApp -> CRM Order): manual order entry. Same role set as lead creation (ADMIN/MANAGER/
// SALESPERSON) - the real restriction is server-side lead scope (createManualOrder/pushOrderToShopify
// both use getLeadScope), never just which roles can reach the route.
router.post("/", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), createOrder);
router.post("/:id/shopify-order", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), pushOrderToShopify);
// Cancel/Revert - same role set as creating an order (order-management permission); real scoping is
// server-side (see cancelOrder). Never physically deletes anything.
router.post("/:id/cancel", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), cancelOrder);

// Cashfree payment link for the order's exact pending amount. Every role may collect on orders inside their own lead scope.
router.post("/:orderId/payment-links", requireAuth, createPaymentLink);
// Shiprocket shipment for the order. Shipping is an operational step: ADMIN/MANAGER, within their lead scope.
router.post("/:orderId/shipments", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), createShipment);

export default router;
