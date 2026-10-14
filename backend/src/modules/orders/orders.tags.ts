// The Orders "Tags" experience: ONE normalized tag list per order row, built from what already exists - the live Shopify tags and the
// CRM's own structured confirmation (Order.confirmedByName). There is no separate tag store. The confirmation tag is always derived
// from the CRM's confirmer here, never taken from a request, and never duplicated.
import { confirmationTagFor, isConfirmationTag } from "./orders.confirmation.js";
import { creatorTagFor } from "./orders.creator-tag.js";

const key = (tag: string) => tag.trim().toLowerCase();

/**
 * Shopify's tags plus the CRM confirmation tag. The CRM is authoritative for "CRM Confirmed by <name>": when the order is confirmed
 * in the CRM, any Shopify-held confirmation tag (for instance the previous confirmer's, until the sync catches up) is replaced by the
 * current one. With no CRM confirmer, Shopify's own tags are shown untouched. Duplicates (any case) are dropped; the confirmation tag leads.
 */
export function mergeOrderTags(shopifyTags: readonly string[], confirmedByName?: string | null, createdByName?: string | null): string[] {
  const crmTag = confirmedByName && confirmedByName.trim() ? confirmationTagFor(confirmedByName) : null;
  // The creator tag ("Order Created by <name>") comes from the creator snapshot stored on the order. It is only ever ADDED to what Shopify holds (never replaces anything) and is never duplicated.
  const creatorTag = createdByName && createdByName.trim() ? creatorTagFor(createdByName) : null;
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (tag: string) => {
    const t = tag.trim();
    if (!t || seen.has(key(t))) return;
    seen.add(key(t));
    out.push(t);
  };
  if (crmTag) push(crmTag);
  if (creatorTag) push(creatorTag);
  for (const tag of shopifyTags) {
    if (crmTag && isConfirmationTag(tag)) continue; // the CRM's confirmer wins over whatever Shopify still holds
    push(tag);
  }
  return out;
}

/** Exact (case-insensitive, whole-tag) match of ANY wanted tag - the OR rule. No wanted tags = no filter. */
export function matchesAnyTag(displayed: readonly string[], wanted: readonly string[]): boolean {
  if (wanted.length === 0) return true;
  const have = new Set(displayed.map(key));
  return wanted.some((t) => have.has(key(t)));
}

/** Shopify search for "tag A OR tag B": `(tag:"A" OR tag:"B")`. A tag is quoted so spaces and punctuation stay part of the one tag. */
export function tagSearchClause(tags: readonly string[]): string | null {
  const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  if (clean.length === 0) return null;
  const escape = (t: string) => t.split("\\").join("\\\\").split('"').join('\\"');
  const q = (t: string) => `tag:"${escape(t)}"`;
  return clean.length === 1 ? q(clean[0]!) : `(${clean.map(q).join(" OR ")})`;
}
