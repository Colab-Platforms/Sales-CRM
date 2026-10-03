// Live Customers list: reads directly from Shopify (shopify.customers.ts's listCustomersForDisplay)
// instead of the CRM's own Lead table, mirroring orders.live.service.ts's design for the Orders list.
// CRM-owned fields (owner, working status, priority, lead number) are joined in afterwards by matching
// the Shopify customer's phone against Lead.normalizedMobile - the CRM's own existing dedupe key (see
// @/lib/leadIdentity.js), not a new identity scheme.
//
// Deliberately NOT changed by this module: the original DB-backed GET /customers endpoint
// (CustomersService.listCustomers) and Customer 360 - both untouched, still exist, still work.
import { prisma } from "@/lib/prisma.js";
import { getLeadScope, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { normalizeMobile } from "@/lib/leadIdentity.js";
import { Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShopifyClient, ShopifyApiError } from "../shopify/shopify.client.js";
import { loadShopifyConfig, ShopifyConfigError } from "../shopify/shopify.config.js";
import { listCustomersForDisplay, type NormalizedCustomerListItem } from "../shopify/shopify.customers.js";
import type { LiveCustomerListItem, LiveCustomerListResult, LiveCustomersQuery } from "./customers.live.types.js";

// Same in-process TTL Map idiom as orders.live.service.ts.
interface CacheEntry {
  value: LiveCustomerListResult;
  expiresAt: number;
}
const CACHE_TTL_MS = 30_000;
const listCache = new Map<string, CacheEntry>();

class CustomersLiveService {
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getShopifyClient: () => ShopifyClient = () => new ShopifyClient(loadShopifyConfig()),
  ) {}

  async listLiveCustomers(user: AuthUser, query: LiveCustomersQuery): Promise<LiveCustomerListResult> {
    const cacheKey = JSON.stringify({
      role: user.role,
      userId: user.id, // RBAC-sensitive: two different salespeople must never share a cached page.
      after: query.after ?? null,
      first: query.first,
      search: query.search ?? null,
    });
    const cached = listCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let client: ShopifyClient;
    try {
      client = this.getShopifyClient();
    } catch (error) {
      return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null }, error: error instanceof ShopifyConfigError ? error.message : "Shopify is not configured." };
    }

    let page;
    try {
      page = await listCustomersForDisplay(client, { first: query.first, after: query.after ?? null, search: query.search?.trim() || null });
    } catch (error) {
      const message = error instanceof ShopifyApiError ? error.message : "Could not reach Shopify - please try again.";
      return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null }, error: message };
    }

    const result = await this.attachCrmOverlay(user, page.items, page.hasNextPage, page.hasPreviousPage, page.endCursor);
    listCache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  // Joins the CRM's own Lead row (if any) onto the live Shopify page, by normalized mobile number.
  // RBAC: a Shopify customer with no matching CRM lead has no lead to check scope against, so - same
  // rule as the live Orders overlay - it's hidden entirely from non-ADMIN roles and shown to ADMIN
  // only, flagged linkedInCrm: false. A matched lead outside the caller's scope is also excluded.
  private async attachCrmOverlay(
    user: AuthUser,
    shopifyItems: NormalizedCustomerListItem[],
    hasNextPage: boolean,
    hasPreviousPage: boolean,
    endCursor: string | null,
  ): Promise<LiveCustomerListResult> {
    if (shopifyItems.length === 0) {
      return { items: [], pageInfo: { hasNextPage, hasPreviousPage, endCursor } };
    }

    let leadScope: Prisma.LeadWhereInput = {};
    try {
      leadScope = await getLeadScope(user, this.db);
    } catch {
      if (user.role !== Role.ADMIN) return { items: [], pageInfo: { hasNextPage, hasPreviousPage, endCursor }, partialError: "Could not verify your access scope - please retry." };
    }

    const phoneByExternalId = new Map(shopifyItems.map((c) => [c.externalId, normalizeMobile(c.phone)] as const));
    const normalizedPhones = [...new Set([...phoneByExternalId.values()].filter((p): p is string => Boolean(p)))];

    let crmRows: Awaited<ReturnType<typeof this.fetchCrmRows>> = [];
    let partialError: string | undefined;
    if (normalizedPhones.length > 0) {
      try {
        crmRows = await this.fetchCrmRows(normalizedPhones);
      } catch {
        partialError = "Owner/lead details could not be loaded for this page - showing Shopify data only.";
      }
    }
    const byPhone = new Map(crmRows.map((row) => [row.normalizedMobile!, row]));

    const leadIds = [...new Set(crmRows.map((r) => r.id))];
    const inScopeLeadIds = user.role === Role.ADMIN || leadIds.length === 0
      ? new Set(leadIds)
      : new Set((await this.db.lead.findMany({ where: { id: { in: leadIds }, ...leadScope }, select: { id: true } })).map((l) => l.id));

    const items: LiveCustomerListItem[] = [];
    for (const shopifyCustomer of shopifyItems) {
      const phone = phoneByExternalId.get(shopifyCustomer.externalId);
      const crm = phone ? (byPhone.get(phone) ?? null) : null;

      if (!crm) {
        if (user.role !== Role.ADMIN) continue;
        items.push(this.mapUnlinked(shopifyCustomer));
        continue;
      }
      if (!inScopeLeadIds.has(crm.id) && user.role !== Role.ADMIN) continue;

      items.push(this.mapLinked(shopifyCustomer, crm));
    }

    return { items, pageInfo: { hasNextPage, hasPreviousPage, endCursor }, partialError };
  }

  private fetchCrmRows(normalizedPhones: string[]) {
    return this.db.lead.findMany({
      where: { normalizedMobile: { in: normalizedPhones } },
      select: {
        id: true,
        leadNumber: true,
        normalizedMobile: true,
        workingStatus: true,
        priority: true,
        owner: { select: { id: true, name: true } },
      },
    });
  }

  private mapLinked(shopifyCustomer: NormalizedCustomerListItem, crm: NonNullable<Awaited<ReturnType<typeof this.fetchCrmRows>>>[number]): LiveCustomerListItem {
    return {
      id: crm.id,
      externalId: shopifyCustomer.externalId,
      name: shopifyCustomer.name ?? "Unknown",
      email: shopifyCustomer.email,
      phone: shopifyCustomer.phone,
      numberOfOrders: shopifyCustomer.numberOfOrders,
      amountSpent: shopifyCustomer.amountSpent,
      address: shopifyCustomer.address,
      leadId: crm.id,
      leadNumber: crm.leadNumber,
      owner: crm.owner,
      workingStatus: crm.workingStatus,
      priority: crm.priority,
      linkedInCrm: true,
    };
  }

  // A real Shopify customer the CRM has no matching lead for yet - shown to ADMIN only (see
  // attachCrmOverlay). id is the Shopify GID itself, still a stable React key.
  private mapUnlinked(shopifyCustomer: NormalizedCustomerListItem): LiveCustomerListItem {
    return {
      id: shopifyCustomer.id,
      externalId: shopifyCustomer.externalId,
      name: shopifyCustomer.name ?? shopifyCustomer.email ?? shopifyCustomer.phone ?? "Unknown",
      email: shopifyCustomer.email,
      phone: shopifyCustomer.phone,
      numberOfOrders: shopifyCustomer.numberOfOrders,
      amountSpent: shopifyCustomer.amountSpent,
      address: shopifyCustomer.address,
      leadId: null,
      leadNumber: null,
      owner: null,
      workingStatus: null,
      priority: null,
      linkedInCrm: false,
    };
  }
}

export default CustomersLiveService;
