import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { ActivitySource, ActivityType, Role } from "../../../generated/prisma/enums.js";
import type { OrderConversationState, Prisma } from "../../../generated/prisma/client.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import ProductsService from "../products/products.service.js";
import OrdersService from "../orders/orders.service.js";
import type { CreateManualOrderInput } from "../orders/orders.types.js";
import { resolveAIProvider } from "./whatsapp.ai.factory.js";
import { OrderExtractionError, type AIProvider } from "./whatsapp.ai.provider.js";
import type { CatalogSnippetItem, OrderExtraction } from "./whatsapp.ai.types.js";
import type { OrderDraft } from "./whatsapp.conversation.types.js";
import WhatsAppConversationService from "./whatsapp.conversation.service.js";
import { getMetaWhatsAppProvider } from "./whatsapp.meta.factory.js";

// Orchestrates one inbound WhatsApp message through the AI order-taking state machine. Invoked from
// whatsapp.service.ts's recordInboundMessage, only when the conversation is in AI mode, and only
// once per real inbound message (that method's own idempotency guard already prevents a retried
// webhook from calling this twice).
//
// The AI's opinion is never trusted on its own for the two decisions that matter: whether to
// auto-reply with free text (gated on the active provider actually supporting it - AiSensy/Gupshup
// cannot send free text at all today), and whether to create an order (gated on an independent
// keyword check on the customer's own raw message, not just the model's customerConfirmed flag).

const CONFIDENCE_THRESHOLD = 0.5;
const HISTORY_WINDOW = 12;
const CATALOG_WINDOW = 30;

// A deliberately small, conservative set - false negatives (asking again) are safe; false positives
// (creating an order the customer didn't actually confirm) are not.
const CONFIRMATION_PATTERN = /\b(yes|yeah|yep|confirm(ed)?|place\s*(the\s*)?order|go\s*ahead|book\s*it)\b/i;

const STOP_WORDS = new Set(["want", "need", "please", "bhej", "send", "give", "order", "yes", "confirm", "cod", "the", "and", "for", "with", "that", "this", "want", "karo", "kardo", "chahiye"]);

/** Up to three distinctive words (from the message and any product already in the draft) to run
 *  through the existing catalog search - so ambiguous phrasing like "that immunity one" still pulls
 *  the matching products into the AI's context. */
function searchTerms(messageText: string, draft: OrderDraft | null): string[] {
  const words = [...(draft?.productName ? [draft.productName] : []), ...messageText.toLowerCase().split(/[^a-z0-9]+/)]
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w.toLowerCase()) && !/^\d+$/.test(w));
  return [...new Set(words)].slice(0, 3);
}

export function computeOrderState(draft: OrderDraft): OrderConversationState {
  if (!draft.productId) return "DISCOVERY";
  if (!draft.quantity) return "PRODUCT_SELECTED";
  if (!draft.customerName || !draft.phone) return "QUANTITY_SELECTED";
  if (!draft.addressLine || !draft.city || !draft.state || !draft.pincode) return "ADDRESS_REQUIRED";
  if (!draft.paymentMethod) return "ADDRESS_CONFIRMED";
  return "ORDER_REVIEW";
}

function mergeDraft(current: OrderDraft | null, catalog: CatalogSnippetItem[], extraction: OrderExtraction): OrderDraft {
  const draft: OrderDraft = { ...current };

  if (extraction.productMention) {
    const product = catalog.find((p) => p.name.toLowerCase() === extraction.productMention!.toLowerCase())
      ?? catalog.find((p) => p.name.toLowerCase().includes(extraction.productMention!.toLowerCase()));
    if (product) {
      draft.productId = product.id;
      draft.productName = product.name;
      draft.unitPrice = product.basePrice ?? undefined;
      draft.variantId = undefined;
      draft.variantName = undefined;
      if (extraction.variantMention) {
        const variant = product.variants.find((v) => v.name.toLowerCase() === extraction.variantMention!.toLowerCase());
        if (variant) {
          draft.variantId = variant.id;
          draft.variantName = variant.name;
          draft.unitPrice = variant.price ?? draft.unitPrice;
        }
      }
    }
  }
  if (extraction.quantity) draft.quantity = extraction.quantity;
  if (extraction.customerName) draft.customerName = extraction.customerName;
  if (extraction.phone) draft.phone = extraction.phone;
  if (extraction.addressLine) draft.addressLine = extraction.addressLine;
  if (extraction.city) draft.city = extraction.city;
  if (extraction.state) draft.state = extraction.state;
  if (extraction.pincode) draft.pincode = extraction.pincode;
  if (extraction.paymentMethod) draft.paymentMethod = extraction.paymentMethod;
  return draft;
}

