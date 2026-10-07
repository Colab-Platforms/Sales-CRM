"use client";

import { Check, Repeat2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePrepaidUpgrade, type UpgradeTarget } from "@/hooks/usePrepaidUpgrade";
import type { PrepaidUpgradeView } from "@/lib/api-client/types/prepaid-upgrade.types";
import { ToneBadge } from "./shopify-status-badge";

export const PREPAID_UPGRADE_ANCHOR = "prepaid-upgrade";

// What the header action area shows for the prepaid-upgrade feature. Pure - decided entirely from the backend's response
// (eligible / isCod / reason / offer), never from a second COD rule in the browser.
export type UpgradeActionState =
  | { kind: "none" }
  | { kind: "open" } // eligible: the "Prepaid Upgrade" button
  | { kind: "track"; label: string; tone: "warning" | "success" | "danger" } // an offer is in flight / done: points at the panel
  | { kind: "unavailable"; reason: string };

export function upgradeActionState(view: PrepaidUpgradeView | null): UpgradeActionState {
  if (!view) return { kind: "none" };
  const offer = view.offer;
  if (offer?.status === "PAYMENT_PENDING") return { kind: "track", label: "Payment pending", tone: "warning" };
  if (offer?.status === "PAYMENT_RECEIVED") return { kind: "track", label: "Payment received - review", tone: "danger" };
  if (offer?.status === "UPGRADED") return { kind: "track", label: "Prepaid upgraded", tone: "success" };
  if (view.eligible) return { kind: "open" }; // no offer, OFFERED (change it / generate a link) or DECLINED (offer again)
  if (view.isCod) return { kind: "unavailable", reason: view.reason ?? "This order can not be upgraded." };
  return { kind: "none" }; // prepaid (or otherwise not COD): the feature is not offered at all
}

export function PrepaidUpgradeActionView({ state, onOpen, onTrack }: { state: UpgradeActionState; onOpen: () => void; onTrack?: () => void }) {
  if (state.kind === "none") return null;
  if (state.kind === "open") {
    return (
      <Button type="button" size="sm" onClick={onOpen}>
        <Repeat2 data-icon="inline-start" />
        Prepaid Upgrade
      </Button>
    );
  }
  if (state.kind === "track") {
    return (
      <Button type="button" size="sm" variant="outline" onClick={onTrack}>
        {state.tone === "success" ? <Check data-icon="inline-start" /> : <Repeat2 data-icon="inline-start" />}
        Prepaid Upgrade · {state.label}
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-col items-end text-right" data-testid="prepaid-upgrade-unavailable">
      <ToneBadge tone="neutral">Prepaid Upgrade unavailable</ToneBadge>
      <span className="mt-1 max-w-[16rem] text-xs text-muted-foreground">Reason: {state.reason}</span>
    </span>
  );
}

/** The single entry point, rendered in Order Detail's header next to Cancel Order. The panel/dialog itself is PrepaidUpgradeCard. */
export function PrepaidUpgradeAction({ target, onOpen }: { target: UpgradeTarget; onOpen: () => void }) {
  const { data } = usePrepaidUpgrade(target);
  const state = upgradeActionState(data);
  return <PrepaidUpgradeActionView state={state} onOpen={onOpen} onTrack={data?.offer?.status === "PAYMENT_PENDING" ? onOpen : () => document.getElementById(PREPAID_UPGRADE_ANCHOR)?.scrollIntoView({ behavior: "smooth", block: "start" })} />;
}
