# Avatar CRM – WhatsApp Payment Link API (for the AI calling agency)

Use this API to have a payment link sent to a customer on WhatsApp, right after (or during) a call. The message is sent from Avatar's official WhatsApp Business number through the Meta WhatsApp Cloud API. You never handle any Meta credentials.

## Endpoint

| | |
|---|---|
| **URL** | `https://sales-crm-3pan.onrender.com/api/agency/whatsapp/payment-link` |
| **Method** | `POST` |
| **Content-Type** | `application/json` |
| **Authentication** | `X-API-Key: <your API key>` (or `Authorization: Bearer <your API key>`) |
| **Recommended header** | `Idempotency-Key: <unique id per call>` (8–128 characters: letters, digits, `. _ : -`) |

Your API key is given to you privately by Avatar. Keep it secret, send it only from your servers and only over HTTPS. If it leaks, tell us and we will revoke it immediately.

## Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `customerName` | string | yes | 1–100 characters. Used in the message greeting. |
| `mobile` | string | yes | **With country code**, e.g. `+919876543210`. Indian numbers must be `+91` followed by 10 digits starting 6–9. |
| `paymentLink` | string | yes | `https://` URL on an approved payment domain (currently `*.cashfree.com`, `cfre.in`). Max 2000 characters. Ask Avatar to approve another domain. |
| `customerConsent` | boolean | yes | Must be `true`: the customer agreed, on the call, to receive this WhatsApp message. |
| `orderId` | string | no | Avatar order number (e.g. `CRM-MW62HLOS-…`, `AWL110598`) or your own reference. If it is an Avatar order it must belong to this mobile number. |
| `templateParams` | object | no | Extra values for the approved message template, e.g. `{"amount": "449"}`. Names: lowercase letters, digits, `_`. Values: text, max 500 characters, no line breaks or tabs. `customer_name` and `payment_link` are set from the fields above and cannot be passed here. |

```json
{
  "customerName": "Rahul Sharma",
  "mobile": "+919876543210",
  "paymentLink": "https://payments.cashfree.com/links/abc123",
  "orderId": "CRM-MW62HLOS-S1",
  "templateParams": { "amount": "449" },
  "customerConsent": true
}
```

### Example

```bash
curl -X POST "https://sales-crm-3pan.onrender.com/api/agency/whatsapp/payment-link" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: avk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Idempotency-Key: call-8841-attempt-1" \
  -d '{
    "customerName": "Rahul Sharma",
    "mobile": "+919876543210",
    "paymentLink": "https://payments.cashfree.com/links/abc123",
    "orderId": "CRM-MW62HLOS-S1",
    "customerConsent": true
  }'
```

## Responses

Every response is JSON with `success` and a `requestId`. Quote the `requestId` when you contact us about a request.

