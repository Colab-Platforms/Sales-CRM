# Avatar CRM – WhatsApp Payment Link API (for the AI calling agency)

Use this API to have a payment link sent to a customer on WhatsApp, during or right after a call, or to tell Avatar that a customer is interested. **You send only the customer's name, mobile number and an `intent`.** The CRM finds the customer's COD order and its amount, creates the payment link itself, and sends it from Avatar's official WhatsApp Business number through the Meta WhatsApp Cloud API. You never handle payment links, order ids, amounts or any credentials.

## Endpoint

| | |
|---|---|
| **URL** | `https://sales-crm-3pan.onrender.com/api/agency/whatsapp/payment-link` |
| **Method** | `POST` |
| **Content-Type** | `application/json` |
| **Authentication** | `X-API-Key: <your API key>` (or `Authorization: Bearer <your API key>`) |
| **Recommended header** | `Idempotency-Key: <unique id per call>` (8–128 characters: letters, digits, `. _ : -`) |

Your API key is given to you privately by Avatar. Keep it secret, send it only from your servers and only over HTTPS. If it leaks, tell us and we will revoke it immediately.

## Request body – three fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `customerName` | string | yes | 1–100 characters. Used in the message greeting. |
| `mobile` | string | yes | **With country code**, e.g. `+919876543210`. Indian numbers must be `+91` followed by 10 digits starting 6–9. |
| `intent` | string | no (for now) | `ALREADY_ORDERED` or `INTERESTED`. See below. **If you leave it out, the request is treated as `ALREADY_ORDERED`** (temporary default so existing integrations keep working). Please start sending it explicitly. |

| `intent` | Use it when | What the CRM does |
|---|---|---|
| `ALREADY_ORDERED` | The customer says they already placed a COD order | Finds their COD order, creates its payment link and sends it on WhatsApp (everything described below). |
| `INTERESTED` | The customer is interested but has not ordered | **Only records** that the customer is interested, against their record in the CRM. No order lookup, no payment link, no WhatsApp message. |

```json
{
  "customerName": "Rahul Sharma",
  "mobile": "+919876543210",
  "intent": "ALREADY_ORDERED"
}
```

Any other field (for example `paymentLink`, `orderId`, `customerConsent`, `templateParams`) and any other `intent` value are **rejected** with `VALIDATION_FAILED`, so nothing you send is silently ignored.

### Example

```bash
curl -X POST "https://sales-crm-3pan.onrender.com/api/agency/whatsapp/payment-link" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: avk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Idempotency-Key: call-8841-attempt-1" \
  -d '{ "customerName": "Rahul Sharma", "mobile": "+919876543210", "intent": "ALREADY_ORDERED" }'
```

## `intent: "INTERESTED"` – record only

Nothing is sent to the customer and no payment link is created. The CRM finds the customer by mobile number and records an "AI Agent – Interested" note on their record (their status, owner, assignment and call history are not changed). If the number is not in the CRM, the note is still recorded for Avatar's team and **no customer is created**.

```json
{ "success": true, "requestId": "6f1d3a52-…", "status": "RECORDED", "duplicate": false, "intent": "INTERESTED", "leadMatched": true }
```

`leadMatched: false` means the number is not in the CRM (still HTTP 200, still recorded). Repeating the request with the same `Idempotency-Key` returns the same answer with `"duplicate": true` and records nothing new. Errors are as in the table below (`VALIDATION_FAILED`, `UNAUTHORIZED`, `RATE_LIMITED`, `IDEMPOTENCY_KEY_REUSED`, …); the order, consent and WhatsApp errors do not apply.

## How the CRM decides what to send (`ALREADY_ORDERED`)

1. It looks up the customer by the mobile number.
2. It looks for that customer's **eligible COD orders**: placed as cash-on-delivery, nothing paid yet, an amount still owed, status *Confirmed* or *Processing* (not cancelled, returned, refunded, shipped or delivered).
3. - **Exactly one** eligible order → the CRM creates its payment link (for the full amount still owed) and sends it on WhatsApp.
   - **None** → `404 NO_ELIGIBLE_ORDER` (or `CUSTOMER_NOT_FOUND`). Nothing is created or sent.
   - **More than one** → `409 MULTIPLE_ELIGIBLE_ORDERS` with the candidates. The CRM never guesses; nothing is created or sent. Ask the customer to confirm with Avatar's team.
4. A customer who has **opted out** of WhatsApp is never messaged, and no payment link is created for them.

## Responses

Every response is JSON with `success` and a `requestId`. Quote the `requestId` when you contact us about a request.

### 200 – payment link sent

