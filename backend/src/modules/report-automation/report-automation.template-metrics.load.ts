import type { AuthUser } from "@/middlewares/auth.js";
import { logger } from "@/utils/logger.js";
import AbandonedDashboardService from "../orders/abandoned.dashboard.service.js";
import LiveWebsiteDashboardService from "../orders/orders.dashboard.live.service.js";
import type { AbandonedMetrics, ShopifyMetrics, TemplateMetricsLoader, WebsiteMetrics } from "./report-automation.template-metrics.js";

/** Reads both dashboards for the report's days. Read-only; each section fails on its own into "N/A" so a problem in one never blocks the notification. */
export const loadTemplateMetrics: TemplateMetricsLoader = async (user, period) => {
  const as = { id: user.id, role: user.role, username: "report-automation" } as AuthUser;
  const range = { range: "custom" as const, from: period.from, to: period.to };
  const [web, abandoned] = await Promise.all([
    // ONE live Shopify read gives both the website figures and the complete Shopify set (website + telecaller-created, nothing excluded), so the two can never disagree.
    new LiveWebsiteDashboardService()
      .overview(as, { ...range, scope: "WEBSITE" }, 1, 1)
      .then((r): { website: WebsiteMetrics | null; shopify: ShopifyMetrics | null } => ({
        website: { totalOrders: r.summary.totalOrders, totalRevenue: r.summary.totalValue, codOrders: r.summary.cod, prepaidOrders: r.summary.prepaid, otherOrders: r.summary.otherPayment },
        shopify: { totalOrders: r.live.shopifyOrders, websiteOrders: r.live.websiteOrders, telecallerOrders: r.live.telecallerExcluded, totalRevenue: r.live.shopifyRevenue },
      }))
      .catch((error: unknown): { website: WebsiteMetrics | null; shopify: ShopifyMetrics | null } => {
        logger.error("Report template: Shopify order figures unavailable", error instanceof Error ? error.message.split("\n")[0] : "unknown error");
        return { website: null, shopify: null };
      }),
    new AbandonedDashboardService()
      .overview(as, range, 1, 1)
      .then((r): AbandonedMetrics => ({ totalLeads: r.summary.detected, ordersConverted: r.summary.conversion.converted, revenue: r.summary.conversion.revenue, codOrders: r.summary.conversion.cod.count, prepaidOrders: r.summary.conversion.prepaid.count }))
      .catch((error: unknown) => {
        logger.error("Report template: abandoned checkout figures unavailable", error instanceof Error ? error.message.split("\n")[0] : "unknown error");
        return null;
      }),
  ]);
  return { website: web.website, abandoned, shopify: web.shopify };
};
