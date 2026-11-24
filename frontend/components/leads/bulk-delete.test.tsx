// Frontend tests for: the CRM coupons a telecaller sees in order creation, the two bulk-delete options, the confirmation wording and the page-size choices.
// Run with: ../backend/node_modules/.bin/tsx --test components/leads/bulk-delete.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditorBody } from "@/components/discounts/discount-editor";
import { DiscountPricing } from "@/components/whatsapp/inbox/discount-section";
import { choiceFromCrmCoupon, choiceCents, type CrmCouponOption, type DiscountChoice } from "@/lib/discount";
import { LeadSelectionToolbar } from "./lead-selection-toolbar";
import { BulkDeleteLeadsDialog, bulkDeleteCopy, deleteAllConfirmed } from "./bulk-delete-leads-dialog";
import { PAGE_SIZES } from "@/app/dashboard/leads/page";
import { COD_SHIPPING_CHARGE } from "@/lib/cod-shipping";
import { getErrorMessage } from "@/lib/api-client/client";
import { AxiosError } from "axios";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const fastrr = { available: false, coupons: [], reason: null };

const coupons: CrmCouponOption[] = [
  { id: "c1", code: "NEWYEAR_OFFER", type: "PERCENT", value: "50", minOrderValue: null, maxDiscount: null, eligibility: "ALL", eligible: true, reason: null },
  { id: "c2", code: "FLAT100", type: "FIXED", value: "100", minOrderValue: "500", maxDiscount: null, eligibility: "ALL", eligible: true, reason: null },
  { id: "c3", code: "DISTRIBUTOR500", type: "FIXED", value: "500", minOrderValue: null, maxDiscount: null, eligibility: "DISTRIBUTOR", eligible: false, reason: "Only for distributors; this customer is not a distributor" },
];
const NONE: DiscountChoice = { mode: "NONE" };
const coupon = (code: string) => choiceFromCrmCoupon(coupons.find((c) => c.code === code)!);

describe("telecaller order creation: Admin-created coupons", () => {
  const editor = (cs = coupons) =>
    text(renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><EditorBody onOpenChange={() => {}} current={coupon("NEWYEAR_OFFER")} fastrr={fastrr} crmCoupons={cs} customerType="REGULAR" baseCents={100000} onApply={() => {}} /></QueryClientProvider>));

  it("lists every active coupon with its code, type and value, and marks the ones this customer cannot use, with the reason", () => {
    const t = editor();
    assert.match(t, /NEWYEAR_OFFER — 50% off/);
    assert.match(t, /FLAT100 — ₹100 off/);
    assert.match(t, /DISTRIBUTOR500 — ₹500 off \(not eligible\)/);
    assert.match(t, /DISTRIBUTOR500 is not available: Only for distributors/);
  });
  it("a coupon the Admin just created appears as soon as the list contains it, and a deactivated one is gone", () => {
    const before = editor(coupons.slice(1));
    assert.ok(!before.includes("NEWYEAR_OFFER"));
    assert.ok(editor(coupons).includes("NEWYEAR_OFFER"));
    assert.match(editor([]), /No active coupons right now/);
  });
  it("offers 'No discount' so an applied coupon can be removed or changed", () => {
    assert.match(editor(), /No discount/);
  });
});

describe("order summary: original amount, discount and final payable (Rs 1,000, NEWYEAR_OFFER 50%)", () => {
  const summary = (choice: DiscountChoice, cod: boolean) =>
    text(renderToStaticMarkup(<DiscountPricing subtotalCents={100000} shippingCents={cod ? Math.round(Number(COD_SHIPPING_CHARGE) * 100) : 0} choice={choice} onChange={() => {}} fastrr={fastrr} crmCoupons={coupons} customerType="REGULAR" isPrepaid={!cod} />));

  it("the preview matches the server rule: prepaid 500, COD 549 (the COD fee is added after the coupon, never discounted)", () => {
    assert.equal(choiceCents(100000, coupon("NEWYEAR_OFFER")), 50000);
    const prepaid = summary(coupon("NEWYEAR_OFFER"), false);
    assert.match(prepaid, /Subtotal ₹1,000\.00/);
    assert.match(prepaid, /NEWYEAR_OFFER −₹500\.00/);
    assert.match(prepaid, /Shipping ₹0\.00 free on prepaid/);
    assert.match(prepaid, /Total ₹500\.00/);
    const cod = summary(coupon("NEWYEAR_OFFER"), true);
    assert.match(cod, /Shipping ₹49\.00/);
    assert.match(cod, /Total ₹549\.00/);
    assert.doesNotMatch(cod, /₹550\.00|₹499\.00/);
  });
  it("removing the coupon returns the plain amounts (prepaid 1,000, COD 1,049)", () => {
    assert.match(summary(NONE, false), /Total ₹1,000\.00/);
    assert.match(summary(NONE, true), /Total ₹1,049\.00/);
  });
  it("a flat coupon: prepaid 900, COD 949", () => {
    assert.match(summary(coupon("FLAT100"), false), /Total ₹900\.00/);
    assert.match(summary(coupon("FLAT100"), true), /Total ₹949\.00/);
  });
});

