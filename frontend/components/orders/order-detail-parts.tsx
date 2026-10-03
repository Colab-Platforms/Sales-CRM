import type { ReactNode } from "react";
import Link from "next/link";
import { MapPin, PackageOpen, Receipt, ShoppingCart } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/order-status";
import type { LiveOrderAddress } from "@/lib/api-client/types/orders.types";
import { CrmBadge, SourceBadge } from "./shopify-status-badge";

// Presentation shared by the CRM Order Detail (order-detail-view.tsx) and the live Shopify Order Detail
// (live-order-detail-view.tsx), so /dashboard/orders/[id] looks the same whichever data source fills it.
// Nothing here fetches or derives data - callers pass already-resolved values (or null -> NOT_AVAILABLE).
//
// Colour language: blue = Shopify/source/info, green = paid/delivered/success, amber = pending/COD/attention,
// red = failed/cancelled, purple = CRM/customer, slate = ordinary metadata.

export const NOT_AVAILABLE = "Not available";

export type Accent = "purple" | "blue" | "green" | "amber" | "slate";

const ACCENT_CLASSES: Record<Accent, string> = {
  purple: "border-l-4 border-l-violet-500/70",
  blue: "border-l-4 border-l-blue-500/70",
  green: "border-l-4 border-l-emerald-500/70",
  amber: "border-l-4 border-l-amber-500/70",
  slate: "border-l-4 border-l-zinc-400/60",
};

const ACCENT_ICON_CLASSES: Record<Accent, string> = {
  purple: "text-violet-600 dark:text-violet-400",
  blue: "text-blue-600 dark:text-blue-400",
  green: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  slate: "text-muted-foreground",
};

/** A Card with a subtle coloured left edge: meaning (customer = purple, payment = amber, ...) without tinting the body. */
export function AccentCard({ accent, className, children }: { accent: Accent; className?: string; children: ReactNode }) {
  return <Card className={cn(ACCENT_CLASSES[accent], className)}>{children}</Card>;
}

export function SectionTitle({ children, aside, icon, accent }: { children: ReactNode; aside?: ReactNode; icon?: ReactNode; accent?: Accent }) {
  return (
    <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
      <CardTitle className="flex items-center gap-2 text-lg [&_svg]:size-[18px]">
        {icon ? <span className={cn("inline-flex", accent ? ACCENT_ICON_CLASSES[accent] : "text-muted-foreground")}>{icon}</span> : null}
        {children}
      </CardTitle>
      {aside}
    </CardHeader>
  );
}

/** A technical identifier (AWB, transaction id, Shopify id): small, muted, monospace. */
export function MonoId({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs break-all text-muted-foreground">{children}</span>;
}

/** An action rendered as a real (outline) button-link rather than plain text. */
export function LinkButton({ href, children, external }: { href: string; children: ReactNode; external?: boolean }) {
  return (
    <Link href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})} className={buttonVariants({ variant: "outline", size: "sm" })}>
      {children}
    </Link>
  );
}

export function EmptyState({ title, message, icon }: { title: string; message: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed bg-muted/30 py-8 text-center">
      {icon ?? <PackageOpen className="size-6 text-muted-foreground" aria-hidden />}
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

export function AddressBlock({ address }: { address: LiveOrderAddress | null }) {
  if (!address) return <p className="text-sm text-muted-foreground">{NOT_AVAILABLE}</p>;
  const lines = [address.name, address.address1, address.address2, [address.city, address.province, address.zip].filter(Boolean).join(", "), address.country].filter(Boolean);
  if (lines.length === 0) return <p className="text-sm text-muted-foreground">{NOT_AVAILABLE}</p>;
  return (
    <div className="text-sm leading-relaxed">
      {lines.map((line, i) => (
        <p key={i} className={i === 0 ? "font-semibold" : undefined}>
          {line}
        </p>
      ))}
      {address.phone ? <p className="mt-1 text-muted-foreground">{address.phone}</p> : null}
    </div>
  );
}

export function sameAddress(a: LiveOrderAddress | null, b: LiveOrderAddress | null): boolean {
  if (!a || !b) return false;
  return a.address1 === b.address1 && a.city === b.city && a.zip === b.zip && a.phone === b.phone;
}

/** The CRM stores the ship-to as a loose key/value bag; pick out the parts the card renders. */
export function addressFromRecord(record: Record<string, string | null> | null | undefined): LiveOrderAddress | null {
  if (!record) return null;
  return {
    name: record.name ?? null,
    address1: record.address1 ?? null,
    address2: record.address2 ?? null,
    city: record.city ?? null,
    province: record.province ?? null,
    zip: record.zip ?? null,
    country: record.country ?? null,
    phone: record.phone ?? null,
  };
}

export function ShippingBillingCard({ shipping, billing, shippingMethod, billingFallback }: { shipping: LiveOrderAddress | null; billing: LiveOrderAddress | null; shippingMethod?: string | null; billingFallback?: string }) {
  const billingDiffers = billing && !sameAddress(shipping, billing);
  return (
    <AccentCard accent="blue">
      <SectionTitle icon={<MapPin />} accent="blue">
        Shipping &amp; Billing
      </SectionTitle>
      <CardContent>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Shipping address</p>
            <AddressBlock address={shipping} />
            {shippingMethod ? <p className="text-xs text-muted-foreground">Method: {shippingMethod}</p> : null}
          </div>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Billing address</p>
            {billingDiffers ? <AddressBlock address={billing} /> : billing ? <p className="text-sm text-muted-foreground">Same as shipping address.</p> : <p className="text-sm text-muted-foreground">{billingFallback ?? NOT_AVAILABLE}</p>}
          </div>
        </div>
      </CardContent>
    </AccentCard>
  );
}

export interface SummaryRow {
  label: string;
  value: string;
  /** Small secondary text after the label, e.g. "(included in prices)". */
  note?: string;
}

export function OrderSummaryCard({ rows, total, totalLabel = "Total" }: { rows: SummaryRow[]; total: string; totalLabel?: string }) {
  return (
    <AccentCard accent="green">
      <SectionTitle icon={<Receipt />} accent="green">
        Order Summary
      </SectionTitle>
      <CardContent>
        <dl className="ml-auto w-full max-w-sm space-y-2 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="flex justify-between gap-4">
              <dt className="text-muted-foreground">
                {row.label}
                {row.note ? <span className="ml-1 text-xs">{row.note}</span> : null}
              </dt>
              <dd className="font-medium tabular-nums">{row.value}</dd>
            </div>
          ))}
          <div className="mt-1 flex items-center justify-between gap-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5">
            <dt className="text-xs font-semibold tracking-wide text-emerald-700 uppercase dark:text-emerald-400">{totalLabel}</dt>
            <dd className="text-xl font-bold tabular-nums">{total}</dd>
          </div>
        </dl>
      </CardContent>
    </AccentCard>
  );
}

