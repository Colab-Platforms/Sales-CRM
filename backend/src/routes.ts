import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { sendResponse } from "@/utils/responseUtils.js";
import { logger } from "@/utils/logger.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import authRoutes from "@modules/auth/auth.routes.js";
import dashboardRoutes from "@modules/dashboard/dashboard.routes.js";
import adminRoutes from "@modules/admin/admin.routes.js";
import managerRoutes from "@modules/manager/manager.routes.js";
import ordersRoutes from "@modules/orders/orders.routes.js";
import productsRoutes from "@modules/products/products.routes.js";
import customersRoutes from "@modules/customers/customers.routes.js";
import auditRoutes from "@modules/audit/audit.routes.js";
import whatsappRoutes from "@modules/whatsapp/whatsapp.routes.js";
import leadRoutes from "./modules/lead/lead.routes.js";
import paymentsRoutes from "@modules/cashfree/cashfree.routes.js";
import shipmentsRoutes from "@modules/shiprocket/shiprocket.routes.js";
import integrationsRoutes from "@modules/integrations/integrations.routes.js";
import callingRoutes from "@modules/calling/calling.routes.js";
import exotelIvrRoutes from "@modules/webhooks/exotel/exotelIvr.routes.js";
import callerDeskRoutes from "@modules/webhooks/callerdesk/callerdesk.routes.js";
import callRoutes from "@modules/call/call.routes.js";


const router = Router();

// ─── Webhooks ─────────────────────────────────────────────
router.use("/webhooks/exotel", exotelIvrRoutes);
router.use("/webhooks/callerdesk", callerDeskRoutes);

// ─── Health ────────────────────────────────────────────────
router.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "ok",
  });
});

router.get("/health/db", async (_req, res) => {
  try {
    const userCount = await prisma.user.count();

    sendResponse(
      res,
      true,
      {
        api: "ok",
        database: "connected",
        userCount,
      },
      "API is running and database connection is healthy",
      STATUS_CODES.OK,
    );
  } catch (err) {
    logger.error(
      "Database health check failed",
      err instanceof Error ? err.message : "unknown error",
    );

    sendResponse(
      res,
      false,
      null,
      "Database connection failed",
      STATUS_CODES.SERVER_ERROR,
    );
  }
});

// ─── Core CRM ──────────────────────────────────────────────
router.use("/auth", authRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/admin", adminRoutes);
router.use("/manager", managerRoutes);
router.use("/orders", ordersRoutes);
router.use("/products", productsRoutes);
router.use("/customers", customersRoutes);
router.use("/audit", auditRoutes);
router.use("/whatsapp", whatsappRoutes);
router.use("/payments", paymentsRoutes);
router.use("/shipments", shipmentsRoutes);
router.use("/integrations", integrationsRoutes);
router.use("/lead", leadRoutes);                          // add with the other router.use lines
router.use("/calling", callingRoutes);
router.use("/calls", callRoutes);

export default router;