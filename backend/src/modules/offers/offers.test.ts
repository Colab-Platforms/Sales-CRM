import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isActive, mapRule, toActiveOffers, extractRules } from "./offers.mapper.js";
import { loadFastrrConfig } from "./fastrr.config.js";
import OffersService, { CACHE_TTL_MS } from "./offers.service.js";

const NOW = new Date("2026-09-20T10:00:00.000Z");
const H = 3600_000;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const rule = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  couponCode: "PREPAID25",
  discountType: "percentage",
  active: true,
  couponConfig: { discountConfig: { discountPercentage: 25 } },
  discountMethod: { automaticDiscount: false },
  discountValidity: { startTime: iso(-24 * H), endTime: iso(10 * 24 * H) },
  discountCriteria: { minCartTotal: 999 },
  ...over,
});
const codes = (body: unknown) => toActiveOffers(body, NOW).map((o) => o.couponCode);

describe("active-offer rules", () => {
  it("active percentage coupon is mapped from Fastrr fields only", () => {
    const [o] = toActiveOffers([rule()], NOW);
    assert.equal(o!.couponCode, "PREPAID25");
    assert.equal(o!.discountType, "percentage");
    assert.equal(o!.discountValue, 25);
    assert.equal(o!.automaticDiscount, false);
    assert.equal(o!.minCartTotal, 999);
    assert.equal(o!.minQtyProduct, null, "absent fields are null, never fabricated");
    assert.equal(o!.expiringSoon, false);
  });
  it("active flat coupon and freebie", () => {
    const flat = toActiveOffers([rule({ couponCode: "FIRST100", discountType: "flat", couponConfig: { discountConfig: { discountFlat: 100 } } })], NOW)[0]!;
    assert.deepEqual([flat.discountType, flat.discountValue], ["flat", 100]);
    const free = toActiveOffers([rule({ couponCode: "FREEIMMUNE+FREEBEAUTY", discountType: "freebie", couponConfig: {} })], NOW)[0]!;
    assert.deepEqual([free.discountType, free.discountValue, free.couponCode], ["freebie", null, "FREEIMMUNE+FREEBEAUTY"]);
  });
  it("disabled, expired and future coupons are excluded", () => {
    assert.deepEqual(codes([rule({ couponCode: "OFF", active: false })]), []);
    assert.deepEqual(codes([rule({ couponCode: "OLD", discountValidity: { startTime: iso(-9 * H), endTime: iso(-1 * H) } })]), []);
    assert.deepEqual(codes([rule({ couponCode: "SOON", discountValidity: { startTime: iso(1 * H), endTime: iso(5 * H) } })]), []);
  });
  it("active must be exactly true (a truthy string is not enough)", () => {
    assert.deepEqual(codes([rule({ active: "true" }), rule({ active: undefined })]), []);
  });
  it("no-expiry active coupon is active; null, empty and missing endTime all mean no expiry", () => {
    assert.deepEqual(codes([rule({ discountValidity: { startTime: iso(-H), endTime: null } }), rule({ couponCode: "B", discountValidity: { startTime: iso(-H), endTime: "" } })]), ["PREPAID25", "B"]);
    assert.equal(toActiveOffers([rule({ discountValidity: { startTime: iso(-H) } })], NOW)[0]!.endTime, null);
  });
  it("boundaries: now == startTime and now == endTime are both active", () => {
    assert.equal(isActive({ active: true, startTime: NOW.toISOString(), endTime: null }, NOW), true);
    assert.equal(isActive({ active: true, startTime: null, endTime: NOW.toISOString() }, NOW), true);
  });
  it("an unreadable date excludes the offer instead of guessing", () => {
    assert.deepEqual(codes([rule({ discountValidity: { startTime: "not-a-date", endTime: null } })]), []);
  });
  it("expiring soon: ends within 48h; ends later is not", () => {
    const soon = toActiveOffers([rule({ discountValidity: { startTime: iso(-H), endTime: iso(47 * H) } })], NOW)[0]!;
    const later = toActiveOffers([rule({ discountValidity: { startTime: iso(-H), endTime: iso(49 * H) } })], NOW)[0]!;
    assert.equal(soon.expiringSoon, true);
    assert.equal(later.expiringSoon, false);
  });
  it("multiple active coupons, soonest expiry first, no-expiry last", () => {
    const out = codes([
      rule({ couponCode: "NOEXP", discountValidity: { startTime: iso(-H), endTime: null } }),
      rule({ couponCode: "LATE", discountValidity: { startTime: iso(-H), endTime: iso(30 * 24 * H) } }),
      rule({ couponCode: "EARLY", discountValidity: { startTime: iso(-H), endTime: iso(2 * H) } }),
    ]);
    assert.deepEqual(out, ["EARLY", "LATE", "NOEXP"]);
  });
  it("epoch seconds and milliseconds are understood", () => {
    const sec = Math.floor((NOW.getTime() - H) / 1000);
    assert.equal(mapRule(rule({ discountValidity: { startTime: sec, endTime: NOW.getTime() + H } }))!.startTime, iso(-H));
  });
  it("empty list is empty (not an error); an unknown body shape is an error", () => {
    assert.deepEqual(codes([]), []);
    assert.deepEqual(codes({ data: [] }), []);
    assert.throws(() => extractRules({ message: "hello" }), /unexpected shape/);
  });
});

