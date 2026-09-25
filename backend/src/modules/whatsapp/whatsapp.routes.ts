import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import {
  getCustomerWhatsAppStatus,
  getWhatsAppMessage,
  getWhatsAppStatus,
  listWhatsAppConversations,
  listWhatsAppMessages,
  sendWhatsAppMessage,
} from "./whatsapp.controller.js";
import { previewTemplateMessage, sendOrderConfirmationTest, sendTemplateMessage as sendTemplateMessageV2 } from "./whatsapp.messaging.controller.js";
import {
  createTemplate,
  getTemplate,
  listTemplates,
  syncTemplates,
  updateTemplate,
} from "./whatsapp.template.controller.js";
import { listAutomationConfigs, updateAutomationConfig } from "./whatsapp.automation.controller.js";
import {
  createWhatsAppCloudConfig,
  getWhatsAppCloudConfig,
  resetWhatsAppCloudConfig,
  testWhatsAppCloudConfig,
} from "./whatsapp.cloud-config.controller.js";
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
import {
  archiveConversation,
  assignConversation,
  confirmOrderDraft,
  getConversationDetail,
  getOrderDraft,
  handoffConversation,
  markConversationRead,
  returnConversationToAi,
  sendConversationText,
  getMessagingCapability,
  unarchiveConversation,
} from "./whatsapp.conversation.controller.js";
import { searchCatalog } from "./whatsapp.catalog.controller.js";

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

// Safe, manual test path for the AiSensy order-confirmation template (built for this task - see
// whatsapp.messaging.service.ts's sendOrderConfirmationTest). Never auto-triggered by order
// creation/Shopify/Cashfree; a real authenticated user must call it, scoped to their own leads via
// the order the same way "/messages/template" already is - no separate role gate.
router.post("/test/order-confirmation", requireAuth, sendOrderConfirmationTest);

// E7.4 Conversation/Message History. Read-only; same lead-scope RBAC as everything else here - a
// leadId filter narrows to one customer's conversation (what Customer 360 uses), or is left off
// for an org-wide view (still scoped: a salesperson only ever sees their own leads' messages).
// No separate GET /customers/:leadId/whatsapp/messages route: this one already serves that case
// via ?leadId=, so a second route would only duplicate it.
router.get("/messages", requireAuth, listWhatsAppMessages);
router.get("/messages/:id", requireAuth, getWhatsAppMessage);

// Central WhatsApp Inbox (Admin/Telecaller conversation list) - one row per Lead with a message,
// same lead-scope RBAC as the rest of this block. Registered here, not as a new module, since it
// reads the exact same whatsapp_messages table via WhatsAppService.
router.get("/conversations", requireAuth, listWhatsAppConversations);

// WhatsApp Inbox conversation-level actions (assignment, AI/human mode, read state, free-text send,
// AI order draft) - all RBAC'd inside the service (lead-scope OR the conversation's own assignee,
// see whatsapp.conversation.service.ts's assertAccess). Registered right after the list route above
// they all extend.
router.get("/conversations/:leadId", requireAuth, getConversationDetail);
router.post("/conversations/:leadId/read", requireAuth, markConversationRead);
router.post("/conversations/:leadId/assign", requireAuth, assignConversation);
router.post("/conversations/:leadId/handoff", requireAuth, handoffConversation);
router.post("/conversations/:leadId/ai-mode", requireAuth, returnConversationToAi);
// Delete/archive - reachable from both the inbox list and the open conversation. Same RBAC as every
// other conversation action (assertAccess inside the service): lead-scope or the conversation's own assignee.
router.post("/conversations/:leadId/archive", requireAuth, archiveConversation);
router.post("/conversations/:leadId/unarchive", requireAuth, unarchiveConversation);
router.get("/conversations/:leadId/capability", requireAuth, getMessagingCapability);
router.post("/conversations/:leadId/messages", requireAuth, sendConversationText);

// Thin wrapper over the existing product catalog (products.service.ts) - see whatsapp.catalog.controller.ts.
router.get("/catalog/search", requireAuth, searchCatalog);

// AI order-taking draft: read-only view of the accumulated draft, and the human-triggered
// "confirm now" action (the same idempotent path the AI's own confirmation uses).
router.get("/orders/:leadId/draft", requireAuth, getOrderDraft);
router.post("/orders/:leadId/confirm", requireAuth, confirmOrderDraft);

// E7.6 Lifecycle Automation config. Same ADMIN-only convention as template create/edit/sync above -
// deciding which template an automated business event sends is an administrative action, not
// something scoped by lead ownership. Registered after "/messages/:id" so nothing here can collide
// with that param route (different path segment entirely, but keeping the same top-to-bottom order
// as the rest of this file).
router.get("/automations", requireAuth, requireRole(Role.ADMIN), listAutomationConfigs);
router.patch("/automations/:automationType", requireAuth, requireRole(Role.ADMIN), updateAutomationConfig);

// WhatsApp Cloud API (Meta, official) foundation - admin-only, same convention as automations/
// templates above. POST both creates (no existing config) and replaces (confirmOverwrite: true) -
// see whatsapp.cloud-config.service.ts's createConfig for why there is no separate PATCH route.
router.get("/cloud-config", requireAuth, requireRole(Role.ADMIN), getWhatsAppCloudConfig);
router.post("/cloud-config", requireAuth, requireRole(Role.ADMIN), createWhatsAppCloudConfig);
router.post("/cloud-config/test", requireAuth, requireRole(Role.ADMIN), testWhatsAppCloudConfig);
router.delete("/cloud-config", requireAuth, requireRole(Role.ADMIN), resetWhatsAppCloudConfig);

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
