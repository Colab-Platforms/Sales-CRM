// Development-only sample orders so the E6 Orders screens have something to show.
//
//   npm run db:seed:dev-orders -- --confirm     add sample orders
//   npm run db:seed:dev-orders -- --cleanup     remove exactly what this script added
//
// It only ever ADDS rows whose identifiers start with "DEV-" (orders, products, variants,
// payment references) and attaches them to leads that already exist; it never edits or
// deletes anything else. It refuses to run with NODE_ENV=production.
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import type { DbClient } from "../src/lib/leadScope.js";
import {
  ActivityType,
  OrderSource,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  ProductType,
} from "../generated/prisma/enums.js";

const PREFIX = "DEV-";
const ORDER_COUNT = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const PRODUCTS = [
  { sku: "DEV-WHEY", name: "Whey Protein (sample)", price: 2499, variants: [{ sku: "DEV-WHEY-CHOC", name: "Chocolate" }, { sku: "DEV-WHEY-VAN", name: "Vanilla" }] },
  { sku: "DEV-CREATINE", name: "Creatine Monohydrate (sample)", price: 999, variants: [{ sku: "DEV-CREATINE-UNF", name: "Unflavoured" }] },
];

// One template per order, cycled: the order's status and the payment attempts it carries.
const TEMPLATES: { status: OrderStatus; payments: PaymentStatus[] }[] = [
  { status: OrderStatus.DRAFT, payments: [] },
  { status: OrderStatus.PENDING_PAYMENT, payments: [PaymentStatus.PENDING] },
  { status: OrderStatus.CONFIRMED, payments: [PaymentStatus.SUCCESS] },
  { status: OrderStatus.PROCESSING, payments: [PaymentStatus.SUCCESS] },
  { status: OrderStatus.CANCELLED, payments: [PaymentStatus.FAILED] },
  { status: OrderStatus.RETURNED, payments: [PaymentStatus.REFUNDED] },
  { status: OrderStatus.CONFIRMED, payments: [PaymentStatus.FAILED, PaymentStatus.SUCCESS] },
  { status: OrderStatus.REFUNDED, payments: [PaymentStatus.PARTIALLY_REFUNDED] },
];

const round = (n: number) => n.toFixed(2);

export async function countDevOrders(db: DbClient): Promise<number> {
  return db.order.count({ where: { orderNumber: { startsWith: PREFIX } } });
}

