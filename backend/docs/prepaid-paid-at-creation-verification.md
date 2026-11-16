# Prepaid orders created PAID in Shopify - controlled verification and release

## What changed
A CRM **prepaid** order whose payment is already verified (Cashfree or manual) and whose CRM figures add up is created in Shopify as `PAID`, with one `SALE` / `SUCCESS` payment transaction for exactly the CRM total (gateway `Cashfree` or `manual`). Before, it was created unpaid and marked paid a few seconds later; Shiprocket imports an order the moment Shopify creates it, fixes COD / Prepaid from that state and never revises it, so about 1.2% of prepaid orders became COD in Shiprocket.

Unchanged: COD orders (created pending, no transaction), unpaid or unverified payments (never created paid), website orders, sync ON/OFF behaviour. If Shopify refuses the payment transaction (message mentions payment / transaction / gateway / provider), the CRM retries once exactly as before (created unpaid, settled afterwards).

## Before you start
- Deploy the build to production (there is no staging Shopify). The change is code only: **no database migration** is needed for this fix.
- Use real but harmless orders: one low-value PREPAID and one COD order for an internal test lead (your own number). Both create a real Shopify order and Shiprocket will import them. Do **not** ship them; cancel both afterwards in the CRM (a cancelled order shows in Shiprocket as Prepaid at 0.00 - expected, see the mismatch report).
- Check the CRM's own Shiprocket auto-submit is off for these orders, or expect a Shiprocket duplicate pair (use the duplicate report to confirm none is created).
- A tester needs backend access to run the verifier (read-only): `npm run order:verify-payment -- <CRM order number>`.

## Test order specification (both orders identical except payment)
- Lead: new, name `ZZ TEST - DO NOT SHIP`, the tester's own phone and address; source `Test`. Creator: the `Test2` salesperson, WhatsApp Inbox.
- ONE custom item (itemType CUSTOM): name `ZZ TEST - DO NOT SHIP`, quantity 1, unit price `1.00`, not taxable, requires shipping (so Shiprocket imports it), weight 0.1 kg. Do NOT use a catalogue product.
- No discount: the Create Order screen pre-selects the default fixed discount (50); choose "no discount", otherwise the order is invalid. Shipping charge 0. Order total must be exactly 1.00, so the CRM figures add up and the paid-at-creation path applies.
- Order note: `LIVE VERIFICATION TEST - cancel after check`.
- Prepaid: create a Cashfree payment link from the order; its amount is always the order's outstanding balance (1.00), never a free choice. Pay the ₹1 link. The Shopify SALE transaction must also be exactly 1.00.
- COD: same order, COD, no payment recorded.
- Known possible outcome: ₹1 orders were previously refused by this shop with "Payment provider is not configured". If Shopify refuses the transaction, the CRM falls back to the old path (created unpaid). That is the designed fallback, not a code failure; the verifier will then report FAIL on "PAID" and the finding is a Shopify payment-provider configuration limit.
- Before the test: Shiprocket auto-submit (`SHIPROCKET_ENABLED`) temporarily off in Render, courier auto-assignment off in the Shiprocket dashboard, Shopify sync ON.

## Test 1 - prepaid
1. Create the order from the CRM (WhatsApp Inbox, "payment already received"/manual verification, or a Cashfree link paid for the lowest amount).
2. Immediately note the CRM order number, then run `npm run order:verify-payment -- CRM-XXXXXXXX-XXXX`.
3. Expected PASS on every line:
   - Shopify financial status PAID; exactly ONE SALE transaction, SUCCESS, for the CRM total; recorded within 3 s of the order's creation; nothing outstanding;
   - the CRM order records `shopifyPaidAtCreation` (no mark-as-paid call: the order's payment sync shows `performed: already_paid_at_creation`);
   - Shiprocket has exactly one order for the Shopify order name, payment mode **Prepaid**. Shiprocket may need a few minutes to import: rerun until it appears. On the Shiprocket order page confirm the COD amount is 0.
4. Stop and report if any line FAILS. The fix is switched off by reverting the deploy; orders then go back to the old (create unpaid, then mark paid) path.

## Test 2 - COD
1. Create a COD order for the same test lead.
2. Run the verifier. Expected PASS: no payment transaction, Shopify not paid, full total outstanding, Shiprocket payment mode COD with the same amount.

## Repeat-safety checks (read-only)
- A second Shopify order was not created: search Shopify for the CRM order number (`sourceIdentifier`).
- Open the order in the CRM and press "Retry Shopify payment sync": it must say synced and Shopify must still show ONE SALE transaction.

## Existing mismatches (do not change shipments)
`npm run shiprocket:payment-mismatch -- --since 2026-10-20 --until <today>` is read-only. Five genuine historical cases were found (AWL105830, AWL108029, AWL108916, AWL112541, AWL112561); none has a handling note in the CRM. Shipped / delivered / RTO orders are never changed in Shiprocket: delivered ones go to COD-remittance reconciliation and customer refund review; undelivered ones go to Shiprocket support with the Shopify PAID evidence.

## Tracking for Shopify-channel shipments
The CRM only tracks shipments it created. `npm run shiprocket:sync -- --dry-run --since D --until D` (then, after approval, without `--dry-run`) imports existing Shiprocket shipments into the CRM matched by the exact order reference (Shiprocket channel order id against the CRM order number or Shopify order number, never by phone). It writes only Shipment rows and never touches payments.

## Release steps
1. Approve and commit; deploy to production (no migration for this fix; the separate Fastrr recovery migration is independent).
2. Run Test 1 and Test 2 above. Keep the verifier output.
3. Watch the next day's prepaid orders: rerun the mismatch report; the prepaid-as-COD count should stay at zero.
4. Rollback: redeploy the previous build. No data changes are involved.
