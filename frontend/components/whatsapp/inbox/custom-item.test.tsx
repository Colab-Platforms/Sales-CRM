// Run with: ../backend/node_modules/.bin/tsx --test components/whatsapp/inbox/custom-item.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomItemCard } from "./custom-item-dialog";
import { ItemsSection, SummaryCard } from "./create-order-sections";
import { ItemsCard } from "@/components/orders/order-detail-parts";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("custom items in the order creation UI", () => {
  it("the items section shows 'Add custom item' next to the product action, and the product flow is still there", () => {
    const h = renderToStaticMarkup(<ItemsSection onAdd={() => {}} onAddCustom={() => {}}><div /></ItemsSection>);
    assert.match(text(h), /Add another product/);
    assert.match(text(h), /Add custom item/);
    assert.match(h, /data-testid="add-custom-item"/);
    assert.doesNotMatch(text(renderToStaticMarkup(<ItemsSection onAdd={() => {}}><div /></ItemsSection>)), /Add custom item/);
  });

  it("a custom line shows its name, 'Custom item', its flags, editable price and quantity, the line total and a Remove action", () => {
    const item = { key: "k", quantity: "3", unitPrice: "199.50", custom: { name: "Gift wrapping", taxable: true, physical: true, weight: "250", weightUnit: "G" as const } };
    const h = renderToStaticMarkup(<CustomItemCard item={item} index={1} invalid={false} canRemove onChange={() => {}} onRemove={() => {}} />);
    const t = text(h);
    assert.match(t, /Item 2 · Custom item/);
    assert.match(t, /Gift wrapping/);
    assert.match(t, /Custom item · Taxable · Physical · 250 g/);
    assert.match(t, /Line total ₹598\.50/);
    assert.match(h, /value="199\.50"/);
    assert.match(h, /data-testid="custom-item-remove"/);
    assert.doesNotMatch(renderToStaticMarkup(<CustomItemCard item={item} index={0} invalid={false} canRemove={false} onChange={() => {}} onRemove={() => {}} />), /custom-item-remove/);
  });

  it("an invalid custom line is flagged for the person (aria-invalid), not hidden", () => {
    const item = { key: "k", quantity: "0", unitPrice: "", custom: { name: "Gift", taxable: false, physical: false, weight: "", weightUnit: "KG" as const } };
    assert.match(renderToStaticMarkup(<CustomItemCard item={item} index={0} invalid canRemove onChange={() => {}} onRemove={() => {}} />), /aria-invalid="true"/);
  });

  it("the order summary distinguishes custom items from catalogue items and shows quantity and line total", () => {
    const data = {
      customerName: "A", customerMobile: null,
      lines: [
        { key: "1", name: "Herbal Masala", variant: "60 Pouches", quantity: 1, total: "649.00" },
        { key: "2", name: "Installation", variant: null, quantity: 2, total: "600.00", custom: true, flags: "Custom item · Non-taxable · Not physical" },
      ],
      subtotal: "1249.00", discount: "0", shipping: "0", total: "1249.00", orderType: "COD", address: { name: "", phone: "", deliveryInstructions: "", houseNumber: "", building: "", area: "", street: "", landmark: "", addressType: "HOME", city: "", state: "", pincode: "", line1: "", line2: "" }, pincodeState: "idle", lookup: undefined, serviceability: undefined,
    };
    const h = text(renderToStaticMarkup(<SummaryCard data={data as never} />));
    assert.match(h, /Herbal Masala 60 Pouches × 1/);
    assert.match(h, /Installation Qty 2 Custom item · Non-taxable · Not physical/);
    assert.match(h, /₹600\.00/);
  });

  it("the order detail items table shows a custom item's flags instead of a variant", () => {
    const rows = [
      { id: "1", product: "Herbal Masala", variant: "60 Pouches", sku: null, quantity: 1, unitPrice: "₹649.00", discount: "₹0.00", tax: "₹0.00", total: "₹649.00" },
      { id: "2", product: "Gift wrapping", variant: null, sku: null, quantity: 2, unitPrice: "₹99.00", discount: "₹0.00", tax: "₹0.00", total: "₹198.00", customFlags: "Custom item · Non-taxable · Physical · 250 g" },
    ];
    const h = renderToStaticMarkup(<ItemsCard rows={rows} emptyMessage="none" />);
    assert.match(text(h), /Herbal Masala 60 Pouches/);
    assert.match(h, /data-testid="custom-item-flags"/);
    assert.match(text(h), /Gift wrapping Custom item · Non-taxable · Physical · 250 g/);
  });
});
