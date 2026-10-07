// The live Shopify page is only used for an order with NO CRM Order row. A customer matched to a CRM lead must never read as the order being synced.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveCrmStatus } from "./live-order-detail-view";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const link = { leadId: "l1", leadNumber: "L-1", owner: null };

describe("live order page CRM status", () => {
  it("customer linked to a lead: the ORDER is still shown as not in the CRM", () => {
    const t = text(renderToStaticMarkup(<LiveCrmStatus crmLink={link} />));
    assert.match(t, /Order not in CRM/);
    assert.match(t, /Customer linked to CRM/);
    assert.doesNotMatch(t, /Synced to CRM|CRM Synced/);
  });
  it("no matching lead: both are stated plainly", () => {
    const t = text(renderToStaticMarkup(<LiveCrmStatus crmLink={null} />));
    assert.match(t, /Order not in CRM/);
    assert.match(t, /Customer not linked to CRM/);
    assert.doesNotMatch(t, /Synced to CRM|CRM Synced/);
  });
});