```json
{
  "success": true,
  "requestId": "6f1d3a52-8c0e-4a8e-9a53-1c6f2d9f7b10",
  "status": "SENT",
  "duplicate": false,
  "message": {
    "id": "1b9f0c4e-…",
    "whatsappMessageId": "wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgS…",
    "template": "payment_link_v1",
    "to": "+91******3210"
  },
  "order": { "orderNumber": "CRM-MW62HLOS-S1", "shopifyOrderNumber": "#AWL110598" },
  "payment": { "amount": "449.00", "currency": "INR", "expiresAt": "2026-11-12T10:30:00.000Z", "reusedExistingLink": false }
}
```

`status: "SENT"` means WhatsApp accepted the message. Delivery to the phone happens afterwards and is not reported by this API. If you call again for the same customer while their payment link is still open, the **same link** is sent (`reusedExistingLink: true`); a second link is never created for the same amount.

If you repeat a request (same `Idempotency-Key`), you get the **same answer** with `"duplicate": true` and nothing is sent again.

### Errors

```json
{
  "success": false,
  "requestId": "6f1d3a52-8c0e-4a8e-9a53-1c6f2d9f7b10",
  "error": {
    "code": "MULTIPLE_ELIGIBLE_ORDERS",
    "message": "This customer has more than one eligible COD order, so the CRM did not choose one and created no payment link. Resolve it with the CRM team.",
    "details": { "orders": [
      { "orderNumber": "CRM-MW62HLOS-S1", "shopifyOrderNumber": "#AWL110598", "amount": "449.00" },
      { "orderNumber": "CRM-MW63ABCD-T2", "shopifyOrderNumber": "#AWL110611", "amount": "999.00" }
    ] }
  }
}
```

```json
{
  "success": false,
  "requestId": "…",
  "error": { "code": "NO_ELIGIBLE_ORDER", "message": "This customer has no COD order that can be paid online (it must be an unpaid COD order that is not cancelled, returned or already shipped). No payment link was created." }
}
```

| HTTP | `error.code` | Meaning | What to do |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | A field is wrong or an extra field was sent; `details` lists each one | Fix the request. Nothing was created or sent. |
| 400 | `INVALID_JSON`, `INVALID_IDEMPOTENCY_KEY`, `BODY_TOO_LARGE` | Malformed request | Fix the request. |
| 401 | `UNAUTHORIZED` | Missing, wrong or revoked API key | Check the key. |
| 404 | `CUSTOMER_NOT_FOUND` | No customer with this mobile number | Check the number. |
| 404 | `NO_ELIGIBLE_ORDER` | The customer has no unpaid COD order that can be paid online | Nothing to send. |
| 409 | `MULTIPLE_ELIGIBLE_ORDERS` | More than one eligible order; `details.orders` lists them | Do not retry; hand over to Avatar's team. |
| 409 | `IDEMPOTENCY_KEY_REUSED` | This `Idempotency-Key` was used for a different request | Use a new key for a new request. |
| 409 | `REQUEST_IN_PROGRESS` | An identical request is still running | Wait 3 seconds, repeat with the same key. |
| 409 | `RECENT_MESSAGE_CONFLICT` | A different message went to this customer seconds ago | Retry after a minute. |
| 409 | `PAYMENT_LINK_CONFLICT` | An open payment link for a different amount exists | Report to Avatar. Do not retry. |
| 422 | `CUSTOMER_OPTED_OUT` | The customer has opted out of WhatsApp | Do not retry. Contact them another way. |
| 422 | `CONSENT_NOT_RECORDED` | (Only if strict mode is on) no recorded WhatsApp consent | Report to Avatar. |
| 422 | `ORDER_NOT_PAYABLE` | The payment service refused (e.g. nothing left to pay) | Do not retry; report the `requestId`. |
| 422 | `RECIPIENT_NOT_REACHABLE` | WhatsApp says this number cannot receive the message | Do not retry; check the number. |
| 429 | `RATE_LIMITED` | Too many requests (default 30 per minute) | Wait for the `Retry-After` seconds. |
| 429 | `RECIPIENT_LIMIT` | This customer already got 3 payment-link messages in the last hour | Try later. |
| 429 | `TOO_MANY_FAILED_ATTEMPTS` | Many requests with a wrong key | Check the key; wait a minute. |
| 502 | `PAYMENT_LINK_FAILED` | The payment gateway could not create the link; nothing was sent | Retry (same `Idempotency-Key`). `retryable: true`. |
| 502 | `WHATSAPP_UNREACHABLE`, `WHATSAPP_UNAVAILABLE`, `WHATSAPP_RATE_LIMITED` | WhatsApp is temporarily unavailable | Retry (same `Idempotency-Key`). `retryable: true`. |
| 502 | `TEMPLATE_REJECTED`, `WHATSAPP_REJECTED`, `WHATSAPP_AUTH_ERROR` | WhatsApp refused the message; `message` has the reason | Report the `requestId` to Avatar. Do not loop. |
| 503 | `NO_APPROVED_TEMPLATE`, `WHATSAPP_NOT_CONFIGURED` | Avatar's WhatsApp setup is incomplete | Report to Avatar; retry later. |
| 500 | `INTERNAL_ERROR` | Unexpected error; the message may not have been sent | Retry with the same `Idempotency-Key`. |

