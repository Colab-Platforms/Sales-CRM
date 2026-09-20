import { Router } from "express";
import authRoutes from "@modules/auth/auth.routes.js";
import dashboardRoutes from "@modules/dashboard/dashboard.routes.js";
import adminRoutes from "@modules/admin/admin.routes.js";
import managerRoutes from "@modules/manager/manager.routes.js";
import ordersRoutes from "@modules/orders/orders.routes.js";
import customersRoutes from "@modules/customers/customers.routes.js";
import auditRoutes from "@modules/audit/audit.routes.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ success: true, message: "ok" });
});

router.use("/auth", authRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/admin", adminRoutes);
router.use("/manager", managerRoutes);
router.use("/orders", ordersRoutes);
router.use("/customers", customersRoutes);
router.use("/audit", auditRoutes);

export default router;
