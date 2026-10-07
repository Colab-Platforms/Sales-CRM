// Helpers for the abandoned-leads "Items" filter. An item KEY identifies one product by its most stable id (p:/v:/s:) or, for older
// carts that only stored names, by name (n:). Keys always come from GET /abandonments/items - nothing is hardcoded here.
import type { CartSnapshot } from "@/lib/api-client/types/abandonment.types";

export interface ItemOption {
  key: string;
  name: string;
  sku: string | null;
  /** Abandoned checkouts the viewer can see that contain this product. */
  count: number;
}

/** Query-string form: URL-encoded keys joined by commas (a key itself may contain commas). */
export const encodeItemKeys = (keys: string[]): string => keys.map(encodeURIComponent).join(",");

/** A readable label for a key without needing the options list ("s:SG|Sleep Gummies" -> "Sleep Gummies"). */
export function itemKeyLabel(key: string): string {
  const m = /^[pvsn]:([^|]*)(?:\|([\s\S]*))?$/.exec(key);
  return m ? (m[2] ?? m[1] ?? key) : key;
}

export function toggleKey(selected: string[], key: string): string[] {
  return selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
}

/** Client-side narrowing of the loaded options while typing: name or SKU, case-insensitive. */
export function searchItemOptions(options: ItemOption[], search: string): ItemOption[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((o) => o.name.toLowerCase().includes(needle) || (o.sku ?? "").toLowerCase().includes(needle));
}

export interface CartLine {
  name: string;
  quantity: number | null;
}

/** What the Items column shows: "Herbal Paan Masala × 2" lines when quantities are known, plain names otherwise. */
export function cartLines(snapshot: Pick<CartSnapshot, "items" | "itemNames"> | null | undefined, fallbackNames: string[] = []): CartLine[] {
  if (snapshot?.items && snapshot.items.length > 0) return snapshot.items.map((i) => ({ name: i.name, quantity: i.quantity }));
  const names = snapshot?.itemNames?.length ? snapshot.itemNames : fallbackNames;
  return names.map((name) => ({ name, quantity: null }));
}

export const lineLabel = (l: CartLine): string => (l.quantity && l.quantity > 0 ? `${l.name} × ${l.quantity}` : l.name);