Errors that include `"retryable": true` are safe to retry. Always retry with the **same** `Idempotency-Key`: if the first attempt did go through, you get its result instead of a second message.

## Rules you should know

- **Always send an `Idempotency-Key`**, one per call you want to make. Without it, an identical request within 10 minutes is treated as the same request.
- **Rate limit:** 30 requests per minute per API key (response headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`; `Retry-After` when exceeded). A single customer can receive at most 3 payment-link messages per hour.
- **WhatsApp policy:** the message is always an **approved WhatsApp template** (a business-initiated message to a customer outside the 24-hour customer-service window may only be a template). You cannot send free text. Customers who opted out are never messaged.
- **Timeouts:** use a client timeout of at least 30 seconds (the CRM calls the payment gateway and WhatsApp before it answers).
- **Support:** quote the `requestId`. Avatar can see each request, its outcome and WhatsApp's response.

---

# For Avatar's team (not for the agency)

## One-time setup

1. **Deploy** this backend. The agency tables (`agency_api_keys`, `agency_message_requests`) come from migration `20261110000000_agency_api`; this change adds **no** new migration.
2. **Cashfree** must be configured and enabled on the CRM (the same Cashfree setup the order page's "Create payment link" uses). Payment-link generation is the existing `CashfreePaymentsService.createPaymentLink`; nothing about the gateway is duplicated for the agency.
3. **Approved template.** In Settings → WhatsApp Config → Templates, have a **Utility** template for Meta containing `{{customer_name}}` and `{{payment_link}}` (for example: *"Hi {{customer_name}}, here is your secure payment link for order {{order_number}} (₹{{amount}}): {{payment_link}}"*) approved and synced. The CRM can fill `{{customer_name}}`, `{{payment_link}}`, `{{order_number}}` (the Shopify number if linked, else the CRM number) and `{{amount}}`. A template needing any other variable cannot be used. Optional: set `AGENCY_PAYMENT_LINK_TEMPLATE` to its name.
4. **Create the key** on the production server: `npm run agency:key -- create "<agency name>" --rate 30`. The key is printed once; send it to the agency over a secure channel. `... list` shows keys, `... revoke <id>` disables one instantly.
5. **Test** with a number you own, on a COD order you created for it, before giving the key out.

## Settings (all optional)

| Variable | Effect |
|---|---|
| `AGENCY_ACTOR_USER_ID` | The CRM user the payment-link payment is recorded under (the agency has no login). Default: the oldest active Admin. |
| `AGENCY_REQUIRE_EXPLICIT_OPT_IN=true` | Message only customers with an explicit WhatsApp `OPTED_IN` record. Default: everyone except `OPTED_OUT` (the message concerns the customer's own existing order). |
| `AGENCY_RECIPIENT_LIMIT_PER_HOUR` | Messages per customer per hour (default 3). |
| `AGENCY_RATE_LIMIT_PER_MINUTE` | Upper limit for any key's requests per minute. |
| `AGENCY_PAYMENT_LINK_TEMPLATE` | Preferred template name. |

## Behaviour to be aware of

- Every valid request is also recorded as an **AI Agent activity** on the customer's record (intent, result, time, request id, idempotency key), shown as an "AI Agent" tag and in the timeline; `INTERESTED` adds the "Interested – AI Agent" tag. Leads can be filtered by AI Agent and by intent. This is only a record of the request: it never marks a call as connected or completed, and never changes the lead's status, owner or assignment. No migration is needed for the `intent` field (it is stored in the activity's metadata).
- The CRM no longer records consent from the agency (it is not sent). Consent is whatever the CRM already holds.
- An unknown mobile number no longer creates a customer record; it is answered `CUSTOMER_NOT_FOUND`.
- A shipped COD order is not eligible (the courier would still collect cash). Converting a shipped parcel to prepaid is a manual decision.
- When the customer pays, the existing Cashfree webhook / reconciliation marks the order paid, exactly as for a link created on the order page.

## Where to look

- Requests: table `agency_message_requests` (status, error code, masked number, order id, WhatsApp message id, the exact JSON answer given).
- The payment: the order's Payments list (a Cashfree payment-link payment) and its activity log.
- The WhatsApp message (body, status, delivery/read updates) appears in the customer's WhatsApp conversation in the CRM like any other message, and in `whatsapp_messages`.
- Server log lines start with `[agency]`.
