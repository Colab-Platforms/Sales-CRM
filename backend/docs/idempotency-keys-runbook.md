# Runbook: `idempotency_keys` (order-creation idempotency) — deploy and rollback

Migration: `prisma/migrations/20261016000000_add_idempotency_keys` (one new table, two indexes; **additive only** — no existing table or column is touched).

## What changed at runtime
- `POST /orders` with an `idempotencyKey` now writes an `idempotency_keys` row **in the same transaction** as the order. The unique index `(user_id, operation, key)` is what stops two simultaneous requests (any process/server) from creating two orders.
- Same key + same request → the original order. Same key + different request → HTTP 422. An interrupted request (crash, timeout, lost Shopify answer) is reconciled by the retry, never repeated.
- Only one caller at a time may create the Shopify order for a CRM order (a claim stored on the order row, `metadata.shopifyPushClaimedAt`, 10-minute lease; a taken-over claim always looks the order up by its source identifier first).
- Requests **without** a key behave exactly as before.

## Before deploying
1. `npx prisma migrate status` against the target database. Expect exactly one pending migration: `20261016000000_add_idempotency_keys`. Anything else pending, or any "failed"/"drift" message: **stop** and reconcile first (do not use `migrate resolve`/`reset` on a shared database without a backup and a second pair of eyes).
2. Optional read-only check: `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema --script` should print only the `idempotency_keys` table and its two indexes.
3. Take the platform's usual database snapshot/backup.

## Deploy (zero-downtime order)
1. `npx prisma migrate deploy` (creates the table; the previous release ignores it, so this is safe to run first).
2. Deploy the new backend release. All instances may run at once; the database unique index is the final arbiter.
3. Deploy the frontend (it already sends one key per order attempt).
4. Optional retention job (OFF unless set): `IDEMPOTENCY_PRUNE_HOURS=24` (+ `IDEMPOTENCY_RETENTION_DAYS`, default 30, minimum 2; `IDEMPOTENCY_PRUNE_BATCH`, default 500, maximum 5000). Set it on the deployed server only. It removes finished rows past retention and never a row whose order may still need reconciling.

## Verify after deploy
- Create an order from the UI; `select status, order_id from idempotency_keys order by created_at desc limit 1;` → `COMPLETED`.
- Re-submit the same order (browser retry) → same order number, no second order.
- `select count(*) from idempotency_keys where status <> 'COMPLETED' and created_at < now() - interval '1 hour';` should stay at (or near) 0; rows here are interrupted requests waiting for a retry to reconcile them.

## Rollback — read this before relying on it
- **Application rollback** to the previous release is safe: the old code does not read or write the table, so leaving the table in place is harmless. During such a rollback the previous release again uses its own process-local duplicate guard only (no cross-process protection) — that is the behaviour you are rolling back to.
- **Do not drop the table casually.** Dropping it removes the record that lets a late retry of an interrupted order creation be reconciled instead of repeated, and it is irreversible without a backup. If you must remove it, first make sure no request with a key is still in flight and no `status <> 'COMPLETED'` rows exist, then take a backup.
- A schema rollback is **not** automatic and is **not** guaranteed safe: there is no "down" migration. If the migration must be undone, run `DROP TABLE "idempotency_keys";` manually, only after the application release that uses it is no longer running, and record it in the migration ledger deliberately.
- If `migrate deploy` fails midway, the migration is a single `CREATE TABLE` plus two `CREATE INDEX` statements: check `\d idempotency_keys`, and use Prisma's `migrate resolve` only after inspecting the real state.
