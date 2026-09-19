import { Router } from "express";
import { requireAuth } from "@/middlewares/auth.js";
import { getCustomer360, getCustomerTimeline } from "./customers.controller.js";

const router = Router();

router.get("/:leadId", requireAuth, getCustomer360);
router.get("/:leadId/timeline", requireAuth, getCustomerTimeline);

export default router;
