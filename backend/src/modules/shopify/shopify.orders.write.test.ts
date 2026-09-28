// Pure unit tests: the "client" is always a fake object, never a real ShopifyClient/network call -
// no real Shopify order is ever created by this file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShopifyGraphQLError, type ShopifyClient } from "./shopify.client.js";
import { createShopifyOrder, ShopifyOrderCreateError, toShopifyProductVariantGid } from "./shopify.orders.write.js";

function fakeClient(query: (document: string, variables: Record<string, unknown>) => Promise<unknown>): ShopifyClient {
  return { query } as unknown as ShopifyClient;
}

const okResponse = { orderCreate: { order: { id: "gid://shopify/Order/999", name: "#TST999" }, userErrors: [] } };

describe("createShopifyOrder (mocked client - no real Shopify call)", () => {
  it("sends a variantId line item exactly as given, for a cataloged product", async () => {
    let captured: { order: unknown; options: unknown } | undefined;
    const client = fakeClient(async (_doc, vars) => {
      captured = vars as typeof captured;
      return okResponse;
    });

    const result = await createShopifyOrder(client, {
      lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 2 }],
      currency: "INR",
      financialStatus: "PENDING",
    });

    assert.deepEqual(result, { shopifyOrderId: "gid://shopify/Order/999", shopifyOrderName: "#TST999" });
    assert.deepEqual((captured!.order as any).lineItems, [{ variantId: "gid://shopify/ProductVariant/1", quantity: 2 }]);
  });

  it("builds a custom line item (title + priceSet) when there is no Shopify-linked variant", async () => {
    let captured: { order: unknown } | undefined;
    const client = fakeClient(async (_doc, vars) => {
      captured = vars as typeof captured;
      return okResponse;
    });

    await createShopifyOrder(client, {
      lineItems: [{ title: "Herbal Tea 100g", quantity: 1, priceAmount: "349.00" }],
      currency: "INR",
      financialStatus: "PAID",
    });

    assert.deepEqual((captured!.order as any).lineItems, [
      { title: "Herbal Tea 100g", quantity: 1, priceSet: { shopMoney: { amount: "349.00", currencyCode: "INR" } } },
    ]);
  });

  it("rejects an empty line item list before calling the client", async () => {
    let called = false;
    const client = fakeClient(async () => {
      called = true;
      return okResponse;
    });
    await assert.rejects(() => createShopifyOrder(client, { lineItems: [], currency: "INR", financialStatus: "PENDING" }), ShopifyOrderCreateError);
    assert.equal(called, false);
  });

  it("rejects a line item with neither variantId nor title, before calling the client", async () => {
    let called = false;
    const client = fakeClient(async () => {
      called = true;
      return okResponse;
    });
    await assert.rejects(
      () => createShopifyOrder(client, { lineItems: [{ quantity: 1 }], currency: "INR", financialStatus: "PENDING" }),
      ShopifyOrderCreateError,
    );
    assert.equal(called, false);
  });

  it("rejects a custom line item with no priceAmount, before calling the client", async () => {
    let called = false;
    const client = fakeClient(async () => {
      called = true;
      return okResponse;
    });
    await assert.rejects(
      () => createShopifyOrder(client, { lineItems: [{ title: "Mystery item", quantity: 1 }], currency: "INR", financialStatus: "PENDING" }),
      (e: any) => e instanceof ShopifyOrderCreateError && /priceAmount/.test(e.message),
    );
    assert.equal(called, false);
  });

  it("surfaces a userErrors rejection (e.g. an invalid variant) as ShopifyOrderCreateError, never as a fabricated success", async () => {
    const client = fakeClient(async () => ({
      orderCreate: { order: null, userErrors: [{ field: ["order", "lineItems", "0", "variantId"], message: "Variant not found" }] },
    }));
    await assert.rejects(
      () => createShopifyOrder(client, { lineItems: [{ variantId: "gid://shopify/ProductVariant/999999999", quantity: 1 }], currency: "INR", financialStatus: "PENDING" }),
      (e: any) => e instanceof ShopifyOrderCreateError && /Variant not found/.test(e.message),
    );
  });

  it("wraps a transport-level GraphQL error as ShopifyOrderCreateError", async () => {
    const client = fakeClient(async () => {
      throw new ShopifyGraphQLError("Access denied", [{ message: "Access denied", code: "ACCESS_DENIED", path: null, requiredScopes: ["write_orders"] }]);
    });
    await assert.rejects(
      () => createShopifyOrder(client, { lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }], currency: "INR", financialStatus: "PENDING" }),
      ShopifyOrderCreateError,
    );
  });

  it("passes through email, phone, note and shippingAddress unchanged", async () => {
    let captured: { order: any } | undefined;
    const client = fakeClient(async (_doc, vars) => {
      captured = vars as typeof captured;
      return okResponse;
    });

    await createShopifyOrder(client, {
      lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
      currency: "INR",
      financialStatus: "PENDING",
      email: "customer@example.invalid",
      phone: "+919876543210",
      note: "Created from WhatsApp Inbox",
      shippingAddress: { firstName: "Mahadev", lastName: "Babar", address1: "123 Main St", city: "Mumbai", province: "Maharashtra", zip: "400001", country: "IN", phone: "+919876543210" },
    });

    assert.equal(captured!.order.email, "customer@example.invalid");
    assert.equal(captured!.order.phone, "+919876543210");
    assert.equal(captured!.order.note, "Created from WhatsApp Inbox");
    assert.equal(captured!.order.shippingAddress.city, "Mumbai");
  });
});