export interface ProcessInboundForAiInput {
  leadId: string;
  messageText: string;
  conversation: { provider: "AISENSY" | "GUPSHUP" | "META"; assignedToId: string | null; orderState: OrderConversationState; orderDraft: OrderDraft | null };
}

class WhatsAppOrderConversationService {
  private readonly conversationService: WhatsAppConversationService;
  private readonly productsService: ProductsService;
  private readonly ordersService: Pick<OrdersService, "createManualOrder">;

  // getAI/ordersService are injectable so tests can exercise this service's own logic (draft
  // merging, state machine, confirmation gating, idempotency claim, provider-based send gating,
  // handoff conditions) against fakes - never a real AI API call, and without re-testing
  // OrdersService.createManualOrder's own internals (already covered by orders.create.db-test.ts
  // and friends) - same "factory the constructor can override" shape as OrdersService's own
  // getShopifyClient / WhatsAppService's getProvider. This service depends on the AIProvider
  // interface only; which vendor sits behind it is whatsapp.ai.factory.ts's concern.
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getAI: () => AIProvider | null | Promise<AIProvider | null> = () => resolveAIProvider(db),
    ordersService?: Pick<OrdersService, "createManualOrder">,
    private readonly getMetaProvider: typeof getMetaWhatsAppProvider = getMetaWhatsAppProvider,
  ) {
    this.conversationService = new WhatsAppConversationService(db);
    this.productsService = new ProductsService(db);
    this.ordersService = ordersService ?? new OrdersService(db);
  }

  async processInboundForAi({ leadId, messageText, conversation }: ProcessInboundForAiInput): Promise<void> {
    // The order for this conversation already exists. The AI does not start a second one from the
    // same conversation (a customer's "yes thanks" after ordering must never re-confirm the old
    // draft); anything further - status questions, a repeat order - is for a salesperson.
    if (conversation.orderState === "ORDER_CREATED") {
      await this.conversationService.setModeInternal(leadId, "HUMAN", "An order was already placed in this conversation - a salesperson should follow up");
      return;
    }
    if (!conversation.assignedToId) {
      await this.conversationService.setModeInternal(leadId, "HUMAN", "No salesperson is assigned to this conversation - the AI needs an assignee to act on their behalf.");
      return;
    }
    const assignedUserExists = await this.db.user.findUnique({ where: { id: conversation.assignedToId }, select: { id: true } });
    if (!assignedUserExists) {
      await this.conversationService.setModeInternal(leadId, "HUMAN", "The assigned salesperson could not be found.");
      return;
    }

    // AI disabled (AI_PROVIDER=none) or not configured (no key): the AI cannot act, a human does.
    const ai = await this.getAI();
    if (!ai) {
      await this.conversationService.setModeInternal(leadId, "HUMAN", "AI is not configured");
      return;
    }

    const [recentMessages, catalogPage, matchedPages] = await Promise.all([
      this.db.whatsAppMessage.findMany({
        where: { leadId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: HISTORY_WINDOW,
        select: { direction: true, body: true },
      }),
      this.productsService.listProducts({ page: 1, pageSize: CATALOG_WINDOW }),
      // The existing catalog search, run for the words in this message, so a matching product is in
      // the AI's context even when the catalogue is larger than the general window above.
      Promise.all(searchTerms(messageText, conversation.orderDraft).map((search) => this.productsService.listProducts({ page: 1, pageSize: 10, search }))),
    ]);
    const history = recentMessages.reverse().map((m) => ({ direction: m.direction, text: m.body ?? "" }));
    const seen = new Set<string>();
    const catalog: CatalogSnippetItem[] = [];
    for (const p of [...matchedPages.flatMap((page) => page.items), ...catalogPage.items]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      catalog.push({ id: p.id, name: p.name, basePrice: p.basePrice, variants: p.variants.map((v) => ({ id: v.id, name: v.name, price: v.price })) });
    }

    let extraction;
    try {
      extraction = await ai.extractOrderInfo({ history, currentDraft: conversation.orderDraft, currentState: conversation.orderState, catalog, newMessageText: messageText });
    } catch (error) {
      // OrderExtractionError messages are fixed and credential-free by construction (see whatsapp.ai.provider.ts).
      const message = error instanceof OrderExtractionError ? error.message : "AI extraction failed";
      logger.error("WhatsApp AI order-taking extraction failed - handing off to a human", message);
      await this.conversationService.setModeInternal(leadId, "HUMAN", message);
      return;
    }

    if (extraction.confidence < CONFIDENCE_THRESHOLD) {
      await this.conversationService.setModeInternal(leadId, "HUMAN", `Low confidence (${extraction.confidence.toFixed(2)}) understanding the customer's message`);
      return;
    }
    if (extraction.customerWantsHuman) {
      await this.conversationService.setModeInternal(leadId, "HUMAN", "Customer asked to speak with a human");
      return;
    }
    if (extraction.unsupportedRequest) {
      await this.conversationService.setModeInternal(leadId, "HUMAN", "Request is outside order-taking");
      return;
    }

    const mergedDraft = mergeDraft(conversation.orderDraft, catalog, extraction);
    let nextState = computeOrderState(mergedDraft);

    const explicitlyConfirmed = extraction.customerConfirmed && CONFIRMATION_PATTERN.test(messageText) && nextState === "ORDER_REVIEW";
    if (explicitlyConfirmed) nextState = "CUSTOMER_CONFIRMED";

    // Conditional on the order not already having been created: a later message (or a concurrent one
    // that lost the race) must never overwrite ORDER_CREATED back to CUSTOMER_CONFIRMED, which is
    // exactly what would let a stale, still-complete draft be confirmed - and ordered - a second time.
    const persisted = await this.db.whatsAppConversation.updateMany({
      where: { leadId, orderState: { not: "ORDER_CREATED" } },
      data: { orderDraft: mergedDraft as unknown as Prisma.InputJsonValue, orderState: nextState, aiSuggestedReply: conversation.provider === "META" ? null : extraction.suggestedReply },
    });
    if (persisted.count === 0) return;

    if (nextState === "CUSTOMER_CONFIRMED") {
      await this.confirmDraftOrder(leadId, ActivitySource.SYSTEM, "Order created by AI order-taking");
    }

    if (conversation.provider === "META") {
      await this.sendAiReply(leadId, extraction.suggestedReply);
    }
  }

  /** The single order-creation path for both the AI's own confirmation and the human "confirm"
   *  route (whatsapp.conversation.controller.ts) - always acts as the conversation's assigned
   *  salesperson (createManualOrder needs a real AuthUser for its lead-scope RBAC; there is no
   *  "system" bypass), so a conversation with no assignee simply cannot have an order created for it.
   *
   *  Idempotency: the atomic claim is the conditional `orderState: CUSTOMER_CONFIRMED -> ORDER_CREATED`
   *  update below (same "conditional update, check the affected row count" idiom orders.service.ts's
   *  pushOrderToShopify already uses for Order.externalId) - Postgres serializes concurrent UPDATEs
   *  on the same row, so only one of two simultaneous triggers (a duplicate AI turn, a race with the
   *  human confirm button) can ever win the claim; the loser returns null without creating anything.
   *  A creation failure after winning the claim rolls the state back to CUSTOMER_CONFIRMED so a retry
   *  (the human confirm route) can win the claim again - it never leaves two orders behind. */
  async confirmDraftOrder(leadId: string, activitySource: "USER" | "SYSTEM" = "USER", activityTitle = "Order created from WhatsApp Inbox (AI draft)"): Promise<string | null> {
    const conversation = await this.db.whatsAppConversation.findUnique({ where: { leadId }, select: { orderDraft: true, orderState: true, assignedToId: true } });
    if (!conversation) return null;
    const draft = (conversation.orderDraft as unknown as OrderDraft) ?? {};
    if (!draft.productId || !draft.quantity || !draft.unitPrice || !draft.paymentMethod) {
      logger.error("WhatsApp order confirmation reached with an incomplete draft - not creating an order", JSON.stringify({ leadId }));
      return null;
    }
    if (!conversation.assignedToId) {
      logger.error("WhatsApp order confirmation has no assigned salesperson to act as - not creating an order", JSON.stringify({ leadId }));
      return null;
    }

    const claim = await this.db.whatsAppConversation.updateMany({ where: { leadId, orderState: { in: ["CUSTOMER_CONFIRMED", "ORDER_REVIEW"] } }, data: { orderState: "ORDER_CREATED" } });
    if (claim.count === 0) return null; // already created (or being created) by a concurrent trigger, or not actually confirmed

    const assignedUser = await this.db.user.findUnique({ where: { id: conversation.assignedToId }, select: { id: true, role: true, email: true } });
    if (!assignedUser) {
      await this.db.whatsAppConversation.update({ where: { leadId }, data: { orderState: "CUSTOMER_CONFIRMED" } });
      return null;
    }
    const actor: AuthUser = { id: assignedUser.id, role: assignedUser.role as Role, email: assignedUser.email };

    const input: CreateManualOrderInput = {
      leadId,
      items: [{ productId: draft.productId, variantId: draft.variantId, quantity: draft.quantity, unitPrice: draft.unitPrice }],
      paymentMethod: draft.paymentMethod,
      shippingAddress: { name: draft.customerName, line1: draft.addressLine, city: draft.city, state: draft.state, pincode: draft.pincode, phone: draft.phone },
      shippingPincode: draft.pincode,
    };

    try {
      const result = await this.ordersService.createManualOrder(actor, input);
      await this.db.whatsAppConversation.update({ where: { leadId }, data: { createdOrderId: result.order.id } });
      await this.db.activity.create({
        data: { leadId, actorId: actor.id, actorRole: actor.role, type: ActivityType.ORDER_CREATED, referenceType: "WhatsAppConversation", referenceId: leadId, source: activitySource === "SYSTEM" ? ActivitySource.SYSTEM : ActivitySource.USER, title: activityTitle, description: `Order ${result.order.orderNumber}` },
      });
      return result.order.id;
    } catch (error) {
      // Roll back so the claim can be retried - never leaves the conversation stuck at ORDER_CREATED
      // with no actual order.
      await this.db.whatsAppConversation.update({ where: { leadId }, data: { orderState: "CUSTOMER_CONFIRMED" } });
      logger.error("WhatsApp order creation failed - rolled back to CUSTOMER_CONFIRMED, safe to retry", error instanceof Error ? error.message : error);
      return null;
    }
  }

  /** Free-text auto-send is only reachable when the active provider is Meta - AiSensy/Gupshup have
   *  no free-text send capability today (message-composer.tsx's own comment confirms this), so their
   *  suggested reply is stored on the conversation for a human to review/send instead (see above). */
  private async sendAiReply(leadId: string, text: string): Promise<void> {
    const provider = await this.getMetaProvider(this.db);
    if (!provider) return;
    const lead = await this.db.lead.findUnique({ where: { id: leadId }, select: { normalizedMobile: true } });
    if (!lead?.normalizedMobile) return;

    try {
      const result = await provider.sendText({ to: lead.normalizedMobile, body: text });
      await this.db.whatsAppMessage.create({
        data: {
          provider: "META",
          providerMessageId: result.providerMessageId,
          direction: "OUTBOUND",
          messageType: "TEXT",
          status: result.providerMessageId ? "SENT" : "QUEUED",
          leadId,
          toNumber: lead.normalizedMobile,
          normalizedContact: lead.normalizedMobile,
          body: text.slice(0, 4000),
          sentAt: new Date(),
        },
      });
    } catch (error) {
      logger.error("WhatsApp AI reply send failed", error instanceof Error ? error.message : error);
    }
  }
}

export default WhatsAppOrderConversationService;
