"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCreateOrderMutation, usePushOrderToShopifyMutation } from "@/lib/api-client/mutations/orders.mutations";
import { lastAddressQueryOptions, pincodeQueryOptions } from "@/lib/api-client/queries/delivery.queries";
import { productsApi } from "@/lib/api-client/endpoints/products.api";
import { productListQueryOptions } from "@/lib/api-client/queries/products.queries";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useCourierRates } from "@/hooks/useCourierRates";
import { chargeText, shippingChargeState } from "@/lib/shipping-charge";
import { formatMoney } from "@/lib/order-status";
import { composeLines, formatAddress, structuredFromSaved, validateAddress } from "./create-order-address";
import { DiscountPricing } from "./discount-section";
import { useDiscountOptions } from "@/hooks/useDiscountOptions";
import { choiceCents, defaultChoice, toApiDiscount, type DiscountChoice } from "@/lib/discount";
import {
  dimensionsHint,
  goodsValue,
  isDimensionDraftEmpty,
  parseParcelDimensions,
  productDimensionsNote,
  rateInputsOrMissing,
  resolvePackedDimensions,
  suggestPackedDimensions,
  type DimensionDraft,
} from "@/lib/package-dimensions";
import { estimateProductWeight, formatKg, parseParcelWeight, resolveParcelWeight, unitWeightKg, weightHint } from "@/lib/parcel-weight";
import { WhatsAppPaymentSection } from "./whatsapp-payment-section";
import { NO_WHATSAPP, toApiWhatsApp, whatsappBlockReason, type WhatsAppPaymentChoice } from "@/lib/whatsapp-payment";
import { whatsAppPaymentOptionsQueryOptions } from "@/lib/api-client/queries/orders.queries";
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
  /** Test seams: render the same content inline (no portal) from a given order type / step. Not used by the app. */
  inline?: boolean;
  initialOrderType?: OrderType;
  initialStep?: "form" | "review";
  initialSendViaWhatsApp?: boolean;
  initialWeight?: string;
  initialItems?: Partial<DraftItem>[];
  initialDimensions?: DimensionDraft;
}

type Step = "form" | "review" | "done";

