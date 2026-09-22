import { Router } from "express";
import authRoutes from "@modules/auth/auth.routes.js";
import dashboardRoutes from "@modules/dashboard/dashboard.routes.js";
import adminRoutes from "@modules/admin/admin.routes.js";
import managerRoutes from "@modules/manager/manager.routes.js";
import leadRoutes from "@modules/lead/lead.routes.js";
import integrationsRoutes from "@modules/integrations/integrations.routes.js";
import callingRoutes from "@modules/calling/calling.routes.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ success: true, message: "ok" });
});

router.use("/auth", authRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/admin", adminRoutes);
router.use("/manager", managerRoutes);
router.use("/lead", leadRoutes);
router.use("/integrations", integrationsRoutes);
router.use("/calling", callingRoutes);

export default router;
