import type { CreateManualOrderItemInput } from "@/lib/api-client/types/orders.types";

// A CUSTOM order item: a free-form line (name + price + quantity) that is not in the Shopify catalogue. It has no product or variant id - the server stores it on the order line itself and sends it to
// Shopify as a custom line item. Nothing here is trusted by the server: it recomputes every line and total. This file is only the form's rules, defaults and request shape.

export const CUSTOM_ITEM_MAX_QUANTITY = 999;
export const CUSTOM_ITEM_NAME_MAX = 200;
export type CustomWeightUnit = "KG" | "G";
export const CUSTOM_WEIGHT_UNITS: { value: CustomWeightUnit; label: string }[] = [
  { value: "KG", label: "kg" },
  { value: "G", label: "g" },
];

/** What the "Add custom item" form holds. Strings, as typed. */
export interface CustomItemForm {
  name: string;
  price: string;
  quantity: string;
  taxable: boolean;
  physical: boolean;
  weight: string;
  weightUnit: CustomWeightUnit;
}

/**
 * Defaults, visible and editable in the form. Taxable is OFF because the CRM adds no tax of its own and invents no tax rate (tick it only if Shopify should treat the item as taxable);
 * physical is ON because the CRM's items are physical goods unless stated otherwise (a service ships nothing). Weight is optional.
 */
export const CUSTOM_ITEM_DEFAULTS: CustomItemForm = { name: "", price: "", quantity: "1", taxable: false, physical: true, weight: "", weightUnit: "KG" };

/** What stays on a draft order line after the form is submitted (the line itself carries price and quantity as editable strings). */
export interface CustomItemDraft {
  name: string;
  taxable: boolean;
  physical: boolean;
  weight: string;
  weightUnit: CustomWeightUnit;
}

export type CustomItemErrors = Partial<Record<"name" | "price" | "quantity" | "weight", string>>;

const MONEY = /^\d+(\.\d{1,2})?$/;
const WEIGHT = /^\d+(\.\d{1,3})?$/;

/** Understandable messages for every rule the server also enforces. Empty object = valid. */
export function validateCustomItem(f: Pick<CustomItemForm, "name" | "price" | "quantity" | "physical" | "weight" | "weightUnit">): CustomItemErrors {
  const errors: CustomItemErrors = {};
  const name = f.name.trim();
  if (!name) errors.name = "Enter the item name.";
  else if (name.length > CUSTOM_ITEM_NAME_MAX) errors.name = `The name can be at most ${CUSTOM_ITEM_NAME_MAX} characters.`;
  const price = f.price.trim();
  if (!price) errors.price = "Enter the price.";
  else if (!MONEY.test(price)) errors.price = "Enter a price of 0 or more, with at most 2 decimals.";
  const qtyText = f.quantity.trim();
  const qty = Number(qtyText);
  if (!qtyText || !Number.isInteger(qty) || qty < 1) errors.quantity = "Quantity must be a whole number of 1 or more.";
  else if (qty > CUSTOM_ITEM_MAX_QUANTITY) errors.quantity = `Quantity can be at most ${CUSTOM_ITEM_MAX_QUANTITY}.`;
  const weight = f.weight.trim();
  if (f.physical && weight) {
    if (!WEIGHT.test(weight) || !(Number(weight) > 0)) errors.weight = "Weight must be a number greater than 0, with at most 3 decimals.";
    else if ((f.weightUnit === "KG" ? Number(weight) * 1000 : Number(weight)) > 1_000_000) errors.weight = "That weight is too large.";
  }
  return errors;
}

export const customDraftFromForm = (f: CustomItemForm): CustomItemDraft => ({
  name: f.name.trim().replace(/\s+/g, " "),
  taxable: f.taxable,
  physical: f.physical,
  // A non-physical item never carries a weight (it must not add to the parcel).
  weight: f.physical ? f.weight.trim() : "",
  weightUnit: f.weightUnit,
});

/** The request line for the server: no product / variant, no computed figures. */
export function customItemRequest(item: { quantity: string; unitPrice: string; custom: CustomItemDraft }): CreateManualOrderItemInput {
  const c = item.custom;
  return {
    itemType: "CUSTOM",
    customName: c.name,
    quantity: Number(item.quantity),
    unitPrice: item.unitPrice.trim(),
    taxable: c.taxable,
    requiresShipping: c.physical,
    ...(c.physical && c.weight ? { weight: c.weight, weightUnit: c.weightUnit } : {}),
  };
}

/** Weight of ONE unit in kg for the parcel-weight estimate: only a physical item with a typed weight contributes; null otherwise (never a guess). */
export function customUnitWeightKg(c: Pick<CustomItemDraft, "physical" | "weight" | "weightUnit">): number | null {
  if (!c.physical || !c.weight.trim()) return null;
  const n = Number(c.weight);
  if (!(n > 0)) return null;
  return c.weightUnit === "KG" ? n : n / 1000;
}

/** A line is ready to submit when its figures pass the same rules as the form. */
export const isCustomLineValid = (item: { quantity: string; unitPrice: string; custom: CustomItemDraft }): boolean =>
  Object.keys(validateCustomItem({ name: item.custom.name, price: item.unitPrice, quantity: item.quantity, physical: item.custom.physical, weight: item.custom.weight, weightUnit: item.custom.weightUnit })).length === 0;

/** Short flags for a custom line in lists and summaries, e.g. "Custom item · Taxable · Physical · 250 g". */
export function customItemFlags(c: { taxable: boolean | null; requiresShipping: boolean | null; weightGrams?: string | null }): string {
  const parts = ["Custom item", c.taxable ? "Taxable" : "Non-taxable", c.requiresShipping === false ? "Not physical" : "Physical"];
  const g = c.weightGrams ? Number(c.weightGrams) : 0;
  if (c.requiresShipping !== false && g > 0) parts.push(g >= 1000 ? `${g / 1000} kg` : `${g} g`);
  return parts.join(" · ");
}
