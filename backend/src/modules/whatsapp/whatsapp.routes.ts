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
import { listAutomationConfigs, updateAutomationConfig } from "./whatsapp.automation.controller.js";
import {
  cancelCampaign,
  createCampaign,
  getCampaign,
  launchCampaign,
  listCampaignRecipients,
  listCampaigns,
  previewCampaignAudience,
  updateCampaign,
} from "./whatsapp.campaign.controller.js";

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

// E7.6 Lifecycle Automation config. Same ADMIN-only convention as template create/edit/sync above -
// deciding which template an automated business event sends is an administrative action, not
// something scoped by lead ownership. Registered after "/messages/:id" so nothing here can collide
// with that param route (different path segment entirely, but keeping the same top-to-bottom order
// as the rest of this file).
router.get("/automations", requireAuth, requireRole(Role.ADMIN), listAutomationConfigs);
router.patch("/automations/:automationType", requireAuth, requireRole(Role.ADMIN), updateAutomationConfig);

// E7.7 Campaign & Bulk Messaging. Viewing (list/detail/recipients) is ADMIN+MANAGER, the same
// audience as the WhatsApp Status page above - a bulk-send tool is an organisational concern, not
// a per-lead one. Creating/editing/launching/cancelling is ADMIN-only, the same precedent as
// template create/edit/sync: a campaign's audience filters can span the whole org (beyond any one
// manager's team), so only ADMIN is trusted to decide who a bulk send reaches. A recipient list is
// still narrowed to the viewer's own lead scope regardless (see listRecipients), so a MANAGER can
// never see another team's customers through a campaign. Registered before "/:id" so "/preview"
// is never read as a campaign id.
router.post("/campaigns/preview", requireAuth, requireRole(Role.ADMIN), previewCampaignAudience);
router.post("/campaigns", requireAuth, requireRole(Role.ADMIN), createCampaign);
router.get("/campaigns", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), listCampaigns);
router.get("/campaigns/:id", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), getCampaign);
router.patch("/campaigns/:id", requireAuth, requireRole(Role.ADMIN), updateCampaign);
router.get("/campaigns/:id/recipients", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), listCampaignRecipients);
router.post("/campaigns/:id/launch", requireAuth, requireRole(Role.ADMIN), launchCampaign);
router.post("/campaigns/:id/cancel", requireAuth, requireRole(Role.ADMIN), cancelCampaign);

export default router;
