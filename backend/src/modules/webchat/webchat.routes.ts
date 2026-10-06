import { Router } from "express";
import {
  archiveWebChatConversation,
  assignWebChatConversation,
  getWebChatConversation,
  handoffWebChatConversation,
  listWebChatConversations,
  markWebChatRead,
  returnWebChatToAi,
  sendWebChatAgentMessage,
} from "./webchat.controller.js";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";

const router = Router();

router.use(requireAuth);
router.use(requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON));

router.get("/conversations", listWebChatConversations);
router.get("/conversations/:id", getWebChatConversation);
router.post("/conversations/:id/read", markWebChatRead);
router.post("/conversations/:id/assign", assignWebChatConversation);
router.post("/conversations/:id/handoff", handoffWebChatConversation);
router.post("/conversations/:id/ai-mode", returnWebChatToAi);
router.post("/conversations/:id/archive", archiveWebChatConversation);
router.post("/conversations/:id/messages", sendWebChatAgentMessage);

export default router;
