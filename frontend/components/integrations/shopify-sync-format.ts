import type { ShopifyCrmOrderSync } from "@/lib/api-client/types/integrations.types";

/** Pure: the wording the Shopify settings page shows for the current setting (undefined = not loaded yet, shown as the default ON). */
export function formatSyncStatus(setting: ShopifyCrmOrderSync | undefined): { badge: string; on: string; off: string; updated: string } {
  const enabled = setting?.enabled ?? true;
  return {
    badge: enabled ? "ON" : "OFF",
    on: "ON: new CRM-created orders follow the existing Shopify order sync (COD pushed at once; prepaid created after the payment is verified).",
    off: "OFF: new CRM-created orders are not created in Shopify (no order, no draft). They stay in the CRM, and payment, Shiprocket shipping and tracking carry on as usual.",
    updated: setting?.updatedAt ? `Last changed ${new Date(setting.updatedAt).toLocaleString()}.` : "Never changed: the default is ON.",
  };
}
