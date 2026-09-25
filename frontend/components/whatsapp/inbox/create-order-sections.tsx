"use client";

import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Copy, ExternalLink, Loader2, Plus, Store, Trash2, TriangleAlert, User, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ProductCombobox } from "@/components/orders/product-combobox";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/order-status";
import { PROVIDER_LABELS } from "@/lib/whatsapp-template-status";
import type { PincodeLookup, ServiceabilityResult } from "@/lib/api-client/types/delivery.types";
import type { CreateManualOrderResult, PaymentMethod } from "@/lib/api-client/types/orders.types";
import type { ProductListItem } from "@/lib/api-client/types/products.types";

// ---------------------------------------------------------------------------------------------------------------------
// shared helpers

export type OrderType = Extract<PaymentMethod, "COD" | "PAYMENT_LINK">;

export interface DraftItem {
  key: string;
  productId: string;
  variantId: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
}

export interface AddressDraft {
  name: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
}

export const emptyItem = (): DraftItem => ({ key: crypto.randomUUID(), productId: "", variantId: "", quantity: "1", unitPrice: "", discountAmount: "" });

export const cents = (value: string): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
export const fromCents = (c: number): string => (c / 100).toFixed(2);

export const lineTotalCents = (i: Pick<DraftItem, "unitPrice" | "quantity" | "discountAmount">) => Math.max(cents(i.unitPrice) * (Number(i.quantity) || 0) - cents(i.discountAmount || "0"), 0);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** True when what was typed and what the pincode resolves to plausibly name the same place (either contains the other). */
export const placeMatches = (entered: string, resolved: string | null): boolean => {
  if (!resolved || !entered.trim()) return true;
  const a = norm(entered);
  const b = norm(resolved);
  return a === b || a.includes(b) || b.includes(a);
};

export const ORDER_TYPES: { value: OrderType; title: string; subtitle: string; description: string; icon: typeof Wallet }[] = [
  { value: "COD", title: "COD", subtitle: "Cash on Delivery", description: "Customer pays when the order is delivered.", icon: Store },
  { value: "PAYMENT_LINK", title: "PREPAID", subtitle: "Payment link", description: "Generate a Cashfree payment link and send it to the customer on WhatsApp.", icon: Wallet },
];

