// Durable idempotency for manual order creation, proven ACROSS PROCESSES. Unlike the other DB tests these cannot run in a rolled-back transaction (a second
// process cannot see uncommitted rows), so each test commits real rows to the ISOLATED database (refused anywhere else) and removes them afterwards.
// Every "process" is a separate OS process (orders.idempotency.worker.ts) with its own Prisma client and connection pool, sharing only the database and a
// file-backed fake Shopify used to count how many Shopify orders were really created. Run with: npm run test:db
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "../../lib/prisma.js";
import { ProductType, Role } from "../../../generated/prisma/enums.js";

if (!/127\.0\.0\.1:5544\/crm_iso/.test(process.env.DATABASE_URL ?? "")) throw new Error("GUARD: the cross-process idempotency tests commit rows and run only against the isolated test database");

const BACKEND = path.resolve(import.meta.dirname, "../../..");
const WORKER = path.join(BACKEND, "src/modules/orders/orders.idempotency.worker.ts");
const TSX = path.join(BACKEND, "node_modules/tsx/dist/cli.mjs");
const tag = randomUUID().slice(0, 8);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idem-xproc-"));
const uid = () => randomUUID();

let admin: { id: string; username: string; role: Role };
let rep: { id: string; username: string; role: Role };
let stranger: { id: string; username: string; role: Role };
let leadId = "";
let productId = "";

before(async () => {
  const mk = (name: string, role: Role) => prisma.user.create({ data: { name, username: `${name.toLowerCase()}-${tag}`, role }, select: { id: true, username: true, role: true } });
  admin = await mk("XAdmin", Role.ADMIN);
  rep = await mk("XRep", Role.SALESPERSON);
  stranger = await mk("XStranger", Role.SALESPERSON);
  leadId = (await prisma.lead.create({ data: { leadNumber: `L-XP-${tag}`, firstName: "Xproc", mobile: "9000000777", normalizedMobile: "+919000000777", ownerId: rep.id }, select: { id: true } })).id;
  productId = (await prisma.product.create({ data: { name: `Xproc Tea ${tag}`, type: ProductType.PRODUCT, sku: `XP-${tag}`, basePrice: "100.00" }, select: { id: true } })).id;
});

after(async () => {
  try {
    const orders = await prisma.order.findMany({ where: { leadId }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.activity.deleteMany({ where: { OR: [{ orderId: { in: ids } }, { leadId }] } });
    await prisma.payment.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.order.deleteMany({ where: { id: { in: ids } } });
    await prisma.idempotencyKey.deleteMany({ where: { userId: { in: [admin.id, rep.id, stranger.id] } } });
    await prisma.lead.deleteMany({ where: { id: leadId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, rep.id, stranger.id] } } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await prisma.$disconnect();
  }
});

interface Answer { ok?: boolean; orderId?: string; shopify?: string; reason?: string; status?: number | null; message?: string; error?: string; exit: number | null }

/** Starts ONE independent backend process; resolves with what it answered (or exit code 9 when it died without answering). */
function spawnWorker(job: Record<string, unknown>): Promise<Answer> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, WORKER, JSON.stringify(job)], { cwd: BACKEND, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const line = out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
      resolve({ ...(line ? JSON.parse(line) : {}), exit: code });
    });
  });
}

const startIn = (ms = 7000) => Date.now() + ms;
const payload = (key: string, over: Record<string, unknown> = {}) => ({
  leadId, paymentMethod: "COD", idempotencyKey: key,
  items: [{ productId, quantity: 1, unitPrice: "100.00" }],
  shippingAddress: { name: "Xproc", line1: "1 Test Street", city: "Pune", state: "Maharashtra", pincode: "411001", phone: "9000000777", houseNumber: "1 Test Street", area: "Test Area" },
  ...over,
});
const job = (who: { id: string; username: string; role: Role }, input: Record<string, unknown>, shopifyFile: string, over: Record<string, unknown> = {}) => ({ user: who, action: "create", input, startAt: startIn(), shopifyFile, shopify: "slow", ...over });
const shopifyCreates = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0);
const ordersForKey = (key: string) => prisma.idempotencyKey.findMany({ where: { key } });
const orderCount = (ids: string[]) => prisma.order.count({ where: { id: { in: ids } } });

