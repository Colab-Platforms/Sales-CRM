import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import {
  getCustomerWhatsAppStatus,
  getWhatsAppMessage,
  getWhatsAppStatus,
  listWhatsAppMessages,
  sendWhatsAppMessage,
} from "./whatsapp.controller.js";
import { previewTemplateMessage, sendTemplateMessage as sendTemplateMessageV2 } from "./whatsapp.messaging.controller.js";
import {
  createTemplate,
  getTemplate,
  listTemplates,
  syncTemplates,
  updateTemplate,
} from "./whatsapp.template.controller.js";

const router = Router();

// Integration-wide configuration status is an admin/management concern, same as reconciliation.
router.get("/status", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), getWhatsAppStatus);
router.post("/send", requireAuth, sendWhatsAppMessage);
router.get("/customers/:leadId/status", requireAuth, getCustomerWhatsAppStatus);

// E7.2 Template Management. Everyone can view (a salesperson's view is narrowed to APPROVED
// templates in the service); creating/editing/syncing is an ADMIN-only administrative action, same
// as Users/Groups - registered before "/:id" so "sync" is never read as a template id.
router.get("/templates", requireAuth, listTemplates);
router.post("/templates/sync", requireAuth, requireRole(Role.ADMIN), syncTemplates);
router.post("/templates", requireAuth, requireRole(Role.ADMIN), createTemplate);
router.get("/templates/:id", requireAuth, getTemplate);
router.patch("/templates/:id", requireAuth, requireRole(Role.ADMIN), updateTemplate);

// E7.3 Template-Based Messaging. Same RBAC as "/send" above (lead scope decides who can message
// which customer, not a role gate) - an ADMIN/MANAGER/SALESPERSON can all send, scoped to the
// customers they can already access.
router.post("/messages/template/preview", requireAuth, previewTemplateMessage);
router.post("/messages/template", requireAuth, sendTemplateMessageV2);

// E7.4 Conversation/Message History. Read-only; same lead-scope RBAC as everything else here - a
// leadId filter narrows to one customer's conversation (what Customer 360 uses), or is left off
// for an org-wide view (still scoped: a salesperson only ever sees their own leads' messages).
// No separate GET /customers/:leadId/whatsapp/messages route: this one already serves that case
// via ?leadId=, so a second route would only duplicate it.
router.get("/messages", requireAuth, listWhatsAppMessages);
router.get("/messages/:id", requireAuth, getWhatsAppMessage);

export default router;
