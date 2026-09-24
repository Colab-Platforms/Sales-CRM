"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
  CreateBookingResult,
  ServiceabilityResult,
} from "@/lib/api-client/types/booking.types";

// E5 on-call order booking. Normally opened from a lead ("Create Order" -> ?leadId=...).
// 5.1 lead -> 5.2 customer & address -> 5.4 serviceability -> 5.3 products -> 5.5 price
// -> 5.6 payment method -> 5.7 review, explicit confirmation, duplicate-safe placement.

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
  const externalSource = (l as unknown as { externalSource?: string | null }).externalSource ?? null;
  return {
    id: l.id,
    leadNumber: l.leadNumber,
    firstName: l.firstName,
    lastName: l.lastName ?? null,
    mobile: l.mobile ?? null,
    email: l.email ?? null,
    location: (l as unknown as { location?: string | null }).location ?? null,
    workingStatus: String(l.workingStatus),
    externalSource,
    source: null,
    registeredOnWebsite: externalSource === "SHOPIFY",
    lastShippingAddress: null,
    lastShippingPincode: null,
  };
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
  const [section, setSection] = useState("All");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [discountPercent, setDiscountPercent] = useState(0);
  const [discountReason, setDiscountReason] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<BookingPaymentMethod>("COD");
  const [readBack, setReadBack] = useState(false);
  // One key per order attempt: retries reuse it, so the server returns the same order instead of a duplicate.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [placed, setPlaced] = useState<CreateBookingResult | null>(null);

  function selectLead(l: BookingLead) {
    setLead(l);
    setShowSearch(false);
    setCustomer({
      firstName: l.firstName,
      lastName: l.lastName ?? "",
      mobile: l.mobile ?? mobileInput,
      email: l.email ?? "",
    });
    setAddress((a) => ({ ...a, pincode: l.lastShippingPincode ?? a.pincode }));
    setServiceability(null);
  }

  // ---- 5.1 lead from the link (?leadId=...) ----
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
    mutationFn: (pincode: string) => bookingApi.serviceability(pincode, paymentMethod === "COD"),
    onSuccess: setServiceability,
    onError: (e) => toast.error(getErrorMessage(e, "Could not check pincode")),
  });

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

  const products = useMemo(
    () => (catalogQuery.data ?? []).filter((p) => section === "All" || p.sections.includes(section)),
    [catalogQuery.data, section],
  );

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
  if (!lead) missing.push("select the customer");
  if (!customer.firstName.trim()) missing.push("first name");
  if (customer.mobile.replace(/\D/g, "").length < 10) missing.push("mobile");
  if (!address.line1.trim()) missing.push("address line 1");
  if (!address.city.trim()) missing.push("city");
  if (!address.state.trim()) missing.push("state");
  if (!PINCODE.test(address.pincode)) missing.push("valid pincode");
  if (items.length === 0) missing.push("at least one product");
  if (discountPercent > 0 && !discountReason.trim()) missing.push("discount reason");
  const notServiceable =
    serviceability?.pincode === address.pincode && serviceability.status === "NOT_SERVICEABLE";

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

  if (placed) {
    const payment = placed.order.payments[0];
    return (
      <div className="flex flex-col gap-6 p-4 md:p-6">
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Order {placed.order.orderNumber} placed</CardTitle>
            <CardDescription>
              {placed.duplicate ? "This order had already been placed — no duplicate was created." : "Saved to the CRM."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <span>Status</span>
              <Badge>{placed.order.status}</Badge>
            </div>
            <div className="flex justify-between">
              <span>Total</span>
              <span className="font-semibold">{inr(placed.order.totalAmount)}</span>
            </div>
            {payment && (
              <div className="flex justify-between">
                <span>Payment</span>
                <span>
                  {payment.method} · {payment.status}
                </span>
              </div>
            )}
            {placed.order.status === "PENDING_PAYMENT" && (
              <p className="text-amber-600">
                Awaiting payment. Open the order to send the Cashfree payment link to the customer.
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <Link href={`/dashboard/orders/${placed.order.id}`}>
                <Button type="button">Open order</Button>
              </Link>
              <Button type="button" variant="outline" onClick={startAnotherOrder}>
                Start another order
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold">Create order</h1>
        <p className="text-sm text-muted-foreground">Confirm delivery details, pick products, review and place.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* LEFT: customer */}
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>1. Customer</CardTitle>
              <CardDescription>
                {lead ? "Ordering for this lead." : "Search by the mobile number they are calling from."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
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
                <>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (mobileInput.trim()) lookupMutation.mutate(mobileInput.trim());
                    }}
                  >
                    <Input
                      placeholder="e.g. 9819121547"
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
                        : "No lead found. Create the lead from the Leads page, then use its Create Order button."}
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
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>2. Customer details & delivery address</CardTitle>
              <CardDescription>Prefilled from the lead. Correct anything the customer tells you.</CardDescription>
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
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label>Pincode *</Label>
                <div className="flex gap-2">
                  <Input
                    value={address.pincode}
                    maxLength={6}
                    inputMode="numeric"
                    onChange={(e) => {
                      setAddress({ ...address, pincode: e.target.value.replace(/\D/g, "") });
                      setServiceability(null);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!PINCODE.test(address.pincode) || serviceabilityMutation.isPending}
                    onClick={() => serviceabilityMutation.mutate(address.pincode)}
                  >
                    {serviceabilityMutation.isPending ? "Checking…" : "Check delivery"}
                  </Button>
                </div>
                {serviceability && serviceability.pincode === address.pincode && (
                  <div className="pt-1">
                    <ServiceabilityBadge result={serviceability} />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* RIGHT: products, price, payment & confirm */}
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>3. Products</CardTitle>
              <CardDescription>Live from the Shopify store. Out-of-stock variants can&apos;t be ordered.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                {sections.map((s) => (
                  <Button
                    key={s}
                    type="button"
                    size="sm"
                    variant={section === s ? "default" : "outline"}
                    onClick={() => setSection(s)}
                  >
                    {s}
                  </Button>
                ))}
              </div>

              {catalogQuery.isLoading && <p className="text-sm text-muted-foreground">Loading products…</p>}
              {catalogQuery.isError && (
                <p className="text-sm text-red-600">{getErrorMessage(catalogQuery.error, "Could not load products")}</p>
              )}

              <div className="flex max-h-[520px] flex-col gap-4 overflow-y-auto pr-1">
                {products.map((p) => (
                  <div key={p.id} className="rounded-md border p-3">
                    <div className="mb-2 font-medium">{p.title}</div>
                    <div className="flex flex-col gap-2">
                      {p.variants.map((v) => {
                        const qty = cart[v.id] ?? 0;
                        return (
                          <div key={v.id} className="flex items-center justify-between gap-2 text-sm">
                            <div className={v.sellable ? "" : "text-muted-foreground line-through"}>
                              {v.title} · {inr(v.price)}
                              {!v.sellable && <span className="ml-2">(out of stock)</span>}
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={!v.sellable || qty === 0}
                                onClick={() => setQty(v.id, qty - 1)}
                              >
                                −
                              </Button>
                              <span className="w-6 text-center">{qty}</span>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={!v.sellable}
                                onClick={() => setQty(v.id, qty + 1)}
                              >
                                +
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>4. Price</CardTitle>
              <CardDescription>Calculated by the server from live store prices.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {items.length === 0 && <p className="text-muted-foreground">Add a product to see the price.</p>}
              {quoteQuery.isError && items.length > 0 && (
                <p className="text-red-600">{getErrorMessage(quoteQuery.error, "Could not calculate price")}</p>
              )}
              {quote && (
                <>
                  {quote.lines.map((line) => (
                    <div key={line.variantGid} className="flex justify-between gap-2">
                      <span>
                        {line.productTitle} · {line.variantTitle} × {line.quantity}
                      </span>
                      <span>{inr(line.lineTotal)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between border-t pt-2">
                    <span>Subtotal</span>
                    <span>{inr(quote.subtotal)}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>Discount % {maxDiscount === 0 ? "(not enabled)" : `(max ${maxDiscount}%)`}</Label>
                    <Input
                      type="number"
                      min={0}
                      max={maxDiscount}
                      disabled={maxDiscount === 0}
                      value={discountPercent}
                      onChange={(e) => setDiscountPercent(Math.max(0, Number(e.target.value) || 0))}
                    />
                    {discountPercent > 0 && (
                      <Input
                        placeholder="Reason for discount (required)"
                        value={discountReason}
                        onChange={(e) => setDiscountReason(e.target.value)}
                      />
                    )}
                  </div>
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>5. Payment & confirm</CardTitle>
              <CardDescription>Read the order back to the customer before placing it.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={paymentMethod === "COD" ? "default" : "outline"}
                  onClick={() => setPaymentMethod("COD")}
                >
                  Cash on delivery
                </Button>
                <Button
                  type="button"
                  variant={paymentMethod === "PAYMENT_LINK" ? "default" : "outline"}
                  onClick={() => setPaymentMethod("PAYMENT_LINK")}
                >
                  Payment link / UPI
                </Button>
              </div>

              <div className="rounded-md border p-3">
                <div className="mb-2 font-medium">Review</div>
                <div className="grid grid-cols-[110px_1fr] gap-y-1">
                  <span className="text-muted-foreground">Customer</span>
                  <span>
                    {customer.firstName} {customer.lastName} · {customer.mobile}
                  </span>
                  <span className="text-muted-foreground">Address</span>
                  <span>
                    {[address.line1, address.line2, address.city, address.state].filter(Boolean).join(", ")}{" "}
                    {address.pincode}
                  </span>
                  <span className="text-muted-foreground">Delivery</span>
                  <span>
                    {serviceability && serviceability.pincode === address.pincode ? (
                      <ServiceabilityBadge result={serviceability} />
                    ) : (
                      "Not checked"
                    )}
                  </span>
                  <span className="text-muted-foreground">Items</span>
                  <span>
                    {quote
                      ? quote.lines.map((l) => `${l.productTitle} · ${l.variantTitle} × ${l.quantity}`).join("; ")
                      : "—"}
                  </span>
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-semibold">{quote ? inr(quote.total) : "—"}</span>
                  <span className="text-muted-foreground">Payment</span>
                  <span>{paymentMethod === "COD" ? "Cash on delivery" : "Payment link (Cashfree)"}</span>
                </div>
              </div>

              <label className="flex items-center gap-2">
                <input type="checkbox" checked={readBack} onChange={(e) => setReadBack(e.target.checked)} />
                I have read the order back to the customer and they confirmed it.
              </label>

              {missing.length > 0 && <p className="text-amber-600">Still needed: {missing.join(", ")}.</p>}
              {notServiceable && <p className="text-red-600">We can&apos;t deliver to this pincode.</p>}

              <Button
                type="button"
                disabled={missing.length > 0 || notServiceable || !readBack || !quote || placeMutation.isPending}
                onClick={() => placeMutation.mutate()}
              >
                {placeMutation.isPending ? "Placing order…" : `Place order${quote ? ` · ${inr(quote.total)}` : ""}`}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}