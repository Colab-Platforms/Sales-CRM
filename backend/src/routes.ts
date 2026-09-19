import { Router } from "express";
import { prisma } from "@/lib/prisma.js";
import { sendResponse } from "@/utils/responseUtils.js";
import { logger } from "@/utils/logger.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import authRoutes from "@modules/auth/auth.routes.js";
import dashboardRoutes from "@modules/dashboard/dashboard.routes.js";
import adminRoutes from "@modules/admin/admin.routes.js";
import managerRoutes from "@modules/manager/manager.routes.js";
import leadRoutes from "@modules/lead/lead.routes.js";
import exotelIvrRoutes from "@modules/webhooks/exotel/exotelIvr.routes.js";

const router = Router();

router.use("/webhooks/exotel", exotelIvrRoutes);

router.get("/health", (_req, res) => {
  res.status(200).json({ success: true, message: "ok" });
});

router.get("/health/db", async (_req, res) => {
  try {
    const userCount = await prisma.user.count();
    sendResponse(
      res,
      true,
      { api: "ok", database: "connected", userCount },
      "API is running and database connection is healthy",
      STATUS_CODES.OK,
    );
  } catch (err) {
    logger.error("Database health check failed", err instanceof Error ? err.message : "unknown error");
    sendResponse(res, false, null, "Database connection failed", STATUS_CODES.SERVER_ERROR);
  }
});

router.use("/auth", authRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/admin", adminRoutes);
router.use("/manager", managerRoutes);
router.use("/lead", leadRoutes);

export default router;
