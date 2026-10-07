// Shopify sends amounts as decimal strings ("649.0"). Arithmetic is done in whole cents so sums never drift.

export const toCents = (amount: string | null | undefined): number => (amount == null ? 0 : Math.round(Number(amount) * 100) || 0);

export const fromCents = (cents: number): string => (cents / 100).toFixed(2);

export const sumCents = (amounts: Array<string | null | undefined>): number => amounts.reduce<number>((sum, a) => sum + toCents(a), 0);

/** "gid://shopify/Order/1000000000002" -> "1000000000002". Numeric ids pass through unchanged. */
export function gidToId(gid: string | number): string {
  const text = String(gid);
  return text.includes("/") ? text.slice(text.lastIndexOf("/") + 1) : text;
}

export const toGid = (type: "Order" | "Product" | "Customer", id: string | number): string =>
  String(id).startsWith("gid://") ? String(id) : `gid://shopify/${type}/${id}`;

// An order's Shopify id is stored in ONE canonical form - the bare numeric id, which is what every Shopify-synced order has (gidToId strips the prefix on
// the way in). Orders the CRM pushed to Shopify before this was enforced hold the full "gid://shopify/Order/<n>" instead, so reads accept both.

/** The canonical (numeric) form of a Shopify order id; a value that is not a Shopify order id/GID is returned trimmed and unchanged. */
export function normalizeShopifyOrderId(id: string | number): string {
  const text = String(id ?? "").trim();
  const match = /^gid:\/\/shopify\/Order\/(\d+)$/.exec(text);
  return match ? match[1]! : text;
}

/** Every form a stored Order.externalId may take for the same Shopify order: canonical numeric first, then the GID. */
export function shopifyOrderIdVariants(id: string | number): string[] {
  const canonical = normalizeShopifyOrderId(id);
  return /^\d+$/.test(canonical) ? [canonical, `gid://shopify/Order/${canonical}`] : [canonical];
}
