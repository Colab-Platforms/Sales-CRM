import { Router } from "express";
import authRoutes from "@modules/auth/auth.routes.js";
import dashboardRoutes from "@modules/dashboard/dashboard.routes.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({ success: true, message: "ok" });
});

router.use("/auth", authRoutes);
router.use("/dashboard", dashboardRoutes);

export default router;
