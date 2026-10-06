import { Router } from "express";
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
import websiteChatWebhookRoutes from "@modules/webhooks/website-chat/website-chat.routes.js";
import webChatRoutes from "@modules/webchat/webchat.routes.js";
import callRoutes from "@modules/call/call.routes.js";
import tasksRoutes from "@modules/tasks/tasks.routes.js";
import deliveryRoutes from "@modules/delivery/delivery.routes.js";
import abandonmentRoutes from "@modules/abandonment/abandonment.routes.js";

const router = Router();

// Provider webhooks: system-to-system, deliberately not behind requireAuth (see each controller).
router.use("/webhooks/exotel", exotelIvrRoutes);
router.use("/webhooks/callerdesk", callerDeskRoutes);
router.use("/webhooks/website-chat", websiteChatWebhookRoutes);

router.get("/health", (_req, res) => {
  res.status(200).json({ success: true, message: "ok" });
});

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
router.use("/lead", leadRoutes);
router.use("/calling", callingRoutes);
router.use("/calls", callRoutes);
router.use("/webchat", webChatRoutes);
router.use("/tasks", tasksRoutes);
router.use("/delivery", deliveryRoutes);
router.use("/abandonments", abandonmentRoutes);

export default router;
