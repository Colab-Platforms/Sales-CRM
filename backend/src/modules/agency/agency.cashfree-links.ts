// Creates the payment link of an order for the agency API by calling the CRM's OWN Cashfree payment-link service (CashfreePaymentsService.createPaymentLink) - the same code, gateway credentials,
// amount rule ("what is still owed"), idempotency and link reuse the CRM's order page uses. Nothing about the gateway is duplicated here.
//
// That service records who created a payment (an activity row), so it needs a CRM user. The agency has none, so a fixed, existing, active user acts for it: AGENCY_ACTOR_USER_ID when set,
// otherwise the oldest active Admin. An Admin is unscoped, so the order is found whichever team owns it (Shopify-created COD orders have no CRM creator).
import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import type { AuthUser } from "@/middlewares/auth.js";
import CashfreePaymentsService from "../cashfree/cashfree.payments.service.js";
import type { PaymentLinkMaker } from "./agency.payment-link.service.js";

export class CashfreeLinkMaker implements PaymentLinkMaker {
  constructor(
    private readonly payments: Pick<CashfreePaymentsService, "createPaymentLink"> = new CashfreePaymentsService(),
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  private async actor(): Promise<AuthUser> {
    const configured = this.env.AGENCY_ACTOR_USER_ID?.trim();
    const user = configured
      ? await prisma.user.findFirst({ where: { id: configured, status: "ACTIVE" }, select: { id: true, username: true, role: true } })
      : await prisma.user.findFirst({ where: { role: "ADMIN", status: "ACTIVE" }, orderBy: { createdAt: "asc" }, select: { id: true, username: true, role: true } });
    if (!user) throw new ApiError("No active CRM user is available to create the payment link. Set AGENCY_ACTOR_USER_ID.", 503);
    return user;
  }

  async createLink(orderId: string) {
    const link = await this.payments.createPaymentLink(await this.actor(), orderId);
    return { paymentUrl: link.paymentUrl, amount: link.amount, reused: link.reused, expiresAt: link.expiresAt };
  }
}
