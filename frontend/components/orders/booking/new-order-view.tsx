"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { bookingApi } from "@/lib/api-client/endpoints/booking.api";
import { leadApi } from "@/lib/api-client/endpoints/lead.api";
import { getErrorMessage } from "@/lib/api-client/client";
import type { Lead } from "@/lib/api-client/types/lead.types";
import type {
  BookingLead,
  BookingLookupResult,
  BookingPaymentMethod,
  CreateBookingResponse,
  ServiceabilityResult,
} from "@/lib/api-client/types/booking.types";
import { BookingSuccess } from "./booking-success";

// E5 on-call order booking, laid out in call order:
// 1 customer + quick pincode check -> 2 products -> 3 contact & delivery address -> 4 payment,
// with a sticky order summary (price, confirmation, Place order) on the right.

const PINCODE = /^[1-9][0-9]{5}$/;

const inr = (value: string | number) =>
  `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const opt = (value: string) => value.trim() || undefined;

interface CustomerForm {
  firstName: string;
  lastName: string;
  mobile: string;
  email: string;
}

interface AddressForm {
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
}

const EMPTY_CUSTOMER: CustomerForm = { firstName: "", lastName: "", mobile: "", email: "" };
const EMPTY_ADDRESS: AddressForm = { line1: "", line2: "", city: "", state: "", pincode: "" };

function toBookingLead(l: Lead): BookingLead {
  const extra = l as unknown as { externalSource?: string | null; location?: string | null };
  const externalSource = extra.externalSource ?? null;
  return {
    id: l.id,
    leadNumber: l.leadNumber,
    firstName: l.firstName,
    lastName: l.lastName ?? null,
    mobile: l.mobile ?? null,
    email: l.email ?? null,
    location: extra.location ?? null,
    workingStatus: String(l.workingStatus),
    externalSource,
    source: null,
    registeredOnWebsite: externalSource === "SHOPIFY",
    lastShippingAddress: null,
    lastShippingPincode: null,
  };
}

/** Reads the shipping address JSON saved on a previous order (address1/address2/city/province/zip). */
function readSavedAddress(raw: unknown): AddressForm | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  const address = { line1: s("address1"), line2: s("address2"), city: s("city"), state: s("province"), pincode: s("zip") };
  return address.line1 || address.city ? address : null;
}

function ServiceabilityBadge({ result }: { result: ServiceabilityResult }) {
  if (result.status === "SERVICEABLE") {
    return <Badge className="bg-green-600 text-white">Serviceable ({result.courierCount} couriers)</Badge>;
  }
  if (result.status === "NOT_SERVICEABLE") {
    return <Badge className="bg-red-600 text-white">Not serviceable</Badge>;
  }
  return <Badge className="bg-amber-500 text-white">Unknown{result.reason ? `: ${result.reason}` : ""}</Badge>;
}

function QtyStepper({ qty, onChange }: { qty: number; onChange: (next: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <Button type="button" size="sm" variant="outline" onClick={() => onChange(qty - 1)}>
        −
      </Button>
      <span className="w-6 text-center">{qty}</span>
      <Button type="button" size="sm" variant="outline" onClick={() => onChange(qty + 1)}>
        +
      </Button>
    </div>
  );
}

export function NewOrderView() {
  const searchParams = useSearchParams();
  const leadIdParam = searchParams.get("leadId");

  const [mobileInput, setMobileInput] = useState("");
  const [lookup, setLookup] = useState<BookingLookupResult | null>(null);
  const [lead, setLead] = useState<BookingLead | null>(null);
  const [showSearch, setShowSearch] = useState(!leadIdParam);
  const [customer, setCustomer] = useState<CustomerForm>(EMPTY_CUSTOMER);
  const [address, setAddress] = useState<AddressForm>(EMPTY_ADDRESS);
  const [serviceability, setServiceability] = useState<ServiceabilityResult | null>(null);
  const [productSearch, setProductSearch] = useState("");
  const [section, setSection] = useState("All");
  const [openProductId, setOpenProductId] = useState<string | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [discountPercent, setDiscountPercent] = useState(0);
  const [discountReason, setDiscountReason] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<BookingPaymentMethod>("COD");
  const [readBack, setReadBack] = useState(false);
  // One key per order attempt: retries reuse it, so the server returns the same order instead of a duplicate.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [placed, setPlaced] = useState<CreateBookingResponse | null>(null);

  function selectLead(l: BookingLead) {
    setLead(l);
    setShowSearch(false);
    setCustomer({
      firstName: l.firstName,
      lastName: l.lastName ?? "",
      mobile: l.mobile ?? mobileInput,
      email: l.email ?? "",
    });
    const saved = readSavedAddress(l.lastShippingAddress);
    if (saved) setAddress(saved);
    else if (l.lastShippingPincode) setAddress((a) => ({ ...a, pincode: l.lastShippingPincode! }));
    setServiceability(null);
  }

  // ---- 5.1 lead from the "Create order" link (?leadId=...) ----
  const leadFromLink = useQuery({
    queryKey: ["booking-lead", leadIdParam],
    queryFn: () => leadApi.getLead(leadIdParam!),
    enabled: !!leadIdParam,
    retry: false,
  });

  useEffect(() => {
    if (leadFromLink.data && !lead) selectLead(toBookingLead(leadFromLink.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadFromLink.data]);

  // ---- 5.2 prefill the address from this customer's last order, if any ----
  const lastAddressQuery = useQuery({
    queryKey: ["booking-last-address", lead?.id],
    queryFn: () => bookingApi.lookup(lead!.mobile!),
    enabled: !!lead?.mobile && !lead.lastShippingAddress,
    retry: false,
  });

  useEffect(() => {
    const match = lastAddressQuery.data?.leads.find((l) => l.id === lead?.id);
    const saved = readSavedAddress(match?.lastShippingAddress);
    if (saved) setAddress((current) => (current.line1 || current.city ? current : saved));
  }, [lastAddressQuery.data, lead?.id]);

  // ---- 5.1 fallback: lookup by phone ----
  const lookupMutation = useMutation({
    mutationFn: (mobile: string) => bookingApi.lookup(mobile),
    onSuccess: (result) => {
      setLookup(result);
      setLead(null);
      if (result.leads.length === 1) selectLead(result.leads[0]!);
    },
    onError: (e) => toast.error(getErrorMessage(e, "Could not search leads")),
  });

  // ---- 5.4 serviceability ----
  const serviceabilityMutation = useMutation({
    mutationFn: (args: { pincode: string; cod: boolean }) => bookingApi.serviceability(args.pincode, args.cod),
    onSuccess: setServiceability,
    onError: (e) => toast.error(getErrorMessage(e, "Could not check pincode")),
  });

  const checkPincode = (pincode: string) => serviceabilityMutation.mutate({ pincode, cod: paymentMethod === "COD" });

  function changePincode(raw: string) {
    const pincode = raw.replace(/\D/g, "").slice(0, 6);
    setAddress((a) => ({ ...a, pincode }));
    setServiceability(null);
    if (PINCODE.test(pincode)) serviceabilityMutation.mutate({ pincode, cod: paymentMethod === "COD" });
  }

  // ---- 5.3 catalog ----
  const catalogQuery = useQuery({
    queryKey: ["booking-catalog"],
    queryFn: () => bookingApi.catalog(),
    staleTime: 60_000,
  });

  const sections = useMemo(() => {
    const names = new Set<string>();
    catalogQuery.data?.forEach((p) => p.sections.forEach((s) => names.add(s)));
    return ["All", ...[...names].sort()];
  }, [catalogQuery.data]);

  const filteredProducts = useMemo(() => {
    const term = productSearch.trim().toLowerCase();
    return (catalogQuery.data ?? []).filter(
      (p) => (section === "All" || p.sections.includes(section)) && (!term || p.title.toLowerCase().includes(term)),
    );
  }, [catalogQuery.data, section, productSearch]);

  const variantIndex = useMemo(() => {
    const index = new Map<string, { productTitle: string; variantTitle: string; price: string }>();
    catalogQuery.data?.forEach((p) =>
      p.variants.forEach((v) => index.set(v.id, { productTitle: p.title, variantTitle: v.title, price: v.price })),
    );
    return index;
  }, [catalogQuery.data]);

  const items = useMemo(
    () =>
      Object.entries(cart)
        .filter(([, qty]) => qty > 0)
        .map(([variantGid, quantity]) => ({ variantGid, quantity })),
    [cart],
  );

  const setQty = (variantGid: string, qty: number) =>
    setCart((c) => ({ ...c, [variantGid]: Math.max(0, Math.min(100, qty)) }));

  // ---- 5.5 live server-side price ----
  const quoteQuery = useQuery({
    queryKey: ["booking-quote", items, discountPercent, discountReason],
    queryFn: () =>
      bookingApi.quote({
        items,
        discountPercent,
        discountReason: discountPercent > 0 ? opt(discountReason) : undefined,
      }),
    enabled: items.length > 0,
    placeholderData: (prev) => prev,
    retry: false,
  });

  const quote = items.length > 0 ? quoteQuery.data : undefined;
  const maxDiscount = quoteQuery.data?.maxDiscountPercent ?? 0;

  // ---- 5.7 what's still missing before the order can be placed ----
  const missing: string[] = [];
  if (!lead) missing.push("customer");
  if (!PINCODE.test(address.pincode)) missing.push("pincode");
  if (items.length === 0) missing.push("a product");
  if (!customer.firstName.trim()) missing.push("first name");
  if (customer.mobile.replace(/\D/g, "").length < 10) missing.push("mobile");
  if (!address.line1.trim()) missing.push("address");
  if (!address.city.trim()) missing.push("city");
  if (!address.state.trim()) missing.push("state");
  if (discountPercent > 0 && !discountReason.trim()) missing.push("discount reason");
  const currentServiceability = serviceability?.pincode === address.pincode ? serviceability : null;
  const notServiceable = currentServiceability?.status === "NOT_SERVICEABLE";

  const placeMutation = useMutation({
    mutationFn: () =>
      bookingApi.createOrder({
        leadId: lead!.id,
        idempotencyKey,
        customer: {
          firstName: customer.firstName.trim(),
          lastName: opt(customer.lastName),
          mobile: customer.mobile.trim(),
          email: opt(customer.email),
        },
        address: {
          line1: address.line1.trim(),
          line2: opt(address.line2),
          city: address.city.trim(),
          state: address.state.trim(),
          pincode: address.pincode,
        },
        items,
        discountPercent,
        discountReason: discountPercent > 0 ? opt(discountReason) : undefined,
        paymentMethod,
        confirmed: true,
      }),
    onSuccess: (result) => {
      setPlaced(result);
      toast.success(
        result.duplicate
          ? `Order ${result.order.orderNumber} was already placed`
          : `Order ${result.order.orderNumber} placed`,
      );
    },
    onError: (e) => toast.error(getErrorMessage(e, "Could not place the order. Nothing was charged — try again.")),
  });

  function startAnotherOrder() {
    setPlaced(null);
    setCart({});
    setDiscountPercent(0);
    setDiscountReason("");
    setReadBack(false);
    setIdempotencyKey(crypto.randomUUID());
  }

  const placeLabel = placeMutation.isPending
    ? "Placing order…"
    : (paymentMethod === "PAYMENT_LINK" ? "Place order & create payment link" : "Place order") +
      (quote ? " · " + inr(quote.total) : "");

  // ---------- after placing ----------
  if (placed) return <BookingSuccess placed={placed} onStartAnother={startAnotherOrder} />;

  // ---------- booking form ----------
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold">Create order</h1>
        <p className="text-sm text-muted-foreground">
          Confirm the customer, pick products, take the address, choose payment, then place the order.
        </p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ================= MAIN: steps in call order ================= */}
        <div className="flex flex-col gap-6">
          {/* 1. Customer + quick pincode check */}
          <Card>
            <CardHeader>
              <CardTitle>1. Customer</CardTitle>
              <CardDescription>Check delivery to their pincode before pitching products.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {leadIdParam && leadFromLink.isLoading && <p className="text-sm text-muted-foreground">Loading lead…</p>}
              {leadIdParam && leadFromLink.isError && (
                <p className="text-sm text-red-600">{getErrorMessage(leadFromLink.error, "Could not load this lead")}</p>
              )}

              {lead && !showSearch && (
                <div className="flex items-start justify-between gap-2 rounded-md border border-primary bg-primary/5 p-3 text-sm">
                  <div>
                    <div className="font-medium">
                      {lead.firstName} {lead.lastName ?? ""} · {lead.leadNumber}
                    </div>
                    <div className="text-muted-foreground">
                      {lead.mobile} {lead.email ? `· ${lead.email}` : ""} · {lead.workingStatus}
                      {lead.registeredOnWebsite ? " · Website account" : " · No website account"}
                    </div>
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setShowSearch(true)}>
                    Change
                  </Button>
                </div>
              )}

              {showSearch && (
                <div className="flex flex-col gap-3">
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (mobileInput.trim()) lookupMutation.mutate(mobileInput.trim());
                    }}
                  >
                    <Input
                      placeholder="Search by mobile, e.g. 9819121547"
                      value={mobileInput}
                      onChange={(e) => setMobileInput(e.target.value)}
                      inputMode="tel"
                    />
                    <Button type="submit" disabled={lookupMutation.isPending}>
                      {lookupMutation.isPending ? "Searching…" : "Search"}
                    </Button>
                  </form>

                  {lookup && lookup.leads.length === 0 && (
                    <p className="text-sm text-amber-600">
                      {lookup.existsForAnotherOwner
                        ? "This customer is assigned to another salesperson. Ask your manager to reassign the lead."
                        : "No lead found. Create the lead from the Leads page, then use its Create order button."}
                    </p>
                  )}

                  {lookup && lookup.leads.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {lookup.leads.map((l) => (
                        <button
                          key={l.id}
                          type="button"
                          onClick={() => selectLead(l)}
                          className={`rounded-md border p-3 text-left text-sm ${
                            lead?.id === l.id ? "border-primary bg-primary/5" : ""
                          }`}
                        >
                          <div className="font-medium">
                            {l.firstName} {l.lastName ?? ""} · {l.leadNumber}
                          </div>
                          <div className="text-muted-foreground">
                            {l.mobile} {l.email ? `· ${l.email}` : ""} · {l.workingStatus}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-1">
                <Label>Delivery pincode *</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="w-40"
                    value={address.pincode}
                    maxLength={6}
                    inputMode="numeric"
                    placeholder="6-digit pincode"
                    onChange={(e) => changePincode(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!PINCODE.test(address.pincode) || serviceabilityMutation.isPending}
                    onClick={() => checkPincode(address.pincode)}
                  >
                    {serviceabilityMutation.isPending ? "Checking…" : "Check"}
                  </Button>
                  {currentServiceability && <ServiceabilityBadge result={currentServiceability} />}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 2. Products */}
          <Card>
            <CardHeader>
              <CardTitle>2. Products</CardTitle>
              <CardDescription>Live from the Shopify store. Search or pick a section, then add variants.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  placeholder="Search products…"
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                />
                <select
                  className="h-9 rounded-md border bg-background px-3 text-sm sm:w-56"
                  value={section}
                  onChange={(e) => setSection(e.target.value)}
                >
                  {sections.map((s) => (
                    <option key={s} value={s}>
                      {s === "All" ? "All sections" : s}
                    </option>
                  ))}
                </select>
              </div>

              {catalogQuery.isLoading && <p className="text-sm text-muted-foreground">Loading products…</p>}
              {catalogQuery.isError && (
                <p className="text-sm text-red-600">{getErrorMessage(catalogQuery.error, "Could not load products")}</p>
              )}

              <div className="max-h-[340px] divide-y overflow-y-auto rounded-md border">
                {filteredProducts.map((p) => {
                  const open = openProductId === p.id;
                  const sellable = p.variants.filter((v) => v.sellable);
                  const prices = p.variants.map((v) => Number(v.price)).filter((n) => Number.isFinite(n));
                  const fromPrice = prices.length ? Math.min(...prices) : null;
                  return (
                    <div key={p.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
                        onClick={() => setOpenProductId(open ? null : p.id)}
                      >
                        <span className="font-medium">{p.title}</span>
                        <span className="flex shrink-0 items-center gap-2 text-sm">
                          <span
                            className={
                              sellable.length === 0 ? "text-muted-foreground" : "font-semibold text-foreground"
                            }
                          >
                            {sellable.length === 0 ? "Out of stock" : fromPrice !== null ? "from " + inr(fromPrice) : ""}
                          </span>
                          <span className="rounded-md border border-primary px-2.5 py-0.5 text-xs font-semibold text-primary">
                            {open ? "Hide" : "Choose"}
                          </span>
                        </span>
                      </button>
                      {open && (
                        <div className="flex flex-col gap-2 bg-muted/30 px-3 py-2">
                          {p.variants.map((v) => {
                            const qty = cart[v.id] ?? 0;
                            return (
                              <div key={v.id} className="flex items-center justify-between gap-2 text-sm">
                                <span className={v.sellable ? "" : "text-muted-foreground line-through"}>
                                  {v.title} · {inr(v.price)}
                                  {!v.sellable && " (out of stock)"}
                                </span>
                                {v.sellable &&
                                  (qty > 0 ? (
                                    <QtyStepper qty={qty} onChange={(n) => setQty(v.id, n)} />
                                  ) : (
                                    <Button type="button" size="sm" variant="outline" onClick={() => setQty(v.id, 1)}>
                                      Add
                                    </Button>
                                  ))}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {!catalogQuery.isLoading && filteredProducts.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">No products match.</p>
                )}
              </div>

              {items.length > 0 && (
                <div className="rounded-md border">
                  <div className="border-b px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                    In this order
                  </div>
                  <div className="divide-y">
                    {items.map((i) => {
                      const info = variantIndex.get(i.variantGid);
                      return (
                        <div key={i.variantGid} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span>
                            {info ? info.productTitle + " · " + info.variantTitle : "Product"}
                            {info && <span className="text-muted-foreground"> · {inr(info.price)}</span>}
                          </span>
                          <div className="flex items-center gap-2">
                            <QtyStepper qty={i.quantity} onChange={(n) => setQty(i.variantGid, n)} />
                            <Button type="button" size="sm" variant="ghost" onClick={() => setQty(i.variantGid, 0)}>
                              Remove
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 3. Contact & delivery address */}
          <Card>
            <CardHeader>
              <CardTitle>3. Contact & delivery address</CardTitle>
              <CardDescription>Take the full address once the customer agrees to buy.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label>First name *</Label>
                <Input value={customer.firstName} onChange={(e) => setCustomer({ ...customer, firstName: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Last name</Label>
                <Input value={customer.lastName} onChange={(e) => setCustomer({ ...customer, lastName: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Mobile *</Label>
                <Input value={customer.mobile} onChange={(e) => setCustomer({ ...customer, mobile: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Email</Label>
                <Input value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label>Address line 1 *</Label>
                <Input value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label>Address line 2</Label>
                <Input value={address.line2} onChange={(e) => setAddress({ ...address, line2: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>City *</Label>
                <Input value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>State *</Label>
                <Input value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Pincode: {address.pincode || "—"} (change it in step 1)
              </p>
            </CardContent>
          </Card>

          {/* 4. Payment */}
          <Card>
            <CardHeader>
              <CardTitle>4. Payment</CardTitle>
              <CardDescription>How will the customer pay?</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={paymentMethod === "COD" ? "default" : "outline"}
                onClick={() => {
                  setPaymentMethod("COD");
                  setServiceability(null);
                }}
              >
                Cash on delivery
              </Button>
              <Button
                type="button"
                variant={paymentMethod === "PAYMENT_LINK" ? "default" : "outline"}
                onClick={() => {
                  setPaymentMethod("PAYMENT_LINK");
                  setServiceability(null);
                }}
              >
                Payment link / UPI
              </Button>
              <p className="w-full pt-1 text-xs text-muted-foreground">
                {paymentMethod === "COD"
                  ? "Customer pays the courier on delivery."
                  : "A Cashfree payment link (fixed amount, any UPI app) is created when you place the order."}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* ================= SIDE: sticky order summary ================= */}
        <div className="lg:sticky lg:top-4">
          <Card>
            <CardHeader>
              <CardTitle>Order summary</CardTitle>
              <CardDescription>Price calculated by the server from live store prices.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {items.length === 0 && <p className="text-muted-foreground">No products added yet.</p>}

              {items.map((i) => {
                const info = variantIndex.get(i.variantGid);
                const line = quote?.lines.find((l) => l.variantGid === i.variantGid);
                return (
                  <div key={i.variantGid} className="flex justify-between gap-2">
                    <span>
                      {info ? info.productTitle + " · " + info.variantTitle : "Product"} × {i.quantity}
                    </span>
                    <span className="shrink-0">{line ? inr(line.lineTotal) : "…"}</span>
                  </div>
                );
              })}

              {quoteQuery.isError && items.length > 0 && (
                <p className="text-red-600">{getErrorMessage(quoteQuery.error, "Could not calculate price")}</p>
              )}

              {quote && (
                <>
                  <div className="flex justify-between border-t pt-2">
                    <span>Subtotal</span>
                    <span>{inr(quote.subtotal)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>Discount % {maxDiscount === 0 ? "(off)" : "(max " + maxDiscount + ")"}</span>
                    <Input
                      className="h-8 w-20"
                      type="number"
                      min={0}
                      max={maxDiscount}
                      disabled={maxDiscount === 0}
                      value={discountPercent}
                      onChange={(e) => setDiscountPercent(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </div>
                  {discountPercent > 0 && (
                    <Input
                      placeholder="Reason for discount (required)"
                      value={discountReason}
                      onChange={(e) => setDiscountReason(e.target.value)}
                    />
                  )}
                  <div className="flex justify-between">
                    <span>Discount</span>
                    <span>− {inr(quote.discountAmount)}</span>
                  </div>
                  <div className="flex justify-between border-t pt-2 text-base font-semibold">
                    <span>Total</span>
                    <span>{inr(quote.total)}</span>
                  </div>
                  {quoteQuery.isFetching && <p className="text-xs text-muted-foreground">Recalculating…</p>}
                </>
              )}

              <div className="flex flex-col gap-1 border-t pt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Delivery</span>
                  {currentServiceability ? <ServiceabilityBadge result={currentServiceability} /> : <span>Not checked</span>}
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Ship to</span>
                  <span className="text-right">
                    {[address.line1, address.city, address.pincode].filter(Boolean).join(", ") || "—"}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Payment</span>
                  <span>{paymentMethod === "COD" ? "Cash on delivery" : "Payment link"}</span>
                </div>
              </div>

              <label className="flex items-start gap-2 pt-1">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={readBack}
                  onChange={(e) => setReadBack(e.target.checked)}
                />
                I have read the order back to the customer and they confirmed it.
              </label>

              {missing.length > 0 && <p className="text-amber-600">Still needed: {missing.join(", ")}.</p>}
              {notServiceable && <p className="text-red-600">We can&apos;t deliver to this pincode.</p>}

              <Button
                type="button"
                size="lg"
                disabled={missing.length > 0 || notServiceable || !readBack || !quote || placeMutation.isPending}
                onClick={() => placeMutation.mutate()}
              >
                {placeLabel}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}