describe("order creation idempotency across independent backend processes", () => {
  it("the same key submitted at the same moment by TWO independent processes creates ONE order and ONE Shopify order; both get the same order", async () => {
    const key = `xp-two-${tag}-${uid()}`;
    const shop = path.join(dir, "two.jsonl");
    const [a, b] = await Promise.all([spawnWorker(job(rep, payload(key), shop)), spawnWorker(job(rep, payload(key), shop))]);
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    assert.equal(a.orderId, b.orderId, "both processes answer with the same order");
    assert.equal(await orderCount([a.orderId!]), 1);
    assert.equal((await ordersForKey(key)).length, 1, "one idempotency row");
    assert.equal(shopifyCreates(shop), 1, "ONE Shopify order across both processes");
    assert.equal(await prisma.order.count({ where: { leadId, metadata: { path: ["createdVia"], equals: "WHATSAPP_INBOX" }, id: a.orderId } }), 1);
    const row = (await ordersForKey(key))[0]!;
    assert.equal(row.status, "COMPLETED");
    assert.equal(row.orderId, a.orderId);
  });

  it("FIVE independent processes with one key: still exactly one order and one Shopify order", async () => {
    const key = `xp-five-${tag}-${uid()}`;
    const shop = path.join(dir, "five.jsonl");
    const answers = await Promise.all(Array.from({ length: 5 }, () => spawnWorker(job(rep, payload(key), shop, { startAt: startIn(9000) }))));
    assert.ok(answers.every((x) => x.ok), JSON.stringify(answers));
    assert.equal(new Set(answers.map((x) => x.orderId)).size, 1);
    assert.equal(await orderCount([answers[0]!.orderId!]), 1);
    assert.equal(shopifyCreates(shop), 1);
  });

  it("the same key with a DIFFERENT request is rejected (422) and never returns the other order; the original order is untouched", async () => {
    const key = `xp-diff-${tag}-${uid()}`;
    const shop = path.join(dir, "diff.jsonl");
    const first = await spawnWorker(job(rep, payload(key), shop, { shopify: "ok", startAt: startIn(3000) }));
    assert.ok(first.ok, JSON.stringify(first));
    const second = await spawnWorker(job(rep, payload(key, { items: [{ productId, quantity: 5, unitPrice: "100.00" }] }), shop, { shopify: "ok", startAt: startIn(3000) }));
    assert.equal(second.ok, false);
    assert.equal(second.status, 422);
    assert.match(second.message ?? "", /different order request/);
    assert.equal(await prisma.order.count({ where: { leadId, id: first.orderId } }), 1);
    const items = await prisma.orderItem.findMany({ where: { orderId: first.orderId! }, select: { quantity: true } });
    assert.deepEqual(items.map((i) => i.quantity), [1]);
    assert.equal((await ordersForKey(key)).length, 1);
  });

  it("a retry after a backend RESTART (the first process is long gone) returns the original order and creates nothing new", async () => {
    const key = `xp-restart-${tag}-${uid()}`;
    const shop = path.join(dir, "restart.jsonl");
    const first = await spawnWorker(job(rep, payload(key), shop, { shopify: "ok", startAt: startIn(3000) }));
    assert.ok(first.ok && first.exit === 0, JSON.stringify(first));
    const before = await prisma.order.count({ where: { leadId } });
    const retry = await spawnWorker(job(rep, payload(key), shop, { shopify: "ok", startAt: startIn(3000) }));
    assert.ok(retry.ok, JSON.stringify(retry));
    assert.equal(retry.orderId, first.orderId);
    assert.equal(await prisma.order.count({ where: { leadId } }), before, "no new order");
    assert.equal(shopifyCreates(shop), 1, "no new Shopify order");
  });

  it("the client times out while the server crashes AFTER committing the order: the retry (another process) finishes the original operation - one order, one Shopify order", async () => {
    const key = `xp-crash-${tag}-${uid()}`;
    const shop = path.join(dir, "crash.jsonl");
    const crashed = await spawnWorker(job(rep, payload(key), shop, { shopify: "ok", crashBeforeShopify: true, startAt: startIn(3000) }));
    assert.equal(crashed.exit, 9, "the process died without answering");
    const row = (await ordersForKey(key))[0]!;
    assert.equal(row.status, "ORDER_CREATED", "the order is committed but its follow-ups never ran");
    assert.equal(shopifyCreates(shop), 0);
    const retry = await spawnWorker(job(rep, payload(key), shop, { shopify: "ok", startAt: startIn(3000) }));
    assert.ok(retry.ok, JSON.stringify(retry));
    assert.equal(retry.orderId, row.orderId, "the ORIGINAL order");
    assert.equal(await prisma.order.count({ where: { leadId, id: row.orderId! } }), 1);
    assert.equal(shopifyCreates(shop), 1, "the Shopify order was created once, by the reconciling retry");
    assert.equal((await ordersForKey(key))[0]!.status, "COMPLETED");
    const again = await spawnWorker(job(rep, payload(key), shop, { shopify: "ok", startAt: startIn(3000) }));
    assert.equal(again.orderId, row.orderId);
    assert.equal(shopifyCreates(shop), 1, "a further retry adds nothing");
  });

  it("two processes retry the same interrupted request at once: the Shopify claim lets ONE create it", async () => {
    const key = `xp-claim-${tag}-${uid()}`;
    const shop = path.join(dir, "claim.jsonl");
    const crashed = await spawnWorker(job(rep, payload(key), shop, { shopify: "ok", crashBeforeShopify: true, startAt: startIn(3000) }));
    assert.equal(crashed.exit, 9);
    const [a, b] = await Promise.all([spawnWorker(job(rep, payload(key), shop, { shopify: "slow" })), spawnWorker(job(rep, payload(key), shop, { shopify: "slow" }))]);
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    assert.equal(a.orderId, b.orderId);
    assert.equal(shopifyCreates(shop), 1, "never two Shopify orders for one CRM order");
  });

  it("Shopify creates the order but the answer is LOST: the result says failed; the same-key retry (another process) finds that order by its source identifier and links it - no second Shopify order", async () => {
    const key = `xp-lost-${tag}-${uid()}`;
    const shop = path.join(dir, "lost.jsonl");
    const first = await spawnWorker(job(rep, payload(key), shop, { shopify: "lost", startAt: startIn(3000) }));
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.shopify, "failed", "never reported as a success");
    assert.equal(shopifyCreates(shop), 1, "Shopify did create it");
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: first.orderId! }, select: { externalId: true } })).externalId, null);
    const retry = await spawnWorker(job(rep, payload(key), shop, { shopify: "ok", startAt: startIn(3000) }));
    assert.ok(retry.ok, JSON.stringify(retry));
    assert.equal(retry.orderId, first.orderId);
    assert.equal(shopifyCreates(shop), 1, "the existing Shopify order was found and linked, not duplicated");
    assert.ok((await prisma.order.findUniqueOrThrow({ where: { id: first.orderId! }, select: { externalId: true } })).externalId, "now linked");
  });

  it("DIFFERENT keys are different legitimate orders (even simultaneously, from different processes)", async () => {
    const shop = path.join(dir, "distinct.jsonl");
    const [a, b] = await Promise.all([
      spawnWorker(job(rep, payload(`xp-d1-${tag}-${uid()}`), shop, { shopify: "ok" })),
      spawnWorker(job(rep, payload(`xp-d2-${tag}-${uid()}`), shop, { shopify: "ok" })),
    ]);
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    assert.notEqual(a.orderId, b.orderId);
    assert.equal(await orderCount([a.orderId!, b.orderId!]), 2);
    assert.equal(shopifyCreates(shop), 2);
  });

  it("another user's key: the same key string from a different user is a separate order (never the first user's), and a user without access to the lead gets 404 and no order", async () => {
    const key = `xp-user-${tag}-${uid()}`;
    const shop = path.join(dir, "users.jsonl");
    const mine = await spawnWorker(job(rep, payload(key), shop, { shopify: "ok", startAt: startIn(3000) }));
    assert.ok(mine.ok, JSON.stringify(mine));
    const theirs = await spawnWorker(job(stranger, payload(key), shop, { shopify: "ok", startAt: startIn(3000) }));
    assert.equal(theirs.ok, false);
    assert.equal(theirs.status, 404, "a salesperson who does not own the lead cannot create (or read) anything with it");
    assert.ok(!JSON.stringify(theirs).includes(mine.orderId!), "the first user's order id is never revealed");
    const adminOrder = await spawnWorker(job(admin, payload(key), shop, { shopify: "ok", startAt: startIn(3000) }));
    assert.ok(adminOrder.ok && adminOrder.orderId !== mine.orderId, "an admin with the same key string gets their own, different order");
    assert.equal((await prisma.idempotencyKey.findMany({ where: { key } })).length, 2, "one row per actor");
  });

  it("normal creation is unaffected: no key = a plain order; one key in one process = one order, and the row is COMPLETED", async () => {
    const shop = path.join(dir, "normal.jsonl");
    const noKey = payload("unused");
    delete (noKey as Record<string, unknown>).idempotencyKey;
    const plain = await spawnWorker(job(rep, noKey, shop, { shopify: "ok", startAt: startIn(3000) }));
    assert.ok(plain.ok, JSON.stringify(plain));
    assert.equal((await prisma.idempotencyKey.count({ where: { orderId: plain.orderId } })), 0, "no key, no ledger row");
    const key = `xp-one-${tag}-${uid()}`;
    const keyed = await spawnWorker(job(rep, payload(key), shop, { shopify: "ok", startAt: startIn(3000) }));
    assert.ok(keyed.ok && keyed.shopify === "created", JSON.stringify(keyed));
    assert.equal((await ordersForKey(key))[0]!.status, "COMPLETED");
  });

  it("two processes pushing the SAME unlinked order to Shopify (no idempotency key involved, e.g. two Retry clicks) create ONE Shopify order", async () => {
    const shop = path.join(dir, "push.jsonl");
    const first = await spawnWorker(job(rep, payload(`xp-push-${tag}-${uid()}`), shop, { shopify: "ok", crashBeforeShopify: true, startAt: startIn(3000) }));
    assert.equal(first.exit, 9);
    const row = (await prisma.idempotencyKey.findFirst({ where: { key: { startsWith: `xp-push-${tag}` } } }))!;
    const start = startIn(8000);
    const [a, b] = await Promise.all([
      spawnWorker({ user: rep, action: "push", orderId: row.orderId, startAt: start, shopifyFile: shop, shopify: "slow" }),
      spawnWorker({ user: rep, action: "push", orderId: row.orderId, startAt: start, shopifyFile: shop, shopify: "slow" }),
    ]);
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    assert.deepEqual([a.shopify, b.shopify].sort(), ["already_linked", "created"]);
    assert.equal(shopifyCreates(shop), 1);
  });
});
