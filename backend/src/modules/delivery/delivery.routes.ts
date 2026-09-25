import { Router } from "express";
import { requireAuth } from "@/middlewares/auth.js";
import { getPincode, getServiceability } from "./delivery.controller.js";

const router = Router();

// Mounted at /api/delivery: address checks used while creating an order.
router.get("/pincode/:pincode", requireAuth, getPincode);
router.get("/serviceability", requireAuth, getServiceability);

export default router;