describe("OffersService (mocked Fastrr - the real API is never called)", () => {
  const config = () => loadFastrrConfig({ FASTRR_API_BASE_URL: "https://fastrr.example.test/", FASTRR_API_TOKEN: "tok-secret-123" });
  type Call = { url: string; auth: string | null };
  const okFetch = (body: unknown, calls: Call[]) =>
    (async (url: string, init: any) => {
      calls.push({ url, auth: init.headers.Authorization ?? null });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

  it("calls GET /fastrr/promotion/discounts with the Bearer token, server-side only", async () => {
    const calls: Call[] = [];
    const svc = new OffersService({ config, fetchImpl: okFetch([rule()], calls), now: () => NOW });
    const r = await svc.getActiveOffers();
    assert.equal(calls[0]!.url, "https://fastrr.example.test/fastrr/promotion/discounts");
    assert.equal(calls[0]!.auth, "Bearer tok-secret-123");
    assert.ok(!JSON.stringify(r).includes("tok-secret-123"), "no credential in the CRM response");
  });
  it("caches: a second read inside the TTL makes no second Fastrr call; after the TTL it refetches", async () => {
    const calls: Call[] = [];
    let t = NOW.getTime();
    const svc = new OffersService({ config, fetchImpl: okFetch([rule()], calls), now: () => new Date(t) });
    await svc.getActiveOffers();
    await svc.getActiveOffers();
    assert.equal(calls.length, 1);
    t += CACHE_TTL_MS + 1;
    await svc.getActiveOffers();
    assert.equal(calls.length, 2);
  });
  it("concurrent first loads share one Fastrr request", async () => {
    const calls: Call[] = [];
    const svc = new OffersService({ config, fetchImpl: okFetch([rule()], calls), now: () => NOW });
    await Promise.all([svc.getActiveOffers(), svc.getActiveOffers(), svc.getActiveOffers()]);
    assert.equal(calls.length, 1);
  });
  it("active is re-judged on the server clock on every read, even when served from cache", async () => {
    let t = NOW.getTime();
    const svc = new OffersService({ config, fetchImpl: okFetch([rule({ discountValidity: { startTime: iso(-H), endTime: iso(30_000) } })], []), now: () => new Date(t) });
    assert.equal((await svc.getActiveOffers()).offers.length, 1);
    t += 60_000; // 1 min later: still inside the 2 min cache, but the offer ended 30s after NOW
    assert.equal((await svc.getActiveOffers()).offers.length, 0);
  });
  it("Fastrr failure: a safe 502 message, nothing cached, next call retries", async () => {
    let n = 0;
    const flaky = (async () => (++n === 1 ? new Response(JSON.stringify({ message: "boom" }), { status: 500 }) : new Response(JSON.stringify([rule()]), { status: 200 }))) as unknown as typeof fetch;
    const svc = new OffersService({ config, fetchImpl: flaky, now: () => NOW });
    await assert.rejects(() => svc.getActiveOffers(), (e: any) => e.statusCode === 502 && e.message === "Unable to load active offers from Fastrr.");
    assert.equal((await svc.getActiveOffers()).offers.length, 1);
  });
  it("network error and malformed body both give the same safe error", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await assert.rejects(() => new OffersService({ config, fetchImpl: down, now: () => NOW }).getActiveOffers(), (e: any) => e.statusCode === 502);
    const bad = (async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(() => new OffersService({ config, fetchImpl: bad, now: () => NOW }).getActiveOffers(), (e: any) => e.statusCode === 502);
  });
  it("empty Fastrr response gives an empty offer list", async () => {
    const svc = new OffersService({ config, fetchImpl: okFetch([], []), now: () => NOW });
    assert.deepEqual((await svc.getActiveOffers()).offers, []);
  });
  it("missing configuration: 503 naming the variables (never values), and no request is made", async () => {
    let called = false;
    const svc = new OffersService({
      config: () => loadFastrrConfig({}),
      fetchImpl: (async () => {
        called = true;
        return new Response("[]");
      }) as unknown as typeof fetch,
    });
    await assert.rejects(() => svc.getActiveOffers(), (e: any) => e.statusCode === 503 && /FASTRR_API_BASE_URL/.test(e.message) && /FASTRR_API_TOKEN/.test(e.message));
    assert.equal(called, false);
    assert.throws(() => loadFastrrConfig({ FASTRR_API_BASE_URL: "http://insecure.test", FASTRR_API_TOKEN: "x" }), /must be an https URL/);
  });
});
