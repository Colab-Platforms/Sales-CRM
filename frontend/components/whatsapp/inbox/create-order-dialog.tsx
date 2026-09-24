"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getErrorMessage } from "@/lib/api-client/client";
import { useCreateOrderMutation, usePushOrderToShopifyMutation } from "@/lib/api-client/mutations/orders.mutations";
import { productListQueryOptions } from "@/lib/api-client/queries/products.queries";
import { formatMoney } from "@/lib/order-status";
import { CreateShipmentDialog } from "@/components/orders/create-shipment-dialog";
import type { CreateManualOrderItemInput, CreateManualOrderResult, PaymentMethod } from "@/lib/api-client/types/orders.types";

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  COD: "Cash on Delivery",
  UPI: "UPI",
  CARD: "Card",
  NET_BANKING: "Net Banking",
  WALLET: "Wallet",
  PAYMENT_LINK: "Payment Link",
  CASH: "Cash",
  OTHER: "Other",
};

interface DraftItem {
  key: string;
  productId: string;
  variantId: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
}

function emptyItem(): DraftItem {
  return { key: crypto.randomUUID(), productId: "", variantId: "", quantity: "1", unitPrice: "", discountAmount: "" };
}

interface CreateOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  customerName: string;
  customerMobile: string | null;
}

