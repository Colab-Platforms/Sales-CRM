// Who is OFFERED "Sync order to CRM" on a live (not yet synced) Shopify order. Mirrors the server's LIVE_ORDER_SYNC_ROLES - the server decides; this only hides a button that would be refused.
// Telecaller = SALESPERSON. HR is allowed to run the sync but, unlike the others, cannot open a live order page at all (orders are not readable by HR), so it is never shown the button there.
export const LIVE_ORDER_SYNC_ROLES = ["ADMIN", "MANAGER", "SALESPERSON", "HR"] as const;
export const canSyncLiveOrder = (role: string | null | undefined): boolean => LIVE_ORDER_SYNC_ROLES.includes(role as (typeof LIVE_ORDER_SYNC_ROLES)[number]);