describe("Shopify ProductVariant global ids (orderCreate requires a GID)", () => {
  const VARIANT = "45068786335933"; // "Skin, Hair & Nail Gummies ... - 1 Jar", stored numeric by the catalog sync
  const GID = `gid://shopify/ProductVariant/${VARIANT}`;

  it("converts a numeric Shopify variant id to a ProductVariant GID", () => {
    assert.equal(toShopifyProductVariantGid(VARIANT), GID);
    assert.equal(toShopifyProductVariantGid(` ${VARIANT} `), GID, "surrounding whitespace is ignored");
  });

  it("leaves an already-valid ProductVariant GID unchanged (never double-prefixed)", () => {
    assert.equal(toShopifyProductVariantGid(GID), GID);
    assert.equal(toShopifyProductVariantGid(toShopifyProductVariantGid(VARIANT)), GID, "idempotent");
  });

  it("refuses ids that are not a Shopify variant id: a Product GID, a CRM uuid, junk, empty", () => {
    for (const bad of ["gid://shopify/Product/8005829886141", "6ac9f742-c3a3-4405-9a0c-e3c1852205ee", "abc", "", "gid://shopify/ProductVariant/", "12 34", "-5"]) {
      assert.throws(() => toShopifyProductVariantGid(bad), ShopifyOrderCreateError, `"${bad}" must be refused`);
    }
  });

  it("orderCreate receives the GID, not the numeric id, for a numeric CRM variant id", async () => {
    let captured: { order: any } | undefined;
    const client = fakeClient(async (_doc, vars) => {
      captured = vars as typeof captured;
      return okResponse;
    });
    await createShopifyOrder(client, { lineItems: [{ variantId: VARIANT, quantity: 1 }], currency: "INR", financialStatus: "PENDING" });
    assert.equal(captured!.order.lineItems[0].variantId, GID);
    assert.notEqual(captured!.order.lineItems[0].variantId, VARIANT);
  });

  it("converts every line item of a multi-item order (numeric, GID, and a custom item mixed)", async () => {
    let captured: { order: any } | undefined;
    const client = fakeClient(async (_doc, vars) => {
      captured = vars as typeof captured;
      return okResponse;
    });
    await createShopifyOrder(client, {
      lineItems: [
        { variantId: "45068786335933", quantity: 1 },
        { variantId: "45068786368701", quantity: 2 },
        { variantId: "gid://shopify/ProductVariant/7", quantity: 3 },
        { title: "Custom", quantity: 1, priceAmount: "10.00" },
      ],
      currency: "INR",
      financialStatus: "PENDING",
    });
    const items = captured!.order.lineItems;
    assert.deepEqual(items.slice(0, 3).map((i: any) => i.variantId), ["gid://shopify/ProductVariant/45068786335933", "gid://shopify/ProductVariant/45068786368701", "gid://shopify/ProductVariant/7"]);
    assert.equal(items[3].variantId, undefined, "a custom line item carries no variant id");
    assert.equal(items[3].title, "Custom");
  });

  it("an invalid variant id fails clearly and Shopify is never called (even when it is not the first item)", async () => {
    let called = 0;
    const client = fakeClient(async () => {
      called += 1;
      return okResponse;
    });
    await assert.rejects(
      () => createShopifyOrder(client, { lineItems: [{ variantId: VARIANT, quantity: 1 }, { variantId: "6ac9f742-c3a3-4405-9a0c-e3c1852205ee", quantity: 1 }], currency: "INR", financialStatus: "PENDING" }),
      (e: unknown) => e instanceof ShopifyOrderCreateError && /not a valid Shopify product variant id/.test(e.message),
    );
    assert.equal(called, 0);
  });
});
