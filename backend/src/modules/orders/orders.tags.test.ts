import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchesAnyTag, mergeOrderTags, tagSearchClause } from "./orders.tags.js";

describe("mergeOrderTags", () => {
  it("no tags -> []; one tag; several tags keep Shopify's order", () => {
    assert.deepEqual(mergeOrderTags([], null), []);
    assert.deepEqual(mergeOrderTags(["COD"], null), ["COD"]);
    assert.deepEqual(mergeOrderTags(["COD", "VIP", "Fastrr"], undefined), ["COD", "VIP", "Fastrr"]);
  });
  it("adds the confirmation tag first, derived from the confirmer's name", () => {
    assert.deepEqual(mergeOrderTags(["COD", "VIP"], "Vini"), ["CRM Confirmed by Vini", "COD", "VIP"]);
    assert.deepEqual(mergeOrderTags([], "  Rahul  Sharma "), ["CRM Confirmed by Rahul Sharma"]);
  });
  it("never duplicates it (any case), and drops blanks and repeated tags", () => {
    assert.deepEqual(mergeOrderTags(["crm confirmed by vini", "COD"], "Vini"), ["CRM Confirmed by Vini", "COD"]);
    assert.deepEqual(mergeOrderTags(["COD", "cod", " ", "VIP"], null), ["COD", "VIP"]);
  });
  it("changing confirmer: Vini's tag is replaced by Rahul's, unrelated tags untouched", () => {
    assert.deepEqual(mergeOrderTags(["VIP", "CRM Confirmed by Vini", "COD"], "Rahul"), ["CRM Confirmed by Rahul", "VIP", "COD"]);
  });
  it("without a CRM confirmer Shopify's own tags are shown as they are (including a confirmation tag)", () => {
    assert.deepEqual(mergeOrderTags(["VIP", "CRM Confirmed by Vini"], null), ["VIP", "CRM Confirmed by Vini"]);
  });
});

describe("matchesAnyTag", () => {
  it("exact, case-insensitive, whole-tag match; OR across several; no wanted tags = everything", () => {
    assert.equal(matchesAnyTag(["COD", "VIP"], ["cod"]), true);
    assert.equal(matchesAnyTag(["COD-Verified"], ["COD"]), false);
    assert.equal(matchesAnyTag(["COD"], ["CO"]), false);
    assert.equal(matchesAnyTag(["Fastrr"], ["VIP", "Fastrr"]), true);
    assert.equal(matchesAnyTag(["Fastrr"], ["VIP", "COD"]), false);
    assert.equal(matchesAnyTag([], ["VIP"]), false);
    assert.equal(matchesAnyTag([], []), true);
  });
});

describe("tagSearchClause (Shopify search syntax)", () => {
  it("one tag, OR of several, quoting of spaces, escaping of quotes and backslashes; none -> null", () => {
    assert.equal(tagSearchClause([]), null);
    assert.equal(tagSearchClause(["COD"]), 'tag:"COD"');
    assert.equal(tagSearchClause(["COD", "VIP"]), '(tag:"COD" OR tag:"VIP")');
    assert.equal(tagSearchClause(["CRM Confirmed by Vini"]), 'tag:"CRM Confirmed by Vini"');
    assert.equal(tagSearchClause(['say "hi"']), 'tag:"say \\"hi\\""');
    assert.equal(tagSearchClause(["a\\b"]), 'tag:"a\\\\b"');
    assert.equal(tagSearchClause(["COD", "cod ", "COD"]), '(tag:"COD" OR tag:"cod")');
  });
});

describe("mergeOrderTags: the creator tag", () => {
  it("adds 'Order Created by <name>' once, keeps every Shopify tag, and leads with the confirmation tag", () => {
    assert.deepEqual(mergeOrderTags(["COD", "VIP"], "Vini", "Vini"), ["CRM Confirmed by Vini", "Order Created by Vini", "COD", "VIP"]);
    assert.deepEqual(mergeOrderTags(["COD"], null, "Vini"), ["Order Created by Vini", "COD"]);
  });
  it("never duplicates it when Shopify already holds it (any case), and does not touch other creator-style tags", () => {
    assert.deepEqual(mergeOrderTags(["order created by vini", "COD"], null, "Vini"), ["Order Created by Vini", "COD"]);
    assert.deepEqual(mergeOrderTags(["Order Created by Rahul"], null, "Vini"), ["Order Created by Vini", "Order Created by Rahul"]);
  });
  it("no creator -> no creator tag (nothing misleading is invented)", () => {
    assert.deepEqual(mergeOrderTags(["COD"], null, null), ["COD"]);
    assert.deepEqual(mergeOrderTags(["COD"], null, "   "), ["COD"]);
  });
});
