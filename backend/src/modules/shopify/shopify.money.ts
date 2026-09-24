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