export function CreateOrderDialog({ open, onOpenChange, leadId, customerName, customerMobile, inline, initialOrderType, initialStep, initialSendViaWhatsApp, initialWeight, initialItems, initialDimensions }: CreateOrderDialogProps) {
  const [step, setStep] = useState<Step>(initialStep ?? "form");
  const [items, setItems] = useState<DraftItem[]>(initialItems ? initialItems.map((i) => ({ ...emptyItem(), ...i })) : [emptyItem()]);
  const [orderType, setOrderType] = useState<OrderType>(initialOrderType ?? "COD");
  const [edits, setEdits] = useState<Partial<AddressDraft>>({});
  // The parcel weight the operator TYPED (null = never touched, so the product-weight suggestion applies). A typed value is never overwritten.
  const [manualWeight, setManualWeight] = useState<string | null>(initialWeight ?? null);
  // The packed parcel dimensions the operator TYPED (null = never touched, so the safe single-unit suggestion applies). Never overwritten.
  const [manualDims, setManualDims] = useState<DimensionDraft | null>(initialDimensions ?? null);
  // Only used when Shiprocket has no rate to offer (unavailable / not requested): then the charge can be typed. Never used while a rate exists.
  const [manualShipping, setManualShipping] = useState("");
  // The courier the operator picked, valid only for the rate request it was picked from.
  const [courierPick, setCourierPick] = useState<{ rateKey: string; courier: string } | null>(null);
  const [result, setResult] = useState<CreateManualOrderResult | null>(null);
  const [shipmentOpen, setShipmentOpen] = useState(false);
  // Prepaid only: "Don't send" (default) or send the Cashfree link on WhatsApp with an approved template + the customer's consent.
  const [whatsapp, setWhatsapp] = useState<WhatsAppPaymentChoice>(initialSendViaWhatsApp ? { ...NO_WHATSAPP, send: true } : NO_WHATSAPP);

  // One key per order ATTEMPT, reused by every submit of that attempt (so a double click / Enter / retry after a slow
  // response is collapsed into one order by the backend) and replaced only once that attempt has succeeded or the
  // dialog is closed. `submittingRef` closes the window before React re-renders with `isPending`.
  // The discount CHOICE (coupon / custom / none). It starts as the configured default coupon (data-driven, from the server) and
  // is replaced - never added to - when the user edits it. `null` = the user has not touched it yet.
  const [discountEdit, setDiscountEdit] = useState<DiscountChoice | null>(null);
  const { options: discountOptions, loaded: discountsLoaded } = useDiscountOptions("ORDER", open);
  const discountChoice: DiscountChoice = discountEdit ?? defaultChoice(discountOptions);
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const submittingRef = useRef(false);

  // The catalogue is read fresh every time the creator opens (never a cached copy) and again whenever a product/variant is chosen. ALL pages are read, so a product is
  // never missing just because it sorts after the first 100.
  const productsQuery = useQuery({
    ...productListQueryOptions({ page: 1, pageSize: 100 }),
    queryFn: async () => {
      const first = await productsApi.list({ page: 1, pageSize: 100 });
      const items = [...first.items];
      for (let page = 2; page <= Math.min(first.pagination.totalPages, 20); page++) items.push(...(await productsApi.list({ page, pageSize: 100 })).items);
      return { items, pagination: first.pagination };
    },
    enabled: open,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const products = useMemo(() => productsQuery.data?.items ?? [], [productsQuery.data]);

  const lastAddressQuery = useQuery({ ...lastAddressQueryOptions(leadId), enabled: open });
  const last = lastAddressQuery.data ?? null;

  const waOptionsQuery = useQuery({ ...whatsAppPaymentOptionsQueryOptions(leadId), enabled: open && orderType !== "COD" });
  const waOptions = waOptionsQuery.data ?? null;
  const sendingWhatsApp = orderType !== "COD" && whatsapp.send;
  const whatsappBlocked = sendingWhatsApp ? whatsappBlockReason(waOptions, waOptionsQuery.isPending, whatsapp) : null;

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

  const saved = structuredFromSaved(last);
  const address: AddressDraft = {
    name: edits.name ?? last?.name ?? customerName,
    phone: edits.phone ?? last?.phone ?? customerMobile ?? "",
    // Structured fields: what was typed wins, then the previous order's address (a legacy free-text one is carried over
    // line1 -> House/Flat, line2 -> Area, still editable), otherwise empty. Nothing the user typed is ever overwritten.
    houseNumber: edits.houseNumber ?? saved.houseNumber,
    building: edits.building ?? saved.building,
    area: edits.area ?? saved.area,
    street: edits.street ?? saved.street,
    landmark: edits.landmark ?? saved.landmark,
    addressType: edits.addressType ?? saved.addressType,
    pincode,
    city: edits.city ?? (sameAsLast ? last!.city : (resolvedCity ?? "")),
    state: edits.state ?? (sameAsLast ? last!.state : (resolvedState ?? "")),
  };
  const cityMismatch = lookup?.status === "valid" && (!placeMatches(address.city, resolvedCity) || !placeMatches(address.state, resolvedState));

  // ---- serviceability (COD and prepaid can differ; weight is an estimate typed in by the salesperson).
  // The parcel weight is typed by the telecaller; 0, negative or non-numeric input is rejected and never replaced by a default.
  const weightLines = items
    .filter((i) => i.productId)
    .map((i) => {
      const p = products.find((x) => x.id === i.productId);
      const v = p?.variants.find((x) => x.id === i.variantId);
      return { unitKg: unitWeightKg(p, v), quantity: Number(i.quantity), label: p ? (v ? `${p.name} — ${v.name}` : p.name) : "" };
    });
  const estimate = estimateProductWeight(weightLines);
  // Items whose catalogue has no valid weight are named, so a missing weight is visible per item instead of just leaving the field empty. Their price is unaffected.
  const missingWeightLabels = weightLines.filter((l) => l.unitKg === null && l.label).map((l) => l.label);
  const resolved = resolveParcelWeight(manualWeight, estimate);
  const weight = resolved.text;
  const parcel = parseParcelWeight(weight);
  const weightError = !parcel.ok && parcel.error ? parcel.error : undefined;
  // Dimensions: the catalog's per-unit PRODUCT dimensions are only suggested as the PACKED parcel for one unit of one product; otherwise the
  // operator enters the packed size (dimensions are never added up or averaged across products).
  const dimensionLines = items
    .filter((i) => i.productId)
    .map((i) => {
      const p = products.find((x) => x.id === i.productId);
      const v = p?.variants.find((x) => x.id === i.variantId);
      return { unit: v?.dimensionsCm ?? p?.dimensionsCm ?? null, quantity: Number(i.quantity) };
    });
  const dimsResolved = resolvePackedDimensions(manualDims, suggestPackedDimensions(dimensionLines));
  const parcelDims = parseParcelDimensions(dimsResolved.draft);
  const dimensionsError = !parcelDims.ok && parcelDims.error ? parcelDims.error : undefined;

  function handleOpenChange(next: boolean) {
    if (!next) {
      if (createOrder.isPending) return; // never abandon an in-flight submit
      setStep("form");
      setItems([emptyItem()]);
      setOrderType("COD");
      setEdits({});
      setManualWeight(null);
      setManualDims(null);
      setManualShipping("");
      setCourierPick(null);
      setDiscountEdit(null);
      setResult(null);
      setShipmentOpen(false);
      setWhatsapp(NO_WHATSAPP);
      setStepIndex(0);
      createOrder.reset();
      idempotencyKey.current = crypto.randomUUID();
    }
    onOpenChange(next);
  }

  function updateItem(key: string, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  // A line's price comes from the exact variant that is selected - never from another variant (the product's base price is the cheapest variant's) and never from the
  // previously selected product. With several variants and none chosen yet, the price stays empty.
  const catalogPrice = (product: (typeof products)[number] | undefined, variantId: string): string => {
    if (!product) return "";
    if (product.variants.length === 0) return product.basePrice ?? "";
    return product.variants.find((v) => v.id === variantId)?.price ?? "";
  };

  function handleProductChange(key: string, productId: string) {
    const product = products.find((p) => p.id === productId);
    const only = product && product.variants.length === 1 ? product.variants[0] : null;
    const variantId = only?.id ?? "";
    updateItem(key, { productId, variantId, unitPrice: catalogPrice(product, variantId), priceEdited: false });
    void productsQuery.refetch(); // pick up the product's current price/weight from the catalogue
  }

  function handleVariantChange(key: string, productId: string, variantId: string) {
    const product = products.find((p) => p.id === productId);
    const variant = product?.variants.find((v) => v.id === variantId);
    updateItem(key, { variantId, unitPrice: catalogPrice(product, variantId), priceEdited: false });
    void productsQuery.refetch();
  }

  // When fresh catalogue data arrives, every line that has not had its price typed over follows the catalogue (price changes made since the product was selected apply).
  useEffect(() => {
    if (!productsQuery.data) return;
    setItems((prev) => {
      let changed = false;
      const next = prev.map((item) => {
        if (!item.productId || item.priceEdited) return item;
        const fresh = catalogPrice(productsQuery.data!.items.find((p) => p.id === item.productId) as never, item.variantId);
        if (fresh === "" || fresh === item.unitPrice) return item;
        changed = true;
        return { ...item, unitPrice: fresh };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productsQuery.dataUpdatedAt]);

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
  }));

  // Display-only totals (the backend recomputes the authoritative ones). Tax is not charged on manual orders.
  const subtotalCents = validItems.reduce((sum, i) => sum + cents(i.unitPrice) * i.quantity, 0);
  // One discount for the whole order, previewed with the server's rules (the server recomputes it from the real items and coupon).
  const discountCents = choiceCents(subtotalCents, discountChoice);

  // ---- Shiprocket rates, automatically, once pincode + parcel weight + packed dimensions + payment type + order value are all valid. The
  // charges are Shiprocket's (the CRM computes nothing); any change to those inputs discards the shown rates and requests fresh ones.
  const rateRequest = rateInputsOrMissing({ pincodeValid: pincodeState === "valid", pincode, cod: orderType === "COD", weight: parcel.ok ? { ok: true, kg: parcel.kg } : { ok: false }, dims: parcelDims, dimsEmpty: isDimensionDraftEmpty(dimsResolved.draft), value: (subtotalCents - discountCents) / 100 });
  const rates = useCourierRates(rateRequest.ok ? rateRequest.inputs : null, open);
  const serviceability = rates.result;
  // The shipping charge is the selected courier's Shiprocket charge, verbatim. While rates are (re)calculated there is NO charge (never the previous
  // one), and "not available" / "not calculated" are different from a genuine ₹0.
  const pickKey = courierPick && courierPick.rateKey === rates.key ? courierPick.courier : null;
  // Any change to the rate inputs ends the previous pick: the default (cheapest) applies again to the new rates.
  if (courierPick && courierPick.rateKey !== rates.key) setCourierPick(null);
  const shippingState = shippingChargeState({ requested: rateRequest.ok, calculating: rates.calculating, failed: rates.failed, result: serviceability, pickKey });
  const shippingAmount = shippingState.kind === "rate" ? chargeText(shippingState) : shippingState.kind === "calculating" ? "" : manualShipping;
  const shippingCents = cents(shippingAmount);
  const totalCents = Math.max(subtotalCents - discountCents + shippingCents, 0);
  const selectedKeyForTable = shippingState.kind === "rate" ? `${shippingState.courier ?? "courier"}|${shippingState.amount}` : null;

  const addressErrors = validateAddress(address);
  const addressComplete = Object.keys(addressErrors).length === 0 && pincodeComplete;
  const pincodeBlocks = pincodeState === "invalid" || pincodeState === "malformed" || pincodeState === "checking" || pincodeState === "incomplete" || pincodeState === "empty";
  const serviceBlocks = serviceability?.status === "not_serviceable" && serviceability.blocksOrder;
  const ratesPending = shippingState.kind === "calculating";
  const canReview = itemsValid && addressComplete && !pincodeBlocks && !serviceBlocks && !weightError && !ratesPending;

  const blockedReason = weightError
    ? weightError
    : ratesPending
    ? "Calculating shipping rates…"
    : !itemsValid
    ? "Choose a product (and variant) for every item."
    : !addressComplete
      ? (Object.values(addressErrors)[0] ?? "Fill in the delivery address and a valid 6-digit pincode.")
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
          ...composeLines(address),
          line2: composeLines(address).line2 || undefined,
          houseNumber: address.houseNumber.trim(),
          building: address.building.trim() || undefined,
          area: address.area.trim(),
          street: address.street.trim() || undefined,
          landmark: address.landmark.trim() || undefined,
          addressType: address.addressType,
          city: address.city.trim(),
          state: address.state.trim(),
          pincode: address.pincode,
          phone: address.phone || customerMobile || undefined,
        },
        shippingPincode: address.pincode,
        // Shiprocket's charge for the selected courier, or what was typed when Shiprocket has none; empty = not sent.
        shippingAmount: shippingAmount || undefined,
        // Only the CHOICE goes to the server - never a discount amount or a final total. `expectedTotal` is a consistency check:
        // if the server computes a different total, the order is refused instead of being created at a surprising amount.
        discount: toApiDiscount(discountChoice),
        expectedTotal: fromCents(totalCents),
        // The entered parcel weight is recorded on the order; nothing is sent when none was entered.
        ...(parcel.ok ? { parcelWeightKg: parcel.kg } : {}),
        // COD orders send nothing extra (unchanged). Prepaid: an explicit "Dont send", or the WhatsApp send with template + consent.
        ...(orderType !== "COD" ? toApiWhatsApp(waOptions, whatsapp) : {}),
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

  const content = (
    <>
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
              </div>
              <DiscountPricing
                subtotalCents={subtotalCents}
                shippingCents={shippingCents}
                choice={discountChoice}
                onChange={setDiscountEdit}
                fastrr={discountOptions.fastrr}
                isPrepaid={orderType !== "COD"}
                disabled={createOrder.isPending || !discountsLoaded}
              />
              <div className="rounded-xl border-[1.5px] border-border bg-card p-4">
                <dl className="grid gap-1.5">
                  <SummaryRow label="Payment method" value={`${typeInfo.title} · ${typeInfo.subtitle}`} />
                  <SummaryRow label="Payment status" value={orderType === "COD" ? "Pending (collected on delivery)" : "Pending (until the customer pays)"} />
                  <SummaryRow label="Ship to" value={<span className="break-words">{formatAddress(address)}</span>} />
                </dl>
              </div>
              <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
                {orderType === "COD"
                  ? "The order is confirmed, sent to Shopify, and the customer gets a WhatsApp confirmation."
                  : whatsapp.send
                    ? "A Cashfree payment link will be generated for this order and sent to the customer on WhatsApp with the template you chose."
                    : "A Cashfree payment link will be generated for this order. It is not sent automatically - use Send via WhatsApp above, or share it from the order."}
              </p>
              {orderType !== "COD" ? (
                <WhatsAppPaymentSection options={waOptions} loading={waOptionsQuery.isPending} error={waOptionsQuery.error ? "Could not load WhatsApp options." : null} choice={whatsapp} onChange={setWhatsapp} disabled={createOrder.isPending} />
              ) : null}
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
                <Button type="button" onClick={submit} disabled={createOrder.isPending || Boolean(whatsappBlocked)}>
                  {createOrder.isPending ? "Creating…" : orderType === "COD" ? "Create COD order" : sendingWhatsApp ? "Create Order & Send Payment Link" : "Create prepaid order"}
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

              {/* Prepaid: the payment-link / WhatsApp template choice is right here under the payment method, and again on Review. */}
              {orderType !== "COD" ? (
                <WhatsAppPaymentSection options={waOptions} loading={waOptionsQuery.isPending} error={waOptionsQuery.error ? "Could not load WhatsApp options." : null} choice={whatsapp} onChange={setWhatsapp} disabled={createOrder.isPending} />
              ) : null}

              <ShippingSection
                address={address}
                onChange={(patch) => setEdits((prev) => ({ ...prev, ...patch }))}
                weight={weight}
                weightError={weightError}
                weightHint={weightHint(resolved.source, estimate)}
                productWeightNote={estimate.complete && estimate.knownKg !== null ? `Product weight: ${formatKg(estimate.knownKg)} (estimate - not the parcel weight)` : missingWeightLabels.length > 0 ? `Catalogue weight unavailable for: ${missingWeightLabels.join("; ")}.${estimate.knownKg !== null ? ` The other items add up to ${formatKg(estimate.knownKg)} - enter the full parcel weight yourself.` : ""}` : undefined}
                onUseSuggested={manualWeight !== null && estimate.complete && estimate.knownKg !== null ? () => setManualWeight(null) : undefined}
                onWeightChange={setManualWeight}
                dimensions={dimsResolved.draft}
                dimensionsError={dimensionsError}
                dimensionsHint={dimensionsHint(dimsResolved.source, dimensionLines)}
                productDimensionsNote={productDimensionsNote(dimensionLines) ?? undefined}
                onUseSuggestedDimensions={manualDims !== null && suggestPackedDimensions(dimensionLines) ? () => setManualDims(null) : undefined}
                onDimensionsChange={(patch) => setManualDims({ ...(manualDims ?? dimsResolved.draft), ...patch })}
                shippingAmount={shippingAmount}
                shippingStatus={shippingState}
                onShippingAmountChange={setManualShipping}
                prefilledFromLastOrder={Boolean(last)}
                pincodeState={pincodeState}
                lookup={lookup}
                cityMismatch={Boolean(cityMismatch)}
                onUseResolved={() => setEdits((prev) => ({ ...prev, city: resolvedCity ?? prev.city, state: resolvedState ?? prev.state }))}
                serviceability={
                  <ServiceabilityLine
                    pincodeState={pincodeState}
                    missing={rateRequest.ok ? null : rateRequest.missing === "pincode" ? null : rateRequest.missing}
                    calculating={rates.calculating}
                    failed={rates.failed}
                    result={serviceability}
                    parcelWeightKg={parcel.ok ? parcel.kg : undefined}
                    dimensions={parcelDims.ok ? parcelDims.cm : undefined}
                    onRefresh={rates.refresh}
                    selectedKey={selectedKeyForTable}
                    onSelect={(key) => rates.key && setCourierPick({ rateKey: rates.key, courier: key })}
                  />
                }
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
    </>
  );

  if (inline) {
    return (
      <div data-testid="create-order-inline">
        {content}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-[min(1080px,calc(100vw-3rem))]">
        <DialogHeader>
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription>Order for the customer in this conversation.</DialogDescription>
        </DialogHeader>

        {content}
      </DialogContent>

      {result ? <CreateShipmentDialog open={shipmentOpen} onOpenChange={setShipmentOpen} orderId={result.order.id} orderNumber={result.order.orderNumber} currency={result.order.currency} items={result.order.items} orderValue={goodsValue(result.order)} parcelWeightKg={result.order.parcelWeightKg ?? null} pincode={result.order.shippingPincode} cod={result.order.paymentMode === "COD"} /> : null}
    </Dialog>
  );
}
