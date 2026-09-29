"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCreateOrderMutation, usePushOrderToShopifyMutation } from "@/lib/api-client/mutations/orders.mutations";
import { lastAddressQueryOptions, pincodeQueryOptions, serviceabilityQueryOptions } from "@/lib/api-client/queries/delivery.queries";
import { productListQueryOptions } from "@/lib/api-client/queries/products.queries";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { formatMoney } from "@/lib/order-status";
import { CreateShipmentDialog } from "@/components/orders/create-shipment-dialog";
import type { CreateManualOrderItemInput, CreateManualOrderResult } from "@/lib/api-client/types/orders.types";
import {
  CreateOrderProgress,
  CustomerBar,
  ItemCard,
  ItemsSection,
  PaymentSection,
  ResultView,
  ServiceabilityLine,
  ShippingSection,
  SummaryCard,
  SummaryRow,
  cents,
  emptyItem,
  fromCents,
  lineTotalCents,
  ORDER_TYPES,
  pincodeUiState,
  placeMatches,
  submitSteps,
  type AddressDraft,
  type DraftItem,
  type OrderType,
  type SummaryData,
} from "./create-order-sections";

interface CreateOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  customerName: string;
  customerMobile: string | null;
}

type Step = "form" | "review" | "done";

export function CreateOrderDialog({ open, onOpenChange, leadId, customerName, customerMobile }: CreateOrderDialogProps) {
  const [step, setStep] = useState<Step>("form");
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);
  const [orderType, setOrderType] = useState<OrderType>("COD");
  const [edits, setEdits] = useState<Partial<AddressDraft>>({});
  const [weight, setWeight] = useState("");
  const [shippingAmount, setShippingAmount] = useState("");
  const [result, setResult] = useState<CreateManualOrderResult | null>(null);
  const [shipmentOpen, setShipmentOpen] = useState(false);

  // One key per order ATTEMPT, reused by every submit of that attempt (so a double click / Enter / retry after a slow
  // response is collapsed into one order by the backend) and replaced only once that attempt has succeeded or the
  // dialog is closed. `submittingRef` closes the window before React re-renders with `isPending`.
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const submittingRef = useRef(false);

  const productsQuery = useQuery({ ...productListQueryOptions({ page: 1, pageSize: 100 }), enabled: open });
  const products = useMemo(() => productsQuery.data?.items ?? [], [productsQuery.data]);

  const lastAddressQuery = useQuery({ ...lastAddressQueryOptions(leadId), enabled: open });
  const last = lastAddressQuery.data ?? null;

  const createOrder = useCreateOrderMutation();
  const pushToShopify = usePushOrderToShopifyMutation();

  // A visual read of typical submit progress while the single create-order request is in flight (the backend answers
  // in one round trip, not a stream) - advances on a timer and holds at the last step until the real response lands.
  const steps = useMemo(() => submitSteps(orderType), [orderType]);
  const [stepIndex, setStepIndex] = useState(0);
  useEffect(() => {
    if (!createOrder.isPending) return;
    const timer = setInterval(() => setStepIndex((i) => Math.min(i + 1, steps.length - 1)), 900);
    return () => clearInterval(timer);
  }, [createOrder.isPending, steps.length]);

  // ---- address: what the salesperson typed wins; otherwise the last order's address; otherwise the pincode's own place.
  const pincode = edits.pincode ?? last?.pincode ?? "";
  const pincodeReady = useDebouncedValue(pincode, 400) === pincode;
  const pincodeComplete = /^[1-9]\d{5}$/.test(pincode);
  const pincodeQuery = useQuery({ ...pincodeQueryOptions(pincode), enabled: open && pincodeComplete && pincodeReady });
  const lookup = pincodeComplete ? pincodeQuery.data : undefined;
  const pincodeState = pincodeUiState(pincode, pincodeReady, lookup, pincodeQuery.isFetching);
  const sameAsLast = Boolean(last && last.pincode === pincode);
  const resolvedCity = lookup?.status === "valid" ? lookup.city : null;
  const resolvedState = lookup?.status === "valid" ? lookup.state : null;

  const address: AddressDraft = {
    name: edits.name ?? last?.name ?? customerName,
    phone: edits.phone ?? last?.phone ?? customerMobile ?? "",
    line1: edits.line1 ?? last?.line1 ?? "",
    line2: edits.line2 ?? last?.line2 ?? "",
    pincode,
    city: edits.city ?? (sameAsLast ? last!.city : (resolvedCity ?? "")),
    state: edits.state ?? (sameAsLast ? last!.state : (resolvedState ?? "")),
  };
  const cityMismatch = lookup?.status === "valid" && (!placeMatches(address.city, resolvedCity) || !placeMatches(address.state, resolvedState));

  // ---- serviceability (COD and prepaid can differ; weight is an estimate typed in by the salesperson).
  const weightKg = Number(weight);
  const weightProvided = Number.isFinite(weightKg) && weightKg > 0;
  const debouncedWeight = useDebouncedValue(weightKg, 400);
  const serviceabilityQuery = useQuery({
    ...serviceabilityQueryOptions(pincode, orderType === "COD", debouncedWeight),
    enabled: open && pincodeState === "valid" && weightProvided && debouncedWeight > 0,
  });
  const serviceability = weightProvided && debouncedWeight === weightKg ? serviceabilityQuery.data : undefined;
  const serviceabilityLoading = serviceabilityQuery.isFetching || debouncedWeight !== weightKg;

  function handleOpenChange(next: boolean) {
    if (!next) {
      if (createOrder.isPending) return; // never abandon an in-flight submit
      setStep("form");
      setItems([emptyItem()]);
      setOrderType("COD");
      setEdits({});
      setWeight("");
      setShippingAmount("");
      setResult(null);
      setShipmentOpen(false);
      setStepIndex(0);
      createOrder.reset();
      idempotencyKey.current = crypto.randomUUID();
    }
    onOpenChange(next);
  }

  function updateItem(key: string, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  function handleProductChange(key: string, productId: string) {
    const product = products.find((p) => p.id === productId);
    const only = product && product.variants.length === 1 ? product.variants[0] : null;
    updateItem(key, { productId, variantId: only?.id ?? "", unitPrice: only?.price ?? product?.basePrice ?? "" });
  }

  function handleVariantChange(key: string, productId: string, variantId: string) {
    const product = products.find((p) => p.id === productId);
    const variant = product?.variants.find((v) => v.id === variantId);
    updateItem(key, { variantId, unitPrice: variant?.price ?? product?.basePrice ?? "" });
  }

  const itemValid = (i: DraftItem) => {
    const product = products.find((p) => p.id === i.productId);
    return Boolean(product) && (product!.variants.length === 0 || Boolean(i.variantId)) && Number(i.quantity) > 0 && Number.isInteger(Number(i.quantity)) && i.unitPrice.trim() !== "";
  };
  const itemsValid = items.length > 0 && items.every(itemValid);

  const validItems: CreateManualOrderItemInput[] = items.filter(itemValid).map((i) => ({
    productId: i.productId,
    variantId: i.variantId || undefined,
    quantity: Number(i.quantity),
    unitPrice: i.unitPrice,
    discountAmount: i.discountAmount || undefined,
  }));

  // Display-only totals (the backend recomputes the authoritative ones). Tax is not charged on manual orders.
  const subtotalCents = validItems.reduce((sum, i) => sum + cents(i.unitPrice) * i.quantity, 0);
  const discountCents = validItems.reduce((sum, i) => sum + cents(i.discountAmount ?? "0"), 0);
  const shippingCents = cents(shippingAmount);
  const totalCents = Math.max(subtotalCents - discountCents + shippingCents, 0);

  const addressComplete = address.line1.trim() !== "" && address.city.trim() !== "" && address.state.trim() !== "" && pincodeComplete;
  const pincodeBlocks = pincodeState === "invalid" || pincodeState === "malformed" || pincodeState === "checking" || pincodeState === "incomplete" || pincodeState === "empty";
  const serviceBlocks = serviceability?.status === "not_serviceable" && serviceability.blocksOrder;
  const canReview = itemsValid && addressComplete && !pincodeBlocks && !serviceBlocks;

  const blockedReason = !itemsValid
    ? "Choose a product (and variant) for every item."
    : !addressComplete
      ? "Fill in the delivery address and a valid 6-digit pincode."
      : pincodeBlocks
        ? pincodeState === "checking"
          ? "Checking the pincode…"
          : "Enter a valid 6-digit Indian pincode."
        : serviceBlocks
          ? "This pincode is not serviceable for delivery."
          : null;

  const summary: SummaryData = {
    customerName,
    customerMobile,
    lines: items
      .filter((i) => i.productId)
      .map((i) => {
        const product = products.find((p) => p.id === i.productId);
        const variant = product?.variants.find((v) => v.id === i.variantId);
        return { key: i.key, name: product?.name ?? "Product", variant: variant?.name ?? null, quantity: Number(i.quantity) || 0, total: fromCents(lineTotalCents(i)) };
      }),
    subtotal: fromCents(subtotalCents),
    discount: fromCents(discountCents),
    shipping: fromCents(shippingCents),
    total: fromCents(totalCents),
    orderType,
    address,
    pincodeState,
    lookup,
    serviceability,
  };

  function submit() {
    // Synchronous guard: two rapid clicks/Enters can both run before `isPending` re-renders.
    if (submittingRef.current || createOrder.isPending) return;
    submittingRef.current = true;
    setStepIndex(0);
    createOrder.mutate(
      {
        leadId,
        items: validItems,
        paymentMethod: orderType,
        shippingAddress: {
          name: address.name || customerName,
          line1: address.line1,
          line2: address.line2 || undefined,
          city: address.city,
          state: address.state,
          pincode: address.pincode,
          phone: address.phone || customerMobile || undefined,
        },
        shippingPincode: address.pincode,
        shippingAmount: shippingAmount || undefined,
        idempotencyKey: idempotencyKey.current,
      },
      {
        onSuccess: (created) => {
          setResult(created);
          setStep("done");
          idempotencyKey.current = crypto.randomUUID();
        },
        // The key is kept on purpose: retrying after a failure is the same attempt (a failed attempt is never cached server-side).
        onError: (error) => toast.error(getErrorMessage(error, "Could not create the order.")),
        onSettled: () => {
          submittingRef.current = false;
        },
      },
    );
  }

  function handleRetryShopify() {
    if (!result) return;
    pushToShopify.mutate(result.order.id, {
      onSuccess: (shopify) => setResult({ ...result, shopify }),
      onError: (error) => toast.error(getErrorMessage(error, "Could not retry the Shopify sync.")),
    });
  }

  const title = step === "done" ? "Order created" : step === "review" ? "Review order" : "Create Order";
  const typeInfo = ORDER_TYPES.find((t) => t.value === orderType)!;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-[min(1080px,calc(100vw-3rem))]">
        <DialogHeader>
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription>Order for the customer in this conversation.</DialogDescription>
        </DialogHeader>

        <CustomerBar name={customerName} mobile={customerMobile} />

        {step === "done" && result ? (
          <ResultView result={result} customerMobile={customerMobile} onRetryShopify={handleRetryShopify} retrying={pushToShopify.isPending} onCreateShipment={() => setShipmentOpen(true)} onDone={() => handleOpenChange(false)} />
        ) : step === "review" ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
            <div className="grid content-start gap-4">
              <p className="text-base font-semibold">
                {orderType === "COD" ? `Create COD order for ${customerName}?` : `Create prepaid order for ${customerName}?`}
              </p>
              <div className="rounded-xl border-[1.5px] border-border bg-card p-4">
                <ul className="grid gap-2 text-sm">
                  {summary.lines.map((l) => (
                    <li key={l.key} className="flex justify-between gap-3">
                      <span className="min-w-0 break-words">
                        {l.name}
                        {l.variant ? ` (${l.variant})` : ""} × {l.quantity}
                      </span>
                      <span className="tabular-nums">{formatMoney(l.total)}</span>
                    </li>
                  ))}
                </ul>
                <dl className="mt-3 grid gap-1.5 border-t pt-3">
                  <SummaryRow label="Subtotal" value={formatMoney(summary.subtotal)} />
                  <SummaryRow label="Discount" value={`−${formatMoney(summary.discount)}`} />
                  <SummaryRow label="Shipping" value={formatMoney(summary.shipping)} />
                  <SummaryRow label="Tax" value={formatMoney("0")} />
                  <SummaryRow label="Final amount" value={formatMoney(summary.total)} strong />
                </dl>
              </div>
              <div className="rounded-xl border-[1.5px] border-border bg-card p-4">
                <dl className="grid gap-1.5">
                  <SummaryRow label="Payment method" value={`${typeInfo.title} · ${typeInfo.subtitle}`} />
                  <SummaryRow label="Payment status" value={orderType === "COD" ? "Pending (collected on delivery)" : "Pending (until the customer pays)"} />
                  <SummaryRow label="Ship to" value={<span className="break-words">{[address.line1, address.line2, address.city, address.state, address.pincode].filter((s) => s.trim()).join(", ")}</span>} />
                </dl>
              </div>
              <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
                {orderType === "COD"
                  ? "The order is confirmed, sent to Shopify, and the customer gets a WhatsApp confirmation."
                  : "A Cashfree payment link will be generated for this order and sent to the customer through WhatsApp."}
              </p>
              {createOrder.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {getErrorMessage(createOrder.error, "Could not create the order.")}
                </p>
              ) : null}
              {createOrder.isPending ? <CreateOrderProgress steps={steps} activeIndex={stepIndex} /> : null}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={() => setStep("form")} disabled={createOrder.isPending}>
                  Back
                </Button>
                <Button type="button" onClick={submit} disabled={createOrder.isPending}>
                  {createOrder.isPending ? "Creating…" : orderType === "COD" ? "Create COD order" : "Create prepaid order"}
                </Button>
              </div>
            </div>
            <SummaryCard data={summary} className="hidden lg:grid lg:self-start" />
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault(); // Enter inside a field must never submit an order
              if (canReview) setStep("review");
            }}
            className="grid gap-4 lg:grid-cols-[1fr_340px]"
          >
            <div className="grid min-w-0 content-start gap-4">
              <ItemsSection onAdd={() => setItems((prev) => [...prev, emptyItem()])}>
                {items.map((item, index) => (
                  <ItemCard
                    key={item.key}
                    item={item}
                    index={index}
                    products={products}
                    productsLoading={productsQuery.isPending}
                    canRemove={items.length > 1}
                    onChange={(patch) => updateItem(item.key, patch)}
                    onProductChange={(id) => handleProductChange(item.key, id)}
                    onVariantChange={(id) => handleVariantChange(item.key, item.productId, id)}
                    onRemove={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
                  />
                ))}
              </ItemsSection>

              <PaymentSection value={orderType} onChange={setOrderType} />

              <ShippingSection
                address={address}
                onChange={(patch) => setEdits((prev) => ({ ...prev, ...patch }))}
                weight={weight}
                onWeightChange={setWeight}
                shippingAmount={shippingAmount}
                onShippingAmountChange={setShippingAmount}
                prefilledFromLastOrder={Boolean(last)}
                pincodeState={pincodeState}
                lookup={lookup}
                cityMismatch={Boolean(cityMismatch)}
                onUseResolved={() => setEdits((prev) => ({ ...prev, city: resolvedCity ?? prev.city, state: resolvedState ?? prev.state }))}
                serviceability={<ServiceabilityLine pincodeState={pincodeState} weightProvided={weightProvided} loading={serviceabilityLoading} result={serviceability} />}
              />
            </div>

            <div className="grid content-start gap-3 lg:sticky lg:top-0 lg:self-start">
              <SummaryCard
                data={summary}
                action={
                  <div className="grid gap-2">
                    {blockedReason ? <p className="text-xs text-muted-foreground">{blockedReason}</p> : null}
                    <Button type="submit" disabled={!canReview} className="w-full">
                      Review order
                    </Button>
                    <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} className="w-full">
                      Cancel
                    </Button>
                  </div>
                }
              />
            </div>
          </form>
        )}
      </DialogContent>

      {result ? <CreateShipmentDialog open={shipmentOpen} onOpenChange={setShipmentOpen} orderId={result.order.id} orderNumber={result.order.orderNumber} currency={result.order.currency} /> : null}
    </Dialog>
  );
}
