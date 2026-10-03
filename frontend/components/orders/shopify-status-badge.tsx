import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Presentation-only colouring of Shopify's own free-text status strings (financial / fulfilment /
// return / transaction). Same colour tokens the CRM's PaymentStatusBadge/OrderStatusBadge use, but the
// CRM enums don't apply to a live Shopify order, so this maps by keyword and never drives any logic.
const TONES = {
  success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  info: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  danger: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  refund: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
  partial: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  neutral: "bg-zinc-500/10 text-zinc-500 dark:text-zinc-400",
  purple: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
} as const;

export type Tone = keyof typeof TONES;

export function shopifyStatusTone(status: string | null): Tone {
  if (!status) return "neutral";
  const s = status.toUpperCase();
  if (s.includes("PARTIALLY_REFUNDED")) return "partial";
  if (s.includes("REFUND")) return "refund";
  if (["CANCEL", "VOID", "FAIL", "EXPIRE", "ERROR", "DECLINE"].some((k) => s.includes(k))) return "danger";
  if (s.includes("UNFULFILLED") || s.includes("PENDING") || s.includes("AUTHORIZED") || s.includes("ON_HOLD")) return "warning";
  if (s.includes("PARTIAL")) return "partial";
  if (["PAID", "FULFILLED", "DELIVERED", "SUCCESS"].some((k) => s.includes(k))) return "success";
  if (["IN_TRANSIT", "SHIPPED", "OUT_FOR", "PICKED", "OPEN", "IN_PROGRESS"].some((k) => s.includes(k))) return "info";
  return "neutral";
}

export function titleCaseStatus(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function ShopifyStatusBadge({ status, label }: { status: string | null; label?: string }) {
  return (
    <Badge variant="outline" className={cn("border-current/20", TONES[shopifyStatusTone(status)])}>
      {label ?? (status ? titleCaseStatus(status) : "Unknown")}
    </Badge>
  );
}

/** Generic tinted pill for categorical values (source, mode, sync state) - same tones as the status badges. */
export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-current/20", TONES[tone], className)}>
      {children}
    </Badge>
  );
}

/** Order/lead source (Shopify, Website...): blue = source/information. */
export function SourceBadge({ children }: { children: React.ReactNode }) {
  return <ToneBadge tone="info">{children}</ToneBadge>;
}

/** CRM-side state: purple = CRM/customer. */
export function CrmBadge({ children }: { children: React.ReactNode }) {
  return <ToneBadge tone="purple">{children}</ToneBadge>;
}

/** COD = amber (cash still to be collected), anything else = blue. */
export function PaymentModeBadge({ mode, label }: { mode: string; label: string }) {
  return <ToneBadge tone={mode === "COD" ? "warning" : "info"}>{label}</ToneBadge>;
}