export function CreateOrderDialog({ open, onOpenChange, leadId, customerName, customerMobile }: CreateOrderDialogProps) {
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("COD");
  const [line1, setLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [pincode, setPincode] = useState("");
  const [shippingAmount, setShippingAmount] = useState("");
  const [result, setResult] = useState<CreateManualOrderResult | null>(null);
  const [shipmentOpen, setShipmentOpen] = useState(false);

  const productsQuery = useQuery({ ...productListQueryOptions({ page: 1, pageSize: 100 }), enabled: open });
  const products = useMemo(() => productsQuery.data?.items ?? [], [productsQuery.data]);
  const productItems = useMemo(() => Object.fromEntries(products.map((p) => [p.id, p.sku ? `${p.name} (${p.sku})` : p.name])), [products]);

  const createOrder = useCreateOrderMutation();
  const pushToShopify = usePushOrderToShopifyMutation();

  function handleOpenChange(next: boolean) {
    if (!next) {
      setItems([emptyItem()]);
      setPaymentMethod("COD");
      setLine1("");
      setCity("");
      setState("");
      setPincode("");
      setShippingAmount("");
      setResult(null);
      setShipmentOpen(false);
    }
    onOpenChange(next);
  }

  function updateItem(key: string, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  function handleProductChange(key: string, productId: string) {
    const product = products.find((p) => p.id === productId);
    updateItem(key, { productId, variantId: "", unitPrice: product?.basePrice ?? "" });
  }

  function handleVariantChange(key: string, productId: string, variantId: string) {
    const product = products.find((p) => p.id === productId);
    const variant = product?.variants.find((v) => v.id === variantId);
    updateItem(key, { variantId, unitPrice: variant?.price ?? product?.basePrice ?? "" });
  }

  const validItems: CreateManualOrderItemInput[] = items
    .filter((i) => i.productId && Number(i.quantity) > 0 && i.unitPrice.trim())
    .map((i) => ({
      productId: i.productId,
      variantId: i.variantId || undefined,
      quantity: Number(i.quantity),
      unitPrice: i.unitPrice,
      discountAmount: i.discountAmount || undefined,
    }));

  const canSubmit = validItems.length > 0 && validItems.length === items.length && !createOrder.isPending;

  function handleSubmit() {
    createOrder.mutate(
      {
        leadId,
        items: validItems,
        paymentMethod,
        shippingAddress: line1 || city || state || pincode ? { name: customerName, line1, city, state, pincode, phone: customerMobile ?? undefined } : undefined,
        shippingPincode: pincode || undefined,
        shippingAmount: shippingAmount || undefined,
      },
      {
        onSuccess: (created) => setResult(created),
        onError: (error) => toast.error(getErrorMessage(error, "Could not create the order.")),
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Create Order</DialogTitle>
          <DialogDescription>For {customerName}</DialogDescription>
        </DialogHeader>

        {result ? (
          <OrderCreatedView result={result} onRetryShopify={handleRetryShopify} retrying={pushToShopify.isPending} onCreateShipment={() => setShipmentOpen(true)} onDone={() => handleOpenChange(false)} />
        ) : (
          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label>Items</Label>
              {items.map((item) => {
                const product = products.find((p) => p.id === item.productId);
                return (
                  <div key={item.key} className="grid grid-cols-[1fr_auto] gap-2 rounded-lg border p-3">
                    <div className="grid gap-2">
                      <Select value={item.productId || null} items={productItems} onValueChange={(v) => handleProductChange(item.key, v ?? "")}>
                        <SelectTrigger>
                          <SelectValue placeholder={productsQuery.isPending ? "Loading products…" : "Select a product"} />
                        </SelectTrigger>
                        <SelectContent>
                          {products.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name} {p.sku ? <span className="text-muted-foreground">({p.sku})</span> : null}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {product && product.variants.length > 0 ? (
                        <Select
                          value={item.variantId || null}
                          items={Object.fromEntries(product.variants.map((v) => [v.id, v.name]))}
                          onValueChange={(v) => handleVariantChange(item.key, item.productId, v ?? "")}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select a variant" />
                          </SelectTrigger>
                          <SelectContent>
                            {product.variants.map((v) => (
                              <SelectItem key={v.id} value={v.id}>
                                {v.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}

                      <div className="grid grid-cols-3 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Qty</Label>
                          <Input type="number" min="1" value={item.quantity} onChange={(e) => updateItem(item.key, { quantity: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Unit price</Label>
                          <Input value={item.unitPrice} onChange={(e) => updateItem(item.key, { unitPrice: e.target.value })} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Discount</Label>
                          <Input value={item.discountAmount} onChange={(e) => updateItem(item.key, { discountAmount: e.target.value })} placeholder="0" />
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setItems((prev) => prev.filter((i) => i.key !== item.key))}
                      disabled={items.length === 1}
                      aria-label="Remove item"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
              <Button variant="outline" size="sm" onClick={() => setItems((prev) => [...prev, emptyItem()])}>
                <Plus data-icon="inline-start" />
                Add item
              </Button>
            </div>

            <div className="grid gap-1.5">
              <Label>Payment method</Label>
              <Select value={paymentMethod} items={PAYMENT_METHOD_LABELS} onValueChange={(v) => setPaymentMethod((v as PaymentMethod) ?? "COD")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5 border-t pt-3">
              <Label>Shipping address</Label>
              <Input placeholder="Address line" value={line1} onChange={(e) => setLine1(e.target.value)} />
              <div className="grid grid-cols-3 gap-2">
                <Input placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} />
                <Input placeholder="State" value={state} onChange={(e) => setState(e.target.value)} />
                <Input placeholder="Pincode" value={pincode} onChange={(e) => setPincode(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Shipping amount</Label>
                  <Input value={shippingAmount} onChange={(e) => setShippingAmount(e.target.value)} placeholder="0" />
                </div>
              </div>
            </div>

            {createOrder.error ? <p className="text-sm text-destructive">{getErrorMessage(createOrder.error, "Failed to create order.")}</p> : null}
          </div>
        )}

        {!result ? (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
              {createOrder.isPending ? "Creating…" : "Create Order"}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>

      {result ? (
        <CreateShipmentDialog open={shipmentOpen} onOpenChange={setShipmentOpen} orderId={result.order.id} orderNumber={result.order.orderNumber} currency={result.order.currency} />
      ) : null}
    </Dialog>
  );
}

function OrderCreatedView({
  result,
  onRetryShopify,
  retrying,
  onCreateShipment,
  onDone,
}: {
  result: CreateManualOrderResult;
  onRetryShopify: () => void;
  retrying: boolean;
  onCreateShipment: () => void;
  onDone: () => void;
}) {
  const { order, shopify } = result;
  return (
    <div className="grid gap-4 py-2">
      <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
        <CircleCheck className="size-5" />
        <p className="font-medium">Order created</p>
      </div>

      <div className="rounded-lg border p-3 text-sm">
        <p className="font-semibold">{order.orderNumber}</p>
        <ul className="mt-1 space-y-0.5 text-muted-foreground">
          {order.items.map((item) => (
            <li key={item.id}>
              {item.productName}
              {item.variantName ? ` (${item.variantName})` : ""} × {item.quantity}
            </li>
          ))}
        </ul>
        <p className="mt-2">
          Total: <span className="font-semibold text-foreground">{formatMoney(order.totalAmount, order.currency)}</span>
        </p>
        <p className="text-muted-foreground">Payment: {order.paymentMode ?? "—"}</p>
      </div>

      <div className="grid gap-2 rounded-lg border p-3 text-sm">
        <div className="flex items-center justify-between">
          <span>Shopify</span>
          {shopify.status === "failed" ? (
            <span className="flex items-center gap-1 text-destructive">
              <CircleAlert className="size-4" /> Failed
            </span>
          ) : (
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <CircleCheck className="size-4" /> {shopify.status === "already_linked" ? "Linked" : "Created"} {shopify.shopifyOrderName ? `(${shopify.shopifyOrderName})` : ""}
            </span>
          )}
        </div>
        {shopify.status === "failed" ? (
          <>
            <p className="text-xs text-destructive">{shopify.reason}</p>
            <Button variant="outline" size="sm" onClick={onRetryShopify} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry Shopify sync"}
            </Button>
          </>
        ) : null}
      </div>

      <div className="rounded-lg border p-3 text-sm">
        <div className="flex items-center justify-between">
          <span>Shiprocket</span>
          <span className="text-muted-foreground">Not yet attempted</span>
        </div>
        <Button variant="outline" size="sm" className="mt-2" onClick={onCreateShipment}>
          Create Shiprocket shipment
        </Button>
      </div>

      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  );
}
