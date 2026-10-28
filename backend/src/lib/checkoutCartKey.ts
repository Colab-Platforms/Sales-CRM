/**
 * The identity of a checkout's CONTENTS, shared by the ingestion re-entry matcher and the dashboard's canonical-checkout rule so they cannot disagree.
 * Built from the FULL item list saved in the cart snapshot (`items`: variant id / SKU / product id / name + quantity), never from `itemNames`, which holds at most 3 product names for display.
 * Order-independent. When the full list is missing, the display names are used only if they are provably complete (itemCount <= names shown); otherwise there is NO key and the cart is never merged.
 */
export function cartItemsKey(snapshot: unknown): string | null {
  const s = (snapshot && typeof snapshot === "object" ? snapshot : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  if (Array.isArray(s.items) && s.items.length > 0) {
    const parts = s.items.map((raw) => {
      const i = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const id = text(i.variantId) || text(i.sku) || text(i.productId) || text(i.name).toLowerCase();
      return id ? `${id}x${typeof i.quantity === "number" && Number.isFinite(i.quantity) ? i.quantity : "?"}` : "";
    });
    return parts.some((p) => !p) ? null : JSON.stringify(parts.sort());
  }
  const names = Array.isArray(s.itemNames) ? s.itemNames.map((n) => text(n).toLowerCase()).filter(Boolean) : [];
  const count = typeof s.itemCount === "number" ? s.itemCount : typeof s.itemCount === "string" && s.itemCount.trim() !== "" ? Number(s.itemCount) : null;
  if (names.length === 0 || count === null || !Number.isFinite(count) || count > names.length) return null; // names may be truncated: unsafe to compare
  return JSON.stringify(names.sort());
}