### 200 – accepted by WhatsApp

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
  }
}
```

`status: "SENT"` means WhatsApp accepted the message. Delivery to the phone happens afterwards and is not reported by this API.

If you repeat a request (same `Idempotency-Key`), you get the **same answer** with `"duplicate": true` and nothing is sent again.

### Errors

```json
{
  "success": false,
  "requestId": "6f1d3a52-8c0e-4a8e-9a53-1c6f2d9f7b10",
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request is not valid",
    "details": [
      { "field": "mobile", "message": "mobile must include the country code and start with +, e.g. +919876543210" },
      { "field": "paymentLink", "message": "paymentLink must be an https:// URL" }
    ]
  }
}
```

| HTTP | `error.code` | Meaning | What to do |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | A field is wrong; `details` lists each one | Fix the request. Nothing was sent. |
| 400 | `INVALID_JSON`, `INVALID_IDEMPOTENCY_KEY`, `BODY_TOO_LARGE` | Malformed request | Fix the request. |
| 401 | `UNAUTHORIZED` | Missing, wrong or revoked API key | Check the key. |
| 409 | `IDEMPOTENCY_KEY_REUSED` | This `Idempotency-Key` was used for a different request | Use a new key for a new request. |
| 409 | `REQUEST_IN_PROGRESS` | An identical request is still running | Wait 3 seconds, repeat with the same key. |
| 409 | `RECENT_MESSAGE_CONFLICT` | A different message went to this customer seconds ago | Retry after a minute. |
| 422 | `CUSTOMER_OPTED_OUT` | The customer has opted out of WhatsApp | Do not retry. Contact them another way. |
| 422 | `ORDER_MOBILE_MISMATCH` | `orderId` belongs to a different number | Fix `orderId` or `mobile`. |
| 422 | `MISSING_TEMPLATE_PARAMETERS` | The message template needs values you did not send (`details.missing`) | Send them in `templateParams`. |
| 422 | `RECIPIENT_NOT_REACHABLE` | WhatsApp says this number cannot receive the message | Do not retry; check the number. |
| 429 | `RATE_LIMITED` | Too many requests (default 30 per minute) | Wait for the `Retry-After` seconds. |
| 429 | `RECIPIENT_LIMIT` | This customer already got 3 payment links in the last hour | Try later. |
| 429 | `TOO_MANY_FAILED_ATTEMPTS` | Many requests with a wrong key | Check the key; wait a minute. |
| 502 | `WHATSAPP_UNREACHABLE`, `WHATSAPP_UNAVAILABLE`, `WHATSAPP_RATE_LIMITED` | WhatsApp is temporarily unavailable | Retry (same `Idempotency-Key`). `retryable: true`. |
| 502 | `TEMPLATE_REJECTED`, `WHATSAPP_REJECTED`, `WHATSAPP_AUTH_ERROR` | WhatsApp refused the message; `message` has the reason | Report the `requestId` to Avatar. Do not loop. |
| 503 | `NO_APPROVED_TEMPLATE`, `WHATSAPP_NOT_CONFIGURED` | Avatar's WhatsApp setup is incomplete | Report to Avatar; retry later. |
| 500 | `INTERNAL_ERROR` | Unexpected error; the message may not have been sent | Retry with the same `Idempotency-Key`. |

Errors that include `"retryable": true` are safe to retry. Always retry with the **same** `Idempotency-Key`: if the first attempt did go through, you get its result instead of a second message.

## Rules you should know

- **Always send an `Idempotency-Key`**, one per call you want to make. Without it, an identical request within 10 minutes is treated as the same request.
- **Rate limit:** 30 requests per minute per API key (response headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`; `Retry-After` when exceeded). A single customer can receive at most 3 payment-link messages per hour.
- **WhatsApp policy:** the message is always an **approved WhatsApp template** (a business-initiated message to a customer outside the 24-hour customer-service window may only be a template). You cannot send free text. The customer must have agreed to receive it (`customerConsent: true`); customers who opted out are never messaged.
- **Payment links** must be `https` links on an approved payment domain. Never put secrets in the link.
- **Timeouts:** use a client timeout of at least 30 seconds.
- **Support:** quote the `requestId`. Avatar can see each request, its outcome and WhatsApp's response.

---

# For Avatar's team (not for the agency)

## One-time setup

1. **Deploy** this backend and apply the migration `20261110000000_agency_api` (`npm run db:deploy`). It adds two tables: `agency_api_keys` and `agency_message_requests`.
2. **Approved template.** In Settings → WhatsApp Config → Templates, create a **Utility** template for Meta containing `{{customer_name}}` and `{{payment_link}}` (for example: *"Hi {{customer_name}}, here is your secure payment link: {{payment_link}}. Please complete the payment to confirm your order."*), submit it to Meta and sync it until it is **APPROVED**. Optional: set `AGENCY_PAYMENT_LINK_TEMPLATE` to its name. If the template has other variables, the agency must send them in `templateParams` (or they come from the linked order).
3. **Create the key** on the production server: `npm run agency:key -- create "<agency name>" --rate 30`. The key is printed once; send it to the agency over a secure channel. `npm run agency:key -- list` shows keys, `... revoke <id>` disables one instantly.
4. **Payment domains.** `AGENCY_PAYMENT_LINK_HOSTS` defaults to `cashfree.com,*.cashfree.com,cfre.in`. Add the agency's gateway domain if it differs.
5. **Test** with a number you own before giving the key out.

## Where to look

- Requests: table `agency_message_requests` (status, error code, masked number, link host, WhatsApp message id, the exact JSON answer given).
- The WhatsApp message itself (body, status, delivery/read updates from Meta's webhook) appears in the customer's WhatsApp conversation in the CRM like any other message, and in `whatsapp_messages`.
- Server log lines start with `[agency]`.