export function SectionCard({ title, description, children, className }: { title: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border-[1.5px] border-border bg-card p-4 sm:p-5", className)}>
      <div className="mb-3">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, htmlFor, hint, children, className }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs">
        {label}
      </Label>
      {children}
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function CustomerBar({ name, mobile }: { name: string; mobile: string | null }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border-[1.5px] border-border bg-muted/40 px-4 py-3" aria-label="Customer for this order">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <User className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate font-semibold">{name}</p>
        <p className="truncate text-sm text-muted-foreground">{mobile ?? "No phone number on file"}</p>
      </div>
      <span className="ml-auto hidden rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground sm:inline">Customer is fixed to this conversation</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// items

export function ItemCard({
  item,
  index,
  products,
  productsLoading,
  canRemove,
  onChange,
  onProductChange,
  onVariantChange,
  onRemove,
}: {
  item: DraftItem;
  index: number;
  products: ProductListItem[];
  productsLoading: boolean;
  canRemove: boolean;
  onChange: (patch: Partial<DraftItem>) => void;
  onProductChange: (productId: string) => void;
  onVariantChange: (variantId: string) => void;
  onRemove: () => void;
}) {
  const product = products.find((p) => p.id === item.productId);
  const variant = product?.variants.find((v) => v.id === item.variantId);
  const needsVariant = Boolean(product && product.variants.length > 0);
  const sku = variant?.sku ?? product?.sku ?? null;
  const line = fromCents(lineTotalCents(item));

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-background/50 p-3 sm:p-4" data-testid="order-item">
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">Item {index + 1}</span>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onRemove} disabled={!canRemove} aria-label={`Remove item ${index + 1}`}>
          <Trash2 />
        </Button>
      </div>

      <Field label="Product" htmlFor={`product-${item.key}`}>
        <ProductCombobox id={`product-${item.key}`} products={products} value={item.productId} onChange={onProductChange} loading={productsLoading} />
      </Field>

      {product ? (
        <div className="rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="selected-product">
          <p className="font-medium break-words">{product.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {variant ? `Variant: ${variant.name} · ` : ""}
            SKU {sku ?? "—"}
            {variant?.price ?? product.basePrice ? ` · ${formatMoney((variant?.price ?? product.basePrice)!)}` : ""}
          </p>
        </div>
      ) : null}

      {needsVariant ? (
        <Field label="Variant" htmlFor={`variant-${item.key}`} hint={item.variantId ? undefined : "Choose the variant being sold."}>
          <NativeSelect id={`variant-${item.key}`} value={item.variantId} onChange={(e) => onVariantChange(e.target.value)}>
            <option value="">Select a variant</option>
            {product!.variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.price ? ` — ${formatMoney(v.price)}` : ""}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Quantity" htmlFor={`qty-${item.key}`}>
          <Input id={`qty-${item.key}`} type="number" min="1" inputMode="numeric" value={item.quantity} onChange={(e) => onChange({ quantity: e.target.value })} />
        </Field>
        <Field label="Unit price (₹)" htmlFor={`price-${item.key}`}>
          <Input id={`price-${item.key}`} inputMode="decimal" value={item.unitPrice} onChange={(e) => onChange({ unitPrice: e.target.value })} placeholder="0.00" />
        </Field>
        <Field label="Discount (₹)" htmlFor={`disc-${item.key}`}>
          <Input id={`disc-${item.key}`} inputMode="decimal" value={item.discountAmount} onChange={(e) => onChange({ discountAmount: e.target.value })} placeholder="0" />
        </Field>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium">Line total</span>
          <div className="flex h-9 items-center rounded-md bg-muted/50 px-3 text-sm font-semibold tabular-nums" data-testid="line-total">
            {formatMoney(line)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ItemsSection({ children, onAdd }: { children: ReactNode; onAdd: () => void }) {
  return (
    <SectionCard title="Order items" description="Search a product, choose its variant and quantity.">
      <div className="grid gap-3">
        {children}
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onAdd}>
          <Plus data-icon="inline-start" />
          Add another product
        </Button>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// payment

export function PaymentSection({ value, onChange }: { value: OrderType; onChange: (v: OrderType) => void }) {
  return (
    <SectionCard title="Payment">
      <div role="radiogroup" aria-label="Payment type" className="grid gap-3 sm:grid-cols-2">
        {ORDER_TYPES.map((t) => {
          const selected = value === t.value;
          const Icon = t.icon;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(t.value)}
              className={cn(
                "relative rounded-xl border-[1.5px] p-4 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-muted/50",
              )}
            >
              <span className="flex items-center gap-2">
                <Icon className={cn("size-4", selected ? "text-primary" : "text-muted-foreground")} />
                <span className="text-xs font-semibold tracking-wide">{t.title}</span>
                {selected ? <CircleCheck className="ml-auto size-4 text-primary" /> : null}
              </span>
              <span className="mt-1.5 block text-sm font-medium">{t.subtitle}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t.description}</span>
            </button>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// shipping address + checks

export type PincodeUiState = "empty" | "incomplete" | "malformed" | "checking" | "valid" | "invalid" | "unavailable";

export function pincodeUiState(pincode: string, ready: boolean, lookup: PincodeLookup | undefined, fetching: boolean): PincodeUiState {
  if (!pincode) return "empty";
  if (pincode.length < 6) return "incomplete";
  if (!/^[1-9]\d{5}$/.test(pincode)) return "malformed";
  if (!ready || fetching || !lookup) return "checking";
  return lookup.status;
}

function StatusLine({ tone, children }: { tone: "ok" | "bad" | "warn" | "busy" | "muted"; children: ReactNode }) {
  const icon =
    tone === "ok" ? <CircleCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" /> : tone === "bad" ? <CircleAlert className="size-3.5 shrink-0 text-destructive" /> : tone === "warn" ? <TriangleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" /> : tone === "busy" ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null;
  return (
    <p className={cn("flex items-start gap-1.5 text-xs", tone === "ok" && "text-emerald-700 dark:text-emerald-400", tone === "bad" && "text-destructive", tone === "warn" && "text-amber-700 dark:text-amber-400", (tone === "muted" || tone === "busy") && "text-muted-foreground")}>
      {icon}
      <span>{children}</span>
    </p>
  );
}

export function PincodeStatusLines({
  state,
  lookup,
  cityMismatch,
  onUseResolved,
}: {
  state: PincodeUiState;
  lookup: PincodeLookup | undefined;
  cityMismatch: boolean;
  onUseResolved: () => void;
}) {
  return (
    <div className="grid gap-1" aria-live="polite" data-testid="pincode-status">
      {state === "incomplete" ? <StatusLine tone="muted">Enter all 6 digits.</StatusLine> : null}
      {state === "malformed" ? <StatusLine tone="bad">Invalid pincode — Please enter a valid 6-digit Indian pincode.</StatusLine> : null}
      {state === "checking" ? <StatusLine tone="busy">Checking pincode…</StatusLine> : null}
      {state === "invalid" ? <StatusLine tone="bad">Invalid pincode — Please enter a valid 6-digit Indian pincode.</StatusLine> : null}
      {state === "unavailable" ? <StatusLine tone="warn">{lookup?.message ?? "Could not check this pincode right now."}</StatusLine> : null}
      {state === "valid" && lookup ? (
        <>
          <StatusLine tone="ok">
            Valid pincode — {[lookup.city, lookup.state].filter(Boolean).join(", ")}
          </StatusLine>
          {cityMismatch ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-amber-700 dark:text-amber-400" role="alert">
              <TriangleAlert className="size-3.5 shrink-0" />
              <span>
                Pincode belongs to {[lookup.city, lookup.state].filter(Boolean).join(", ")}. Please verify the entered city/state.
              </span>
              <button type="button" onClick={onUseResolved} className="font-medium underline underline-offset-2">
                Use {lookup.city}, {lookup.state}
              </button>
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function ServiceabilityLine({
  pincodeState,
  weightProvided,
  loading,
  result,
}: {
  pincodeState: PincodeUiState;
  weightProvided: boolean;
  loading: boolean;
  result: ServiceabilityResult | undefined;
}) {
  if (pincodeState !== "valid") return null;
  if (!weightProvided) return <StatusLine tone="muted">Courier serviceability requires shipment weight — enter the parcel weight below.</StatusLine>;
  if (loading || !result) return <StatusLine tone="busy">Checking delivery…</StatusLine>;
  if (result.status === "serviceable") {
    const eta = result.minDays !== null ? ` · ${result.minDays === result.maxDays || result.maxDays === null ? `${result.minDays}` : `${result.minDays}–${result.maxDays}`} days` : "";
    const rate = result.cheapestRate !== null ? ` · from ${formatMoney(String(result.cheapestRate))}` : "";
    return (
      <div data-testid="serviceability">
        <StatusLine tone="ok">
          Delivery serviceable — {result.couriers} courier{result.couriers === 1 ? "" : "s"} available{eta}
          {rate}
        </StatusLine>
      </div>
    );
  }
  if (result.status === "not_serviceable") {
    return (
      <div data-testid="serviceability">
        <StatusLine tone={result.blocksOrder ? "bad" : "warn"}>
          {result.message ?? "This pincode is currently not serviceable for delivery."}
          {result.blocksOrder ? "" : " The order can still be created."}
        </StatusLine>
      </div>
    );
  }
  return (
    <div data-testid="serviceability">
      <StatusLine tone="warn">{result.message ?? "Could not check delivery right now."} You can still continue.</StatusLine>
    </div>
  );
}

export function ShippingSection({
  address,
  onChange,
  weight,
  onWeightChange,
  shippingAmount,
  onShippingAmountChange,
  prefilledFromLastOrder,
  pincodeState,
  lookup,
  cityMismatch,
  onUseResolved,
  serviceability,
}: {
  address: AddressDraft;
  onChange: (patch: Partial<AddressDraft>) => void;
  weight: string;
  onWeightChange: (v: string) => void;
  shippingAmount: string;
  onShippingAmountChange: (v: string) => void;
  prefilledFromLastOrder: boolean;
  pincodeState: PincodeUiState;
  lookup: PincodeLookup | undefined;
  cityMismatch: boolean;
  onUseResolved: () => void;
  serviceability: ReactNode;
}) {
  return (
    <SectionCard title="Shipping address" description={prefilledFromLastOrder ? "Prefilled from this customer's last order. Editing it here changes this order only — the customer record is not touched." : "Where this order will be delivered."}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" htmlFor="ship-name">
          <Input id="ship-name" autoComplete="off" value={address.name} onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        <Field label="Mobile number" htmlFor="ship-phone">
          <Input id="ship-phone" inputMode="tel" autoComplete="off" value={address.phone} onChange={(e) => onChange({ phone: e.target.value })} />
        </Field>
        <Field label="Address line 1" htmlFor="ship-line1" className="sm:col-span-2" hint={address.line1.trim() ? <StatusLine tone="ok">Address entered</StatusLine> : undefined}>
          <Input id="ship-line1" autoComplete="off" placeholder="Flat / house no., building, street" value={address.line1} onChange={(e) => onChange({ line1: e.target.value })} />
        </Field>
        <Field label="Address line 2 / Landmark" htmlFor="ship-line2" className="sm:col-span-2">
          <Input id="ship-line2" autoComplete="off" placeholder="Area, landmark (optional)" value={address.line2} onChange={(e) => onChange({ line2: e.target.value })} />
        </Field>
        <Field label="Pincode" htmlFor="ship-pincode" className="sm:col-span-2" hint={<PincodeStatusLines state={pincodeState} lookup={lookup} cityMismatch={cityMismatch} onUseResolved={onUseResolved} />}>
          <Input
            id="ship-pincode"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            placeholder="6-digit pincode"
            value={address.pincode}
            onChange={(e) => onChange({ pincode: e.target.value.replace(/\D/g, "").slice(0, 6) })}
            aria-invalid={pincodeState === "invalid" || pincodeState === "malformed"}
            className="max-w-[12rem]"
          />
        </Field>
        <Field label="City" htmlFor="ship-city">
          <Input id="ship-city" autoComplete="off" value={address.city} onChange={(e) => onChange({ city: e.target.value })} />
        </Field>
        <Field label="State" htmlFor="ship-state">
          <Input id="ship-state" autoComplete="off" value={address.state} onChange={(e) => onChange({ state: e.target.value })} />
        </Field>
        <Field label="Parcel weight (kg)" htmlFor="ship-weight" hint="Estimated — used only to check courier availability.">
          <Input id="ship-weight" inputMode="decimal" placeholder="e.g. 0.5" value={weight} onChange={(e) => onWeightChange(e.target.value)} />
        </Field>
        <Field label="Shipping charge (₹)" htmlFor="ship-amount">
          <Input id="ship-amount" inputMode="decimal" placeholder="0" value={shippingAmount} onChange={(e) => onShippingAmountChange(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">{serviceability}</div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// summary + review

export function SummaryRow({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-4 text-sm", strong && "border-t pt-2 text-base font-semibold")}>
      <dt className={strong ? undefined : "text-muted-foreground"}>{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}

export interface SummaryData {
  customerName: string;
  customerMobile: string | null;
  lines: { key: string; name: string; variant: string | null; quantity: number; total: string }[];
  subtotal: string;
  discount: string;
  shipping: string;
  total: string;
  orderType: OrderType;
  address: AddressDraft;
  pincodeState: PincodeUiState;
  lookup: PincodeLookup | undefined;
  serviceability: ServiceabilityResult | undefined;
}

export function SummaryCard({ data, action, className }: { data: SummaryData; action?: ReactNode; className?: string }) {
  const type = ORDER_TYPES.find((t) => t.value === data.orderType)!;
  const hasAddress = Boolean(data.address.line1.trim() || data.address.city.trim() || data.address.pincode);
  return (
    <aside className={cn("grid gap-4 rounded-xl border-[1.5px] border-border bg-card p-4 sm:p-5", className)} aria-label="Order summary" data-testid="order-summary">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Order summary</h3>

      <div>
        <p className="text-xs text-muted-foreground">Customer</p>
        <p className="font-medium">{data.customerName}</p>
        <p className="text-sm text-muted-foreground">{data.customerMobile ?? "—"}</p>
      </div>

      <div>
        <p className="mb-1 text-xs text-muted-foreground">Items</p>
        {data.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No items yet.</p>
        ) : (
          <ul className="grid gap-2">
            {data.lines.map((l) => (
              <li key={l.key} className="flex justify-between gap-3 text-sm">
                <span className="min-w-0 break-words">
                  {l.name}
                  <span className="block text-xs text-muted-foreground">
                    {l.variant ? `${l.variant} × ${l.quantity}` : `Qty ${l.quantity}`}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{formatMoney(l.total)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <dl className="grid gap-1.5 border-t pt-3">
        <SummaryRow label="Subtotal" value={formatMoney(data.subtotal)} />
        <SummaryRow label="Discount" value={`−${formatMoney(data.discount)}`} />
        <SummaryRow label="Shipping" value={formatMoney(data.shipping)} />
        <SummaryRow label="Tax" value={formatMoney("0")} />
        <SummaryRow label="Total" value={formatMoney(data.total)} strong />
      </dl>

      <div>
        <p className="text-xs text-muted-foreground">Payment</p>
        <p className="text-sm font-medium">{data.orderType === "COD" ? "COD · Cash on Delivery" : `Prepaid · ${type.subtitle} (Cashfree)`}</p>
      </div>

      <div>
        <p className="text-xs text-muted-foreground">Shipping to</p>
        {hasAddress ? (
          <p className="text-sm break-words">
            {[data.address.line1, data.address.line2].filter((s) => s.trim()).join(", ") || "—"}
            <br />
            {[data.address.city, data.address.state].filter((s) => s.trim()).join(", ")}
            {data.address.pincode ? ` - ${data.address.pincode}` : ""}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Not entered yet.</p>
        )}
        <div className="mt-1.5 grid gap-1">
          {data.pincodeState === "valid" ? <StatusLine tone="ok">Pincode verified</StatusLine> : null}
          {data.pincodeState === "unavailable" ? <StatusLine tone="warn">Pincode not verified (directory unavailable)</StatusLine> : null}
          {data.serviceability?.status === "serviceable" ? <StatusLine tone="ok">Delivery serviceable</StatusLine> : null}
          {data.serviceability?.status === "not_serviceable" ? <StatusLine tone={data.serviceability.blocksOrder ? "bad" : "warn"}>Not serviceable</StatusLine> : null}
        </div>
      </div>

      {action}
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// result

type StepState = "ok" | "warn" | "fail" | "info";

function ResultRow({ label, state, children }: { label: string; state: StepState; children?: ReactNode }) {
  const icon =
    state === "ok" ? <CircleCheck className="size-5 text-emerald-600 dark:text-emerald-400" /> : state === "warn" ? <TriangleAlert className="size-5 text-amber-600 dark:text-amber-400" /> : state === "fail" ? <CircleAlert className="size-5 text-destructive" /> : <span className="size-5 rounded-full border" />;
  return (
    <div className="flex gap-3 rounded-lg border border-border bg-background/50 p-3">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{label}</p>
        <div className="mt-0.5 text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

// Known failures become a plain sentence; the raw provider text stays in the server logs (and is never shown here).
export function friendlyShopify(): string {
  return "Shopify couldn't accept the order right now. Your CRM order is safe — use Retry to send it again.";
}

export function friendlyCashfree(reason: string | undefined): string {
  const r = reason ?? "";
  if (/not enabled|CASHFREE_ENABLED|not configured|misconfigured/i.test(r)) return "Online payment links aren't switched on yet. Ask an admin to enable Cashfree, then use “Retry Cashfree payment link” on the order page.";
  if (/10-digit mobile/i.test(r)) return "This customer's phone number can't be used for a payment link. Fix the number, then retry from the order page.";
  if (/could not be reached|unexpected answer|try again/i.test(r)) return "Cashfree couldn't be reached. Nothing was charged — retry from the order page in a moment.";
  return "The payment link couldn't be created. Nothing was charged — use “Retry Cashfree payment link” on the order page.";
}

export function friendlyWhatsApp(reason: string | undefined): string {
  const r = reason ?? "";
  if (!r) return "The message couldn't be sent.";
  if (/HTTP \d{3}|BLOCKED|ECONN|fetch|prisma|invalid .* invocation|undefined|stack/i.test(r)) return "WhatsApp couldn't deliver the message right now. You can send it again from the order page.";
  return r;
}

export function ResultView({
  result,
  customerMobile,
  onRetryShopify,
  retrying,
  onCreateShipment,
  onDone,
}: {
  result: CreateManualOrderResult;
  customerMobile: string | null;
  onRetryShopify: () => void;
  retrying: boolean;
  onCreateShipment: () => void;
  onDone: () => void;
}) {
  const { order, shopify, paymentLink, whatsapp } = result;
  const isCod = order.paymentMode === "COD";
  const providerLabel = whatsapp.provider ? (PROVIDER_LABELS[whatsapp.provider] ?? whatsapp.provider) : null;
  const what = isCod ? "Order confirmation" : "Payment link";

  async function copy() {
    if (!paymentLink?.paymentUrl) return;
    try {
      await navigator.clipboard.writeText(paymentLink.paymentUrl);
      toast.success("Payment link copied.");
    } catch {
      toast.error("Could not copy the link.");
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
        <CircleCheck className="size-5" />
        <p className="font-semibold">Order created successfully</p>
      </div>

      <div className="grid gap-2">
        <ResultRow label="CRM order" state="ok">
          <span className="font-medium text-foreground">{order.orderNumber}</span> · {formatMoney(order.totalAmount, order.currency)} · {isCod ? "Cash on Delivery" : "Prepaid"}
          <ul className="mt-1 text-xs">
            {order.items.map((i) => (
              <li key={i.id}>
                {i.productName}
                {i.variantName ? ` (${i.variantName})` : ""} × {i.quantity}
              </li>
            ))}
          </ul>
        </ResultRow>

        <ResultRow label="Shopify" state={shopify.status === "failed" ? "fail" : "ok"}>
          {shopify.status === "failed" ? (
            <span className="grid gap-2">
              <span>{friendlyShopify()}</span>
              <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onRetryShopify} disabled={retrying}>
                {retrying ? "Retrying…" : "Retry Shopify sync"}
              </Button>
            </span>
          ) : (
            <>Created{shopify.shopifyOrderName ? ` · ${shopify.shopifyOrderName}` : ""}</>
          )}
        </ResultRow>

        {paymentLink ? (
          <ResultRow label="Cashfree payment link" state={paymentLink.status === "failed" ? "warn" : "ok"}>
            {paymentLink.status === "failed" ? (
              friendlyCashfree(paymentLink.reason)
            ) : (
              <span className="grid gap-2">
                <span>
                  {paymentLink.status === "reused" ? "An existing open link was reused" : "Created"} · {formatMoney(order.totalAmount, order.currency)}
                </span>
                {paymentLink.paymentUrl ? (
                  <span className="flex flex-wrap gap-2">
                    <a href={paymentLink.paymentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted">
                      <ExternalLink className="size-3.5" />
                      Open payment link
                    </a>
                    <Button type="button" variant="outline" size="sm" onClick={copy}>
                      <Copy data-icon="inline-start" />
                      Copy link
                    </Button>
                  </span>
                ) : null}
              </span>
            )}
          </ResultRow>
        ) : null}

        <ResultRow label="WhatsApp" state={whatsapp.sent ? "ok" : paymentLink || isCod ? "warn" : "info"}>
          {whatsapp.sent
            ? `${what} sent to ${customerMobile ?? "the customer"}${providerLabel ? ` via ${providerLabel}` : ""}`
            : `${what} not sent — ${friendlyWhatsApp(whatsapp.reason)}`}
        </ResultRow>

        <ResultRow label="Shiprocket" state="info">
          Not yet attempted
          <span className="mt-2 block">
            <Button type="button" variant="outline" size="sm" onClick={onCreateShipment}>
              Create Shiprocket shipment
            </Button>
          </span>
        </ResultRow>
      </div>

      <div className="flex justify-end">
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
