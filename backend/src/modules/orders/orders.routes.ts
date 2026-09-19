import { Router } from "express";
import { requireAuth } from "@/middlewares/auth.js";
import { getOrder, getOrderFilterOptions, getOrderStatusHistory, listOrders } from "./orders.controller.js";

const router = Router();

// Registered before "/:id" so "filter-options" is not read as an order id.
router.get("/filter-options", requireAuth, getOrderFilterOptions);
router.get("/", requireAuth, listOrders);
router.get("/:id", requireAuth, getOrder);
router.get("/:id/status-history", requireAuth, getOrderStatusHistory);

export default router;
