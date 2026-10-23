# Cashfree sandbox test of the dynamic UPI QR

A separate, isolated process. It never reads the production `backend/.env`, never touches the production database, and the app itself refuses to start if anything could reach production.

## What you need
1. **A throw-away database**, never the production Neon database: a separate Neon project/branch, or a local Postgres, whose database name contains `sandbox`, `test` or `iso`. Apply the schema yourself: `DATABASE_URL=<that url> npx prisma migrate deploy` (a migration of the sandbox database only).
2. **Cashfree sandbox keys** (Cashfree dashboard, *Test* environment, Developers, API Keys) and **S2S / Order Pay UPI QR enabled** on the sandbox account (ask Cashfree support; their docs state "To use this API S2S flag needs to be enabled from the backend").
3. **A public https address for the sandbox backend** (for example a tunnel) and that address plus `/api/webhooks/cashfree` registered as the webhook in the sandbox dashboard.
4. A sandbox login user in the sandbox database, to create a prepaid order.

## Setup
1. Copy `backend/.env.sandbox.example` to `backend/.env.sandbox.local` (git-ignored) and fill it in. Do **not** copy anything from `.env`.
2. Start it in a **new** PowerShell window (so the sandbox variables never leak into your normal shell):
   `powershell -NoProfile -File .\sandbox\start-sandbox.ps1 -CheckOnly` validates the configuration and stops. No server, no network.
   Without `-CheckOnly` it starts the server on `PORT`.

## What the guard refuses (`src/modules/cashfree/cashfree.sandbox-guard.ts`)
`CASHFREE_ENV` not explicitly `sandbox`; a production Cashfree URL or `CASHFREE_UPI_QR_ALLOW_PRODUCTION=true`; a database on the production Neon host (`ep-gentle-rice-b3jims4e`, plus `CRM_PRODUCTION_DB_HOSTS`) or one that is neither local nor named sandbox / test / iso; a `WHATSAPP_PROVIDER`; `SHOPIFY_SYNC_ENABLED=true`; a missing or non-https `PUBLIC_BACKEND_URL` (or one in `CRM_PRODUCTION_BACKEND_HOSTS`); the QR or Cashfree switched off; `CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED` missing. The same check runs inside `loadCashfreeConfig`, so no Cashfree call can be made by a misconfigured sandbox process, and its webhook endpoint accepts nothing. Messages name variables only, never values.

It cannot tell a sandbox key from a production key (Cashfree documents no reliable prefix), hence the explicit `CASHFREE_SANDBOX_CREDENTIALS_CONFIRMED`.

## The first network requests (all to https://sandbox.cashfree.com/pg, nothing else)
Creating the prepaid order itself first makes the existing `POST /links` (payment link) request. Then, for that payment, in this order: `GET /orders/qr_<paymentId>` (404 expected), `POST /orders` (Create Order), `POST /orders/sessions` (Order Pay, `payment_method.upi.channel = "qrcode"`). Later, if you pay it with the sandbox UPI test flow: `GET /orders/{id}` and `GET /orders/{id}/payments` (verification), and on settle / cancel `POST /links/{id}/cancel` or `PATCH /orders/{id}` (terminate).
