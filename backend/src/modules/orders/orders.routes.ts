import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { getOrderAudit } from "../audit/audit.controller.js";
import { getReconciliation } from "../reconciliation/reconciliation.controller.js";
import { previewOrderAmount, correctOrderAmount, applyOrderSync, getOrderSyncReport, previewOrderSync, changeOrderFlavour, getOrderFlavours, updateOrderShippingAddress, cancelOrder, revertCancellation, createOrder, listMyOrders, resyncShopifyOrder, getLastShippingAddress, getWhatsAppPaymentOptions, getOrder, getOrderFilterOptions, getOrderStatusHistory, listOrders, pushOrderToShopify, retryConfirmationTagSync, retryShopifyPaymentSync } from "./orders.controller.js";
import { LIVE_ORDER_SYNC_ROLES } from "./orders.filters.js";
import { cancelLiveOrder, syncLiveOrder, getLiveOrderDetail, getLiveOrderHistory, getLiveTagOptions, listLiveOrders } from "./orders.live.controller.js";
import { createLivePrepaidUpgrade, getLivePrepaidUpgrade, createPrepaidUpgrade, declinePrepaidUpgrade, generatePrepaidUpgradeLink, getPrepaidUpgrade } from "./orders.prepaid-upgrade.controller.js";
import { createPaymentLink } from "../cashfree/cashfree.controller.js";
import { sendPaymentLinkQr, viewPaymentLinkQr } from "../whatsapp/whatsapp.payment-qr.routes.js";
import { markOrderPaid, MANUAL_PAYMENT_ROLES } from "./orders.manual-payment.js";
import { createShipment } from "../shiprocket/shiprocket.controller.js";
import { createRefundRequest, resolveCashfreeReferences } from "../refunds/refunds.controller.js";

/** "My Orders" is for Salespersons only. The general Orders list below stays open to every role that could already read orders. */
export const MY_ORDERS_ROLES: Role[] = [Role.SALESPERSON];

const router = Router();

// Registered before "/:id" so "filter-options"/"reconciliation" are not read as an order id.
router.get("/filter-options", requireAuth, getOrderFilterOptions);
// Read-only out-of-sync report (Admin / Manager). Registered before "/:id" so it is not read as an order id.
router.get("/sync-report", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), getOrderSyncReport);
// Prefill for the Create Order form (a customer's most recent shipping address); before "/:id" like the others.
router.get("/last-address", requireAuth, getLastShippingAddress);
// Templates / consent for "Send payment link via WhatsApp" on Create Order (literal path, ahead of "/:id").
router.get("/whatsapp-payment-options", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), getWhatsAppPaymentOptions);
// Revenue & payment reconciliation is an org/team-level financial view, not a single order - only
// management roles get it, same as the rest of the manager/admin-only reporting endpoints.
router.get("/reconciliation", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), getReconciliation);
// Live from Shopify (cursor-paginated, date/search filtered) - the Orders list page's data source.
// Separate from GET "/" (the original CRM-DB-backed list, kept unchanged and still used by anything
// else that needs offset pagination/exports/etc.) - see orders.live.service.ts's own header comment.
router.get("/live", requireAuth, listLiveOrders);
// Tag options for the Orders Tags filter - a literal path, registered before "/live/:externalId" so it is never read as an order id.
router.get("/live/tag-options", requireAuth, getLiveTagOptions);
// Order Detail for a Shopify order not yet synced into the CRM (see orders.live.controller.ts) -
// registered before "/:id" for the same reason as the routes above.
router.get("/live/:externalId", requireAuth, getLiveOrderDetail);
// Prepaid Upgrade for a Shopify order addressed by its Shopify id (works whether or not the CRM has synced it; see the service).
router.get("/live/:externalId/prepaid-upgrade", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), getLivePrepaidUpgrade);
router.post("/live/:externalId/prepaid-upgrade", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), createLivePrepaidUpgrade);
// "Previous Orders" on that same live detail page - registered as its own literal "customer" segment
// so it never collides with "/live/:externalId" above (different, unrelated path shape).
router.get("/live/customer/:customerId/history", requireAuth, getLiveOrderHistory);
// Cancel a Shopify order the CRM has not synced yet - ADMIN-only, same gate as the detail page (see
// orders.live.controller.ts). Shopify has no "delete order" operation, only cancellation.
router.post("/live/:externalId/cancel", requireAuth, requireRole(Role.ADMIN), cancelLiveOrder);
// Brings a live-only Shopify order into the CRM through the normal Shopify sync (idempotent). Admin, Manager, Telecaller (SALESPERSON) and HR - see LIVE_ORDER_SYNC_ROLES.
router.post("/live/:externalId/sync", requireAuth, requireRole(...LIVE_ORDER_SYNC_ROLES), syncLiveOrder);
// Orders created by the signed-in SALESPERSON only. Registered before "/:id" so "mine" is never read as an order id.
router.get("/mine", requireAuth, requireRole(...MY_ORDERS_ROLES), listMyOrders);
router.get("/", requireAuth, listOrders);
router.get("/:id", requireAuth, getOrder);
router.get("/:id/status-history", requireAuth, getOrderStatusHistory);
router.get("/:id/audit", requireAuth, getOrderAudit);