export interface ItemRow {
  id: string;
  product: string;
  variant: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: string;
  discount: string;
  tax: string;
  total: string;
}

export function ItemsCard({ rows, taxHeader = "Tax", emptyMessage, footnote }: { rows: ItemRow[]; taxHeader?: string; emptyMessage: string; footnote?: string }) {
  const totalQuantity = rows.reduce((sum, r) => sum + r.quantity, 0);
  return (
    <AccentCard accent="slate">
      <SectionTitle
        icon={<ShoppingCart />}
        aside={
          <p className="text-xs text-muted-foreground">
            {rows.length} line item{rows.length === 1 ? "" : "s"} · {totalQuantity} total quantity
          </p>
        }
      >
        Items
      </SectionTitle>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit price</TableHead>
              <TableHead className="text-right">Discount</TableHead>
              <TableHead className="text-right">{taxHeader}</TableHead>
              <TableHead className="text-right">Line total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-semibold">{r.product}</TableCell>
                  <TableCell className="text-muted-foreground">{r.variant ?? "—"}</TableCell>
                  <TableCell>{r.sku ? <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{r.sku}</span> : "—"}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant="secondary" className="tabular-nums">
                      {r.quantity}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.unitPrice}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.discount}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.tax}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums">{r.total}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {footnote ? <p className="mt-3 text-xs text-muted-foreground">{footnote}</p> : null}
      </CardContent>
    </AccentCard>
  );
}

export type DotTone = "green" | "blue" | "amber" | "red" | "slate";

const DOT_CLASSES: Record<DotTone, string> = {
  green: "border-emerald-500 bg-emerald-500",
  blue: "border-blue-500 bg-blue-500",
  amber: "border-amber-500 bg-amber-500",
  red: "border-rose-500 bg-rose-500",
  slate: "border-zinc-400 bg-background",
};

export function TimelineDot({ dot }: { dot: DotTone }) {
  return <span className={cn("absolute top-1.5 -left-[6px] size-3 rounded-full border-2 ring-4 ring-background", DOT_CLASSES[dot])} aria-hidden />;
}

export function TimelineEvent({ source, title, at, detail, tone = "outline", dot = "green" }: { source: string; title: string; at: string | null; detail?: string | null; tone?: "outline" | "secondary" | "destructive"; dot?: DotTone }) {
  const badge = source === "Shopify" ? <SourceBadge>{source}</SourceBadge> : source === "CRM" ? <CrmBadge>{source}</CrmBadge> : <Badge variant={tone}>{source}</Badge>;
  return (
    <li className="relative pl-6">
      <TimelineDot dot={tone === "destructive" ? "red" : dot} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{title}</span>
        {badge}
      </div>
      {detail ? <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p> : null}
      <p className="mt-0.5 text-xs text-muted-foreground">{at ? formatDateTime(at) : "—"}</p>
    </li>
  );
}

export function TimelineList({ children }: { children: ReactNode }) {
  return <ul className="ml-1.5 space-y-5 border-l">{children}</ul>;
}

export interface Milestone {
  label: string;
  at: string | null;
  state: "done" | "current" | "failed";
}

/** Recorded milestones only (callers pass just the ones that exist): green = completed, blue = current, red = failed. */
export function MilestoneList({ items }: { items: Milestone[] }) {
  const dot: Record<Milestone["state"], DotTone> = { done: "green", current: "blue", failed: "red" };
  return (
    <ul className="ml-1.5 space-y-3 border-l">
      {items.map((m) => (
        <li key={m.label} className="relative pl-6">
          <TimelineDot dot={dot[m.state]} />
          <p className="text-sm font-medium">{m.label}</p>
          <p className="text-xs text-muted-foreground">{m.at ? formatDateTime(m.at) : "—"}</p>
        </li>
      ))}
    </ul>
  );
}

export type StatTone = "success" | "warning" | "danger" | "neutral";

const STAT_CLASSES: Record<StatTone, string> = {
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  danger: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400",
  neutral: "border-border bg-muted/40",
};

/** One figure in the reconciliation mini-dashboard; the tone is chosen by the caller from the real amount/state. */
export function StatTile({ label, value, tone = "neutral" }: { label: string; value: string; tone?: StatTone }) {
  return (
    <div className={cn("rounded-lg border px-3 py-2", STAT_CLASSES[tone])}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}
