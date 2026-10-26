# Shopify website orders: keeping the feed current

The Orders Dashboard's Website Orders only shows what the CRM database holds. Orders reach it three ways; all use the same idempotent upsert keyed on the stable Shopify order id (`externalSource = SHOPIFY`, `externalId`), so none can create a duplicate.

| Path | What it needs | Notes |
|---|---|---|
| Webhooks `orders/create`, `orders/updated`, ... to `POST /api/webhooks/shopify` | `SHOPIFY_WEBHOOK_SECRET`, webhooks registered in Shopify admin, `SHOPIFY_SYNC_ENABLED=true` | HMAC-SHA256 over the raw body is checked; each delivery id is stored once in `webhook_events` (a replay is acknowledged, not re-processed); a failed processing is recorded on the event and retried by the background worker. With `SHOPIFY_SYNC_ENABLED=false` deliveries are only recorded. |
| Catch-up poll | `SHOPIFY_SYNC_ENABLED=true` (and `DISABLE_BACKGROUND_JOBS` not `true`) | Every `SHOPIFY_SYNC_POLL_MINUTES` (15) re-reads orders changed in the last `SHOPIFY_SYNC_POLL_LOOKBACK_HOURS` (24, max 336). It repairs a missed webhook; it is NOT a backfill for a longer outage. |
| Manual / backfill: `npm run shopify:sync` | Shopify credentials only | Read from Shopify; writes CRM orders. Run `--dry-run` first (it prints the window, how many orders Shopify holds in it and a sample; it writes nothing and cannot be combined with `--all`). Use `--since` / `--until` to import a window. |

## What a sync never changes
An update of an existing order refreshes Shopify-owned fields only. `source`, the telecaller (`createdById`), `metadata` (payment mode, CRM notes) and CRM-side payment / cancellation state are not overwritten, so a telecaller order that was pushed to Shopify stays a Telecaller order. A Shopify order that is new to the CRM becomes `source = SHOPIFY` (a website order).

## How the dashboard decides a period is complete
For every period (cards, previous period, each chart bucket) the dashboard asks Shopify, read-only, how many orders were created in it (`ordersCount`, cached 5 min) and compares with the CRM's count of Shopify-id orders:

- Shopify count 0: a real zero.
- CRM holds none but Shopify has some: **No data** (never a zero).
- CRM holds >= 98%: complete. Otherwise **Partial**, and the page warns "Shopify has X orders for this period but the CRM holds Y".
- Shopify unreachable: never claimed complete (at most Partial).

Comparison percentages appear only when both periods are complete.

## Making the data current (needs approval; production)
1. Backfill the gap: `npm run shopify:sync -- --dry-run --since <date>`, review the count, then `npm run shopify:sync -- --since <date> --all`. Work month by month (`--since` / `--until`) for long gaps.
2. Set `SHOPIFY_SYNC_ENABLED=true` on the API service and redeploy, so the catch-up poll and webhook worker run.
3. Register the Shopify order webhooks to `/api/webhooks/shopify` with the same secret as `SHOPIFY_WEBHOOK_SECRET`.
4. Apply the pending migration `20261029000000_orders_created_at_index`.

Check afterwards: the Orders Dashboard's Website Orders warning disappears for yesterday, and `webhook_events` gains `SHOPIFY` rows.