// E7.8 (WhatsApp -> CRM Order): manual order entry. Same role set as lead creation (ADMIN/MANAGER/
// SALESPERSON) - the real restriction is server-side lead scope (createManualOrder/pushOrderToShopify
// both use getLeadScope), never just which roles can reach the route.
router.post("/", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), createOrder);
router.post("/:id/shopify-order", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), pushOrderToShopify);
// Verify and repair a partial Shopify sync (shipping address, crm metafields, missing tags). Admin / manager only.
router.post("/:id/shopify-sync/retry", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), resyncShopifyOrder);
router.post("/:id/shopify-confirmation-tag/retry", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), retryConfirmationTagSync);
router.post("/:id/shopify-payment-sync/retry", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), retryShopifyPaymentSync);
// Cancel/Revert - same role set as creating an order (order-management permission); real scoping is
// server-side (see cancelOrder). Never physically deletes anything.
// Prepaid Upgrade (COD -> prepaid at a telecaller-offered discount). Same role set and server-side lead scoping as the
// other single-order actions; the conversion itself only ever happens on a verified payment (see the hooks file).
router.get("/:id/prepaid-upgrade", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), getPrepaidUpgrade);
router.post("/:id/prepaid-upgrade", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), createPrepaidUpgrade);
router.post("/:id/prepaid-upgrade/:upgradeId/payment-link", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), generatePrepaidUpgradeLink);
router.post("/:id/prepaid-upgrade/:upgradeId/decline", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), declinePrepaidUpgrade);
// Edit an existing order: switch a line's flavour (same price only) / change the delivery address. Admin, Manager and Telecaller; the service checks scope, order state and Shopify's own restrictions.
// Sync / Update from CRM: compare (read-only) and apply the chosen, allowed differences (explicit confirmation + a fresh comparison token). Admin, Manager and Telecaller; the service checks scope.
// Review & Correct Amount: any of the three roles may REVIEW; only Admin / Manager may apply (the financial edit), after explicit confirmation of the new total.
router.get("/:id/amount-preview", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), previewOrderAmount);
router.post("/:id/amount-correction", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), correctOrderAmount);
router.get("/:id/sync-preview", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), previewOrderSync);
router.post("/:id/sync", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), applyOrderSync);
router.get("/:id/flavours", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), getOrderFlavours);
router.post("/:id/items/:itemId/flavour", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), changeOrderFlavour);
router.patch("/:id/shipping-address", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), updateOrderShippingAddress);
router.post("/:id/cancel", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), cancelOrder);
// Revert a cancellation - identical role gate and server-side scoping as cancel itself.
router.post("/:id/revert-cancel", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), revertCancellation);

// Cashfree payment link for the order's exact pending amount. Every role may collect on orders inside their own lead scope.
router.post("/:orderId/payment-links", requireAuth, createPaymentLink);
// A person verified an EXTERNAL payment (e.g. the telecaller's own QR) for an unpaid prepaid order: recorded as a separate, audited, non-Cashfree payment. See orders.manual-payment.ts.
router.post("/:id/mark-paid", requireAuth, requireRole(...MANUAL_PAYMENT_ROLES), markOrderPaid);
// Re-send ONLY the QR image of an existing payment link (same order, same link) after a failed or skipped delivery.
router.post("/:orderId/payment-links/:paymentId/qr", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), sendPaymentLinkQr);
router.get("/:orderId/payment-links/:paymentId/qr", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), viewPaymentLinkQr);
// Refund APPROVAL workflow: raise a request (no refund is executed here or on approval). Same role set + lead scope as order creation.
router.post("/:orderId/payments/:paymentId/resolve-cashfree", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), resolveCashfreeReferences);
router.post("/:orderId/refund-requests", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), createRefundRequest);
// Shiprocket shipment for the order. Shipping is an operational step: ADMIN/MANAGER, within their lead scope.
router.post("/:orderId/shipments", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), createShipment);

export default router;