export async function seedDevOrders(db: DbClient): Promise<{ orders: number; products: number; leadsUsed: number }> {
  if (await countDevOrders(db)) {
    throw new Error("Sample orders already exist. Run with --cleanup first if you want to re-seed.");
  }

  const leads = await db.lead.findMany({ select: { id: true, ownerId: true }, orderBy: { createdAt: "asc" }, take: 10 });
  if (leads.length === 0) {
    throw new Error("There are no leads to attach sample orders to. Create a lead first.");
  }

  const variants: { productId: string; variantId: string; product: string; variant: string; sku: string; price: number }[] = [];
  for (const def of PRODUCTS) {
    const product = await db.product.create({
      data: { name: def.name, type: ProductType.PRODUCT, sku: def.sku, basePrice: round(def.price) },
    });
    for (const v of def.variants) {
      const variant = await db.productVariant.create({
        data: { productId: product.id, name: v.name, sku: v.sku, price: round(def.price) },
      });
      variants.push({ productId: product.id, variantId: variant.id, product: def.name, variant: v.name, sku: v.sku, price: def.price });
    }
  }

  const now = Date.now();
  for (let i = 0; i < ORDER_COUNT; i++) {
    const lead = leads[i % leads.length];
    const template = TEMPLATES[i % TEMPLATES.length];
    const source = [OrderSource.SALESPERSON, OrderSource.WEBSITE, OrderSource.API][i % 3];
    // Website/API orders have no booking salesperson, like real ones will.
    const createdById = source === OrderSource.SALESPERSON ? lead.ownerId : null;
    const createdAt = new Date(now - (i * 1.5 + 0.2) * DAY_MS);

    const lines = Array.from({ length: 1 + (i % 2) }, (_, k) => {
      const pick = variants[(i + k) % variants.length];
      const quantity = 1 + ((i + k) % 3);
      const gross = pick.price * quantity;
      const discount = i % 4 === 0 ? 100 : 0;
      const tax = (gross - discount) * 0.18;
      return { pick, quantity, gross, discount, tax, total: gross - discount + tax };
    });
    const subtotal = lines.reduce((s, l) => s + l.gross, 0);
    const discountAmount = lines.reduce((s, l) => s + l.discount, 0);
    const taxAmount = lines.reduce((s, l) => s + l.tax, 0);
    const shippingAmount = 49;
    const totalAmount = lines.reduce((s, l) => s + l.total, 0) + shippingAmount;
    const placed = template.status !== OrderStatus.DRAFT;
    const confirmed = [OrderStatus.CONFIRMED, OrderStatus.PROCESSING, OrderStatus.RETURNED, OrderStatus.REFUNDED].includes(template.status as never);

    const order = await db.order.create({
      data: {
        orderNumber: `${PREFIX}ORD-${String(i + 1).padStart(4, "0")}`,
        leadId: lead.id,
        createdById,
        source,
        status: template.status,
        subtotal: round(subtotal),
        discountAmount: round(discountAmount),
        taxAmount: round(taxAmount),
        shippingAmount: round(shippingAmount),
        totalAmount: round(totalAmount),
        discountReason: discountAmount > 0 ? "Sample launch offer" : null,
        createdAt,
        placedAt: placed ? createdAt : null,
        confirmedAt: confirmed ? new Date(createdAt.getTime() + 15 * 60 * 1000) : null,
        cancelledAt: template.status === OrderStatus.CANCELLED ? new Date(createdAt.getTime() + 60 * 60 * 1000) : null,
        items: {
          create: lines.map((l) => ({
            productId: l.pick.productId,
            variantId: l.pick.variantId,
            productNameSnapshot: l.pick.product,
            variantNameSnapshot: l.pick.variant,
            skuSnapshot: l.pick.sku,
            quantity: l.quantity,
            unitPrice: round(l.pick.price),
            discountAmount: round(l.discount),
            taxAmount: round(l.tax),
            totalPrice: round(l.total),
          })),
        },
        payments: {
          create: template.payments.map((status, j) => {
            const at = new Date(createdAt.getTime() + (j + 1) * 5 * 60 * 1000);
            return {
              status,
              provider: "dev-sample",
              method: [PaymentMethod.UPI, PaymentMethod.CARD, PaymentMethod.PAYMENT_LINK][(i + j) % 3],
              amount: round(totalAmount),
              transactionReference: `${PREFIX}TXN-${String(i + 1).padStart(4, "0")}-${j + 1}`,
              createdAt: at,
              paidAt: status === PaymentStatus.SUCCESS ? at : null,
              failedAt: status === PaymentStatus.FAILED ? at : null,
              failureReason: status === PaymentStatus.FAILED ? "Sample: payment declined" : null,
              refundedAt: status === PaymentStatus.REFUNDED || status === PaymentStatus.PARTIALLY_REFUNDED ? at : null,
            };
          }),
        },
      },
    });

    if (confirmed) {
      await db.activity.create({
        data: {
          leadId: lead.id,
          actorId: lead.ownerId,
          type: ActivityType.ORDER_CONFIRMED,
          referenceType: "Order",
          referenceId: order.id,
          title: "Order confirmed",
          createdAt: new Date(createdAt.getTime() + 15 * 60 * 1000),
        },
      });
    }
  }

  return { orders: ORDER_COUNT, products: PRODUCTS.length, leadsUsed: Math.min(leads.length, ORDER_COUNT) };
}

export async function cleanupDevOrders(db: DbClient): Promise<{ orders: number; products: number }> {
  const orders = await db.order.findMany({ where: { orderNumber: { startsWith: PREFIX } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);

  await db.activity.deleteMany({ where: { referenceType: "Order", referenceId: { in: orderIds } } });
  await db.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await db.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await db.order.deleteMany({ where: { id: { in: orderIds } } });
  await db.productVariant.deleteMany({ where: { sku: { startsWith: PREFIX } } });
  const products = await db.product.deleteMany({ where: { sku: { startsWith: PREFIX } } });

  return { orders: orderIds.length, products: products.count };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const host = new URL(process.env.DATABASE_URL ?? "postgresql://unset").host;

  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run: NODE_ENV is production.");
  }
  if (!args.has("--confirm") && !args.has("--cleanup")) {
    console.log(`Dry run. Target database host: ${host}`);
    console.log(`Would add ${ORDER_COUNT} sample orders (order numbers start with "${PREFIX}") on existing leads.`);
    console.log("Re-run with --confirm to add them, or --cleanup to remove them.");
    return;
  }

  console.log(`Database host: ${host}`);
  if (args.has("--cleanup")) {
    console.log("Removed:", await prisma.$transaction((tx) => cleanupDevOrders(tx)));
  } else {
    console.log("Added:", await prisma.$transaction((tx) => seedDevOrders(tx), { timeout: 120_000 }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
