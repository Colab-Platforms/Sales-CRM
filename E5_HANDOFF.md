# E5 Handoff — On-Call Order Booking (owner: Ranjan)

## Scope
Implement ONLY E5 (US-5.1..5.8) in Avatar India Sales CRM. Other epics are context. Deadline: ~2 days.
Two lead scenarios: (a) Shopify lead = customer already has website account; (b) Meta lead = no account.
Products/variants come from Shopify (grouped by collection). Pincode serviceability from Shiprocket.
Payment via Cashfree payment link, or COD.

## Working rules (MUST follow)
- One step at a time; explain each command; verify with `npx tsc --noEmit` (backend) before moving on.
- Commit small on `dev-ranjan`. Cannot push yet (GitHub account slayerranjan lacks Write access) —
  after each commit refresh backup: `git bundle create C:\Users\DELL\e5-backup.bundle dev-ranjan`.
- NEVER run `prisma migrate dev`, `prisma migrate reset`, `git reset --hard`, `git clean`, force push,
  or `npm audit fix --force`. Never paste/print secrets from .env.
- New migrations: edit schema -> create folder prisma/migrations/<timestamp>_<name> ->
  `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema --script --output <folder>/migration.sql`
  -> review SQL (additive only) -> `npx prisma migrate deploy` -> `npx prisma generate`.
  (`migrate dev --create-only` FAILS here: shadow replay hits vishwa's migration ordering bug.)
- Do not edit teammates' modules unless unavoidable; E5 lives in `backend/src/modules/orders/orders.booking.*`.

## Git / DB state
- Branch `dev-ranjan` = origin/dev-vishwa (fast-forwarded, includes main) + commits:
  d237c5a (E5 schema: Order.idempotencyKey unique, serviceabilityStatus, serviceabilityCheckedAt, enum ServiceabilityStatus)
  7d6c3bd (booking API: lead lookup, catalog, serviceability, quote)
- `backup/e5-schema-v1` branch = obsolete first attempt; ignore.
- DB = Ranjan's own Neon branch (host ep-fragrant-block-b3pp88tp). 14/14 migrations applied.
  Vishwa's migration 20260920084057_add_whatsapp_integration uses type activity_source before
  20260920113957_add_audit_trail creates it — fixed manually on this branch only; vishwa has been told.
- dev-komal deletes/renames applied migrations — must NOT merge to main as-is (team informed).
- Merge order later: vishwa merges to main first, then dev-ranjan.

## Reuse (vishwa's code) — do not duplicate
- Shopify: `new ShopifyClient(loadShopifyConfig())`, `client.query<unknown>(QUERY, vars)`, `parseOrFail(schema, data, label)` from shopify.orders.js.
- Shiprocket: `loadShiprocketConfig()` (fields: baseUrl, email, password, pickupLocation), `sharedTokenProvider(config).getToken()`.
- Cashfree: existing `POST /api/orders/:orderId/payment-links` + frontend `components/orders/payment-link-panel.tsx`, `send-payment-link-dialog.tsx`. Payment status updated by vishwa's Cashfree webhook.
- Leads: `getLeadScope(user)` (lib/leadScope), `normalizeMobile` (lib/leadIdentity), existing `POST /api/lead/leads` to create a lead.
- `validateSchema` returns `{ error, value }` — use the `valid()` helper in orders.booking.controller.ts.
- Models: Order has shippingAddress (Json), shippingPincode, metadata (Json), externalSource/externalId; Payment has paymentUrl/externalSource CASHFREE; OrderStatus DRAFT/PENDING_PAYMENT/CONFIRMED...; PaymentMethod includes COD; Lead/Product/Variant have externalSource/externalId.

## CRITICAL design decisions
- Vishwa's Shopify sync DELETES CRM rows tagged externalSource=SHOPIFY that it doesn't find.
  => E5 orders keep externalSource=null. Do NOT upsert Shopify products into local catalog tables.
  Store Shopify variant/product GIDs in Order.metadata (e.g. metadata.e5.items[]). OrderItem keeps name/variant/sku/price snapshots.
- Prices/availability ALWAYS re-read from Shopify server-side (resolveVariantForOrder). Money in integer paise.
- Serviceability: any error/timeout/missing config => UNKNOWN (never SERVICEABLE).
- Order status: PAYMENT_LINK => PENDING_PAYMENT (confirmed by Cashfree webhook); COD => CONFIRMED.
- Defaults until Ranjan decides: E5_MAX_DISCOUNT_PERCENT=0 (env); number owned by another salesperson => blocked, "ask your manager".
- Pushing orders/customers TO Shopify is a stretch goal; coordinate with vishwa first (his Shopify integration is documented as read-only).

## Done (backend, typechecks clean)
- GET  /api/orders/booking/leads?mobile=        (US-5.1/5.2: scoped lookup, existsForAnotherOwner, last shipping address)
- GET  /api/orders/booking/catalog?search=      (US-5.3: live Shopify products+variants+collections)
- GET  /api/orders/booking/serviceability?pincode=&cod=  (US-5.4)
- POST /api/orders/booking/quote                (US-5.5: {items:[{variantGid,quantity}], discountPercent, discountReason})
- Validators already include createBooking schema (leadId, idempotencyKey, customer, address, items, discount, paymentMethod, confirmed:true).

## Remaining
1. Test the 4 endpoints (start backend `npm run dev`; login via POST /api/auth/login; call with Bearer token).
2. POST /api/orders/booking/orders — US-5.7: idempotent create (return existing order if idempotencyKey exists; catch P2002),
   lead access via getLeadScope, re-quote server-side, block NOT_SERVICEABLE, store serviceability, shippingAddress Json,
   shippingPincode, items snapshots, metadata.e5, source=SALESPERSON, createdById, orderNumber unique, Activity ORDER_CREATED;
   COD => CONFIRMED + Payment(method COD, PENDING); PAYMENT_LINK => PENDING_PAYMENT.
3. US-5.8 on CONFIRMED: lead workingStatus CONVERTED, active InterestedLeadPeriod => CONVERTED, Activity ORDER_CONFIRMED,
   use vishwa's WhatsApp automation trigger if one exists for order confirmed. WhatsApp failure must never fail the order.
4. Frontend: read frontend/AGENTS.md + CLAUDE.md first. Page app/dashboard/orders/new (phone search -> customer/address ->
   products by section -> pincode badge -> live quote -> payment method -> review + confirm), "Create Order" action in
   components/leads/lead-table.tsx, reuse payment-link-panel. Follow lib/api-client pattern (endpoints/queries/mutations/types).
5. Test both scenarios, COD, payment link, duplicate click, invalid pincode, UNKNOWN serviceability, discount > max.

## Pending credentials (backend/.env only)
SHOPIFY_STORE_DOMAIN, SHOPIFY_ACCESS_TOKEN (needs read_products, read_inventory, read_customers; write_customers/write_orders only if Shopify push is done),
SHIPROCKET_ENABLED=true, SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD, SHIPROCKET_PICKUP_LOCATION, SHIPROCKET_PICKUP_PINCODE,
CASHFREE_ENABLED=true, CASHFREE_ENV=sandbox, CASHFREE_CLIENT_ID, CASHFREE_CLIENT_SECRET, PUBLIC_BACKEND_URL.
Vishwa is sending the Shopify + Shiprocket values.

## Next step
Start the backend (`npm run dev` in backend) and test the 4 booking endpoints, then build step 2 (create order).