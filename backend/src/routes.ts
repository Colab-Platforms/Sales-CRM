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
import tasksRoutes from "@modules/tasks/tasks.routes.js";
import deliveryRoutes from "@modules/delivery/delivery.routes.js";
import offersRoutes from "@modules/offers/offers.routes.js";
import discountRoutes from "@modules/discounts/discounts.routes.js";
import abandonmentRoutes from "@modules/abandonment/abandonment.routes.js";
import recruitmentRoutes from "@modules/recruitment/recruitment.routes.js";
import refundRoutes from "@modules/refunds/refunds.routes.js";
import attendanceRoutes from "@modules/attendance/attendance.routes.js";
import ticketsRoutes from "@modules/tickets/tickets.routes.js";
import { prisma } from "@/lib/prisma.js";
import { createCachedDatabaseCheck } from "@/lib/dbHealth.js";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../generated/prisma/enums.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ success: true, message: "ok" });
});

// Readiness: actually reaches the database (this wakes a suspended Neon compute), so it is admin-only and cached for 30 s - an open endpoint would let anyone keep the database awake
// and burn the compute quota. Deliberately separate from /health so uptime monitors never touch the database. Do NOT point a monitor at this route.
const checkDb = createCachedDatabaseCheck(prisma);
router.get("/health/db", requireAuth, requireRole(Role.ADMIN), async (_req, res) => {
  const health = await checkDb();
  res.setHeader("Cache-Control", "no-store");
  res.status(health.ok ? 200 : 503).json({ success: health.ok, message: health.ok ? "database reachable" : "database unavailable", data: health });
});

router.use("/auth", authRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/admin", adminRoutes);
router.use("/manager", managerRoutes);
router.use("/orders", ordersRoutes);
router.use("/discounts", discountRoutes);
router.use("/offers", offersRoutes);
router.use("/products", productsRoutes);
router.use("/customers", customersRoutes);
router.use("/audit", auditRoutes);
router.use("/whatsapp", whatsappRoutes);
router.use("/payments", paymentsRoutes);
router.use("/shipments", shipmentsRoutes);
router.use("/integrations", integrationsRoutes);
router.use("/lead", leadRoutes);
router.use("/calling", callingRoutes);
router.use("/tasks", tasksRoutes);
router.use("/delivery", deliveryRoutes);
router.use("/abandonments", abandonmentRoutes);
router.use("/recruitment", recruitmentRoutes);
router.use("/refund-requests", refundRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/tickets", ticketsRoutes);

export default router;
