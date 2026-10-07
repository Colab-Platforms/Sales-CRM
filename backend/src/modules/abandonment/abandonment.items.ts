import type { Prisma } from "../../../generated/prisma/client.js";
import type { CartSnapshotItem } from "./abandonment.types.js";

// The "Items" filter of the abandoned-leads queue. A filter value (an "item key") identifies ONE product by its most stable
// identifier: `p:<productId>`, else `v:<variantId>`, else `s:<sku>`, else `n:<name>`. Keys are built from real cart data and
// handed to the UI by GET /abandonments/items - nothing is hardcoded. A key may carry the display name after a `|`
// (`s:SKU1|Sleep Gummies`): carts captured before ids/SKUs were stored only have names, so an id key also matches those by name.
// Several keys mean "any of these" (OR), the same rule the Orders column filters use.

export type ItemKind = "p" | "v" | "s" | "n";
export interface ItemKey {
  kind: ItemKind;
  value: string;
  name: string | null;
}

const MAX_KEYS = 50;
const KEY = /^([pvsn]):([^|]+)(?:\|(.*))?$/s;

export function itemKeyOf(item: { productId: string | null; variantId: string | null; sku: string | null; name: string }): string {
  const name = item.name.trim();
  if (item.productId) return `p:${item.productId}|${name}`;
  if (item.variantId) return `v:${item.variantId}|${name}`;
  if (item.sku) return `s:${item.sku}|${name}`;
  return `n:${name}`;
}

export function decodeItemKey(raw: string): ItemKey | null {
  const m = KEY.exec(raw);
  if (!m) return null;
  const value = m[2]!.trim();
  if (!value) return null;
  return { kind: m[1] as ItemKind, value, name: m[3] ? m[3].trim() || null : null };
}

/** Query-string value -> keys. null = malformed (rejected with a 400), never silently ignored. */
export function parseItemKeys(raw: string): string[] | null {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > MAX_KEYS) return null;
  const keys: string[] = [];
  for (const part of parts) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!decodeItemKey(decoded)) return null;
    if (!keys.includes(decoded)) keys.push(decoded);
  }
  return keys;
}

export const encodeItemKeys = (keys: string[]): string => keys.map(encodeURIComponent).join(",");

export function readSnapshotItems(value: unknown): CartSnapshotItem[] {
  if (!Array.isArray(value)) return [];
  const out: CartSnapshotItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || !e.name) continue;
    out.push({
      productId: typeof e.productId === "string" ? e.productId : null,
      variantId: typeof e.variantId === "string" ? e.variantId : null,
      sku: typeof e.sku === "string" ? e.sku : null,
      name: e.name,
      quantity: typeof e.quantity === "number" ? e.quantity : null,
    });
  }
  return out;
}

const containsItem = (field: "productId" | "variantId" | "sku", value: string): Prisma.AbandonmentWhereInput => ({ cartSnapshot: { path: ["items"], array_contains: [{ [field]: value }] } });
const containsName = (name: string): Prisma.AbandonmentWhereInput => ({ cartSnapshot: { path: ["itemNames"], array_contains: name } });

/** Server-side: abandonments whose cart contains ANY of the chosen products. */
export function abandonmentItemsWhere(rawKeys: string[]): Prisma.AbandonmentWhereInput {
  const or: Prisma.AbandonmentWhereInput[] = [];
  for (const raw of rawKeys) {
    const key = decodeItemKey(raw);
    if (!key) continue;
    if (key.kind === "p") or.push(containsItem("productId", key.value));
    else if (key.kind === "v") or.push(containsItem("variantId", key.value));
    else if (key.kind === "s") or.push(containsItem("sku", key.value));
    if (key.kind === "n") or.push(containsName(key.value));
    else if (key.name) or.push(containsName(key.name)); // older carts of the same product that only stored names
  }
  // A key list that decoded to nothing must match nothing, never everything.
  return or.length > 0 ? { OR: or } : { id: { in: [] } };
}

export interface ItemOption {
  key: string;
  name: string;
  sku: string | null;
  /** Abandoned checkouts (in the viewer's scope) that contain this product. */
  count: number;
}

/** Distinct products across the given snapshots, most-abandoned first. `search` matches name or SKU, case-insensitively. */
export function aggregateItemOptions(rows: { id: string; cartSnapshot: unknown }[], search?: string): ItemOption[] {
  const byKey = new Map<string, { option: ItemOption; ids: Set<string> }>();
  const nameOnly = new Map<string, { option: ItemOption; ids: Set<string> }>();
  const lower = (s: string) => s.trim().toLowerCase();
  const add = (map: Map<string, { option: ItemOption; ids: Set<string> }>, mapKey: string, option: Omit<ItemOption, "count">, id: string) => {
    let entry = map.get(mapKey);
    if (!entry) {
      entry = { option: { ...option, count: 0 }, ids: new Set() };
      map.set(mapKey, entry);
    }
    entry.ids.add(id);
  };

  for (const row of rows) {
    const snap = (row.cartSnapshot ?? {}) as Record<string, unknown>;
    const items = readSnapshotItems(snap.items);
    for (const item of items) {
      const key = itemKeyOf(item);
      if (key.startsWith("n:")) add(nameOnly, lower(item.name), { key, name: item.name, sku: null }, row.id);
      else add(byKey, key, { key, name: item.name, sku: item.sku }, row.id);
    }
    // Carts captured before line items were stored: names only.
    if (items.length === 0 && Array.isArray(snap.itemNames)) {
      for (const n of snap.itemNames) if (typeof n === "string" && n.trim()) add(nameOnly, lower(n), { key: `n:${n.trim()}`, name: n.trim(), sku: null }, row.id);
    }
  }

  // A name-only product that also exists with an id/SKU is the same product: fold its older carts into that option.
  const idByName = new Map<string, { option: ItemOption; ids: Set<string> }>();
  for (const entry of byKey.values()) if (!idByName.has(lower(entry.option.name))) idByName.set(lower(entry.option.name), entry);
  for (const [name, entry] of nameOnly) {
    const target = idByName.get(name);
    if (target) entry.ids.forEach((id) => target.ids.add(id));
    else byKey.set(`n:${name}`, entry);
  }

  const needle = search ? lower(search) : "";
  return [...byKey.values()]
    .map(({ option, ids }) => ({ ...option, count: ids.size }))
    .filter((o) => !needle || lower(o.name).includes(needle) || (o.sku ? lower(o.sku).includes(needle) : false))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