describe("page size", () => {
  it("offers exactly 20, 50 and 100 (20 is the default)", () => {
    assert.deepEqual([...PAGE_SIZES], [20, 50, 100]);
  });
});

describe("bulk deletion: two clearly different options", () => {
  const toolbar = (over: Partial<Parameters<typeof LeadSelectionToolbar>[0]> = {}) =>
    text(renderToStaticMarkup(<LeadSelectionToolbar count={20} onClear={() => {}} onDeletePage={() => {}} {...over} />));

  it("a page selection offers only 'Delete current page data'", () => {
    const t = toolbar();
    assert.match(t, /Delete current page data/);
    assert.doesNotMatch(t, /full matching data/);
  });
  it("when every matching lead is selected both options are shown, the all-matching one with its exact count", () => {
    const t = toolbar({ count: 56000, onDeleteMatching: () => {} });
    assert.match(t, /Delete current page data/);
    assert.match(t, /Delete all selected \/ full matching data \(56,000\)/);
  });
  it("no delete option at all for a caller who may not delete (Manager / Salesperson get no handler)", () => {
    const t = toolbar({ onDeletePage: undefined });
    assert.doesNotMatch(t, /Delete/);
  });
  it("the wording of the two options cannot be confused", () => {
    const page = bulkDeleteCopy("PAGE", 20);
    const all = bulkDeleteCopy("MATCHING", 56000);
    assert.match(page.scope, /Only the 20 leads selected on this page .* NOT touched/);
    assert.match(all.scope, /across ALL pages.*56,000 in total/);
    assert.notEqual(page.title, all.title);
  });
  it("the dialog opens on counting and cannot be confirmed before the server has returned the exact number", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <BulkDeleteLeadsDialog open onOpenChange={() => {}} mode="MATCHING" leadIds={[]} filter={{ segmentId: "s" }} onDone={() => {}} />
      </QueryClientProvider>,
    );
    // rendered in a portal on the client; on the server the dialog renders nothing visible, and never an enabled destructive button
    assert.ok(!/<button[^>]*>\s*Delete all matching leads\s*<\/button>/.test(html));
  });
});

describe("Delete All Leads (no filter)", () => {
  it("is a third, separate option with its own wording and the exact total", () => {
    const all = bulkDeleteCopy("ALL", 2577);
    assert.equal(all.title, "Delete ALL leads");
    assert.match(all.scope, /Every lead in the CRM, across all pages and page sizes, with no filter.*2,577 in total.*skipped/);
    assert.notEqual(all.title, bulkDeleteCopy("PAGE", 100).title);
    assert.notEqual(all.title, bulkDeleteCopy("MATCHING", 100).title);
  });
  it("is confirmed only by typing exactly DELETE ALL", () => {
    assert.equal(deleteAllConfirmed("DELETE ALL"), true);
    for (const wrong of ["", "delete all", "DELETE", "DELETE ALL ", " DELETE ALL", "DELETEALL"]) assert.equal(deleteAllConfirmed(wrong), false, JSON.stringify(wrong));
  });
});

describe("error messages are meaningful", () => {
  it("shows the backend's message when there is one, and says so when the server could not be reached", () => {
    const withMessage = new AxiosError("x", "ERR_BAD_REQUEST", undefined, undefined, { status: 409, data: { message: "A coupon with this code already exists" } } as never);
    assert.equal(getErrorMessage(withMessage), "A coupon with this code already exists");
    const noResponse = new AxiosError("Network Error", "ERR_NETWORK");
    assert.match(getErrorMessage(noResponse), /Cannot reach the server/);
    const bare500 = new AxiosError("x", "ERR_BAD_RESPONSE", undefined, undefined, { status: 500, data: "<html>" } as never);
    assert.match(getErrorMessage(bare500), /server error 500/);
    assert.equal(getErrorMessage(new Error("boom")), "Something went wrong.");
  });
});
