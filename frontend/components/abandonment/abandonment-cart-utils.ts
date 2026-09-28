import type { CartSnapshot } from "@/lib/api-client/types/abandonment.types";

export interface ParsedAbandonmentCart {
  cartValue: string | null;
  currency: string;
  itemCount: number | null;
  itemNames: string[];
  stage: string | null;
  checkoutUrl: string | null;
  hasDetails: boolean;
}

export function parseAbandonmentCart(item: {
  summary?: string | null;
  priorityScore?: string | null;
  priorityReason?: string | null;
  cartSnapshot?: CartSnapshot | null;
}): ParsedAbandonmentCart {
  let cartValue = item.cartSnapshot?.cartValue ?? null;
  let currency = item.cartSnapshot?.currency ?? "INR";
  let itemCount = item.cartSnapshot?.itemCount ?? null;
  let itemNames = item.cartSnapshot?.itemNames ? [...item.cartSnapshot.itemNames] : [];
  let stage = item.cartSnapshot?.stage ?? null;
  let checkoutUrl = item.cartSnapshot?.checkoutUrl ?? null;

  if (item.summary && typeof item.summary === "string") {
    const parts = item.summary.split(" · ").map((s) => s.trim()).filter(Boolean);

    for (const part of parts) {
      const stageMatch = part.match(/^stage:\s*(.+)$/i);
      if (stageMatch) {
        if (!stage) stage = stageMatch[1].trim();
        continue;
      }

      const linkMatch = part.match(/^resume link:\s*(https?:\/\/.+)$/i);
      if (linkMatch) {
        if (!checkoutUrl) checkoutUrl = linkMatch[1].trim();
        continue;
      }

      const moneyMatch = part.match(/^([A-Za-z]{3}|₹|Rs\.?)\s*([\d,.]+)/i);
      if (moneyMatch && !cartValue) {
        const rawCurr = moneyMatch[1].toUpperCase();
        currency = rawCurr === "RS" || rawCurr === "RS." ? "INR" : rawCurr;
        cartValue = moneyMatch[2].replace(/,/g, "");
        continue;
      }

      const countMatch = part.match(/^(\d+)\s+items?$/i);
      if (countMatch && itemCount === null) {
        itemCount = parseInt(countMatch[1], 10);
        continue;
      }

      // If it's not the generic fallback "Cart abandoned before payment"
      if (!part.toLowerCase().includes("cart abandoned")) {
        if (itemNames.length === 0) {
          if (itemCount === 1) {
            itemNames.push(part);
          } else {
            const split = part.split(/,\s*(?=[A-Za-z0-9])/).map((s) => s.trim()).filter(Boolean);
            itemNames.push(...split);
          }
        }
      }
    }
  }

  // Fallback for cartValue if priorityScore exists
  if (!cartValue && item.priorityScore) {
    cartValue = item.priorityScore;
  } else if (!cartValue && item.priorityReason) {
    const reasonMatch = item.priorityReason.match(/₹\s*([\d,.]+)/);
    if (reasonMatch) cartValue = reasonMatch[1].replace(/,/g, "");
  }

  if (itemCount === null && itemNames.length > 0) {
    itemCount = itemNames.length;
  }

  const hasDetails = Boolean(cartValue || itemNames.length > 0 || stage || checkoutUrl);

  return {
    cartValue,
    currency,
    itemCount,
    itemNames,
    stage,
    checkoutUrl,
    hasDetails,
  };
}

export function humanizeStage(stage: string): string {
  return stage
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
