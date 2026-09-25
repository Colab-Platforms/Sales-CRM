# Telephony (CallerDesk primary, Exotel backup)

Frontend -> **CRM backend only** -> `TelephonyService` -> CallerDesk (primary) / Exotel (backup).
The frontend never sees a provider name, provider status, provider field or provider response.

## Layout

| File | Role |
|---|---|
| `provider.types.ts` | Neutral `NormalizedCallEvent`, `TelephonyProvider` interface, `ProviderInitiationError` |
| `callerdesk.provider.ts` | CallerDesk adapter: **click-to-call initiation** (verified contract) + webhook normalisation |
| `exotel.provider.ts` | Exotel adapter; **reuses** `webhooks/exotel/payloadExtractors` (module untouched) |
| `telephony.service.ts` | Provider selection + the fallback rule |
| `call.contract.ts` | `POST /api/calls` request/response/error types |
| `../call/*` | `POST /api/calls` (routes, controller, service, store) |
| `../webhooks/callerdesk/*` | `POST /api/webhooks/callerdesk` (routes, controller, service, payload, status, store) |

## CallerDesk webhook - `POST /api/webhooks/callerdesk`

Configure **only** the *Call report* and *Live call* events in the CallerDesk dashboard
(API & Integration -> Webhooks). Member / call-group events have no `CallSid` and are rejected with 400.
Webhooks are a CallerDesk premium feature and the URL must be public HTTPS.

Responses: `200` accepted (also duplicates, unmatched and ignored events), `400` invalid payload,
`401` bad token (only when the optional token is enabled), `405` non-POST, `500` processing failed
(raw event still persisted, so CallerDesk may retry).

### Event type detection
> **Correction (found while researching outbound):** CallerDesk's official sample payload for a Call Report
> *does* contain `"type": "call_report"` (plus `key_press`, `hangup_cause`, `Uniqueid`). The webhook does not read
> it yet - detection is still by report-only fields, which works for Call Reports. The Live Call `type` value is
> not documented. See "Unresolved" below.

A payload with any report-only field (`EndTime`, `CallDuration`,
`TalkDuration`, `CallRecordingUrl`, `LegA_Picked_time`, `LegB_Start_time`, `LegB_Picked_time`) is a
**Call Report**; otherwise it is a **Live Call**. Confirm with a real sample before go-live.

> **Also found:** the official docs include a *"Get Webhook payload"* variant (query-string delivery via GET,
> example response `success`) alongside the POST/JSON one. `POST /api/webhooks/callerdesk` rejects GET with 405.
> Register the webhook as POST ("HTTP POST" per the docs) and confirm what the account actually sends.

### Status mapping (CallerDesk `Status` -> internal `CallStatus`)
Source: CallerDesk "Incoming/Outgoing call reports status". Matching ignores case, spacing, punctuation
and a trailing `(...)` cause code. Unknown values never crash the webhook: they are logged, stored in the
raw payload, and mapped to `FAILED` (Call Report) or left unchanged (Live Call).

| CallerDesk | Live Call | Call Report |
|---|---|---|
| Answer / Answered | CONNECTED | COMPLETED |
| Leg A Answer | AGENT_ANSWERED | COMPLETED |
| Leg B Answer | CONNECTED | COMPLETED |
| Cancel, No Answer, Not Connected, Abandonedcall | NO_ANSWER | NO_ANSWER |
| Busy, Agentengaged, Agentonring | BUSY | BUSY |
| Unavailable | NOT_REACHABLE | NOT_REACHABLE |
| Congestion, Chanunavail | FAILED | FAILED |
| Leg A/B Cancel - No Answer / Busy / Congestion / Unavailable | as above (failed leg recorded in logs/payload) | as above |
| Transfer to Agent | RINGING_AGENT | RINGING_AGENT |
| Picked | AGENT_ANSWERED | AGENT_ANSWERED |

State only moves forward for Live events and never overwrites a terminal status. A Call Report is
authoritative and may replace a provisional terminal status; an unrecognised report status never
overwrites a known terminal one.

### Idempotency
Key = `(provider, eventType, externalEventId)`: Call Report -> `CallSid`; Live Call -> `CallSid|Status`.
A key already `PROCESSED`/`IGNORED` returns 200 `duplicate` and changes nothing. Keys left `RECEIVED`
(unmatched) or `FAILED` are re-attempted on retry. All processing for one `CallSid` runs under
`pg_advisory_xact_lock`, because the schema has **no unique constraint** on `calls.provider_call_id` or
`webhook_events.external_event_id`. Recording = upsert on the unique `call_recordings.call_id`; the CALL
`Activity` is created at most once per call; no follow-up tasks are created.

*Residual risk / recommended follow-up (needs your approval, not done):* a partial unique index on
`webhook_events (provider, event_type, external_event_id)` and on `calls (provider, provider_call_id)`
would enforce this at the database level as well.

### Correlation (first match wins; never an arbitrary lead)
1. `calls.provider_call_id = CallSid` (a call we created at initiation, or seen earlier).
2. Outbound only: `calls.provider_call_id = campid` (click-to-call request id) -> row upgraded to the real `CallSid`.
3. Inbound only: caller number -> **exactly one** lead via `leads.normalized_mobile`. 0 or 2+ matches = unmatched.
   Agent = active user whose phone equals `DialWhomNumber`, else the lead's owner; neither -> unmatched
   (`calls.agent_id` is required). Outbound events with no id match are never matched by phone, because
   CallerDesk does not document which number is the customer on outgoing calls.
4. Otherwise stored as `webhook_events.status = RECEIVED` (= awaiting reconciliation) and logged.

**Phone matching:** `leads.normalized_mobile` is written by `utils/normalize.ts#normalizeMobile` (all digits),
while `utils/phone.ts#normalizePhone` keeps the last 10. `buildMobileLookupCandidates` (added to `phone.ts`)
tries the full digits, the last 10, and `91`+last-10 (Indian mobile range only). Numbers with fewer than 10
digits are never matched. The existing Exotel service still uses `normalizePhone` alone and can miss leads
saved with a country code - left unchanged on purpose.

### Recording
`CallRecordingUrl` (http/https only) -> `call_recordings` via the existing model (`storageProvider` =
`callerdesk`, `status` = `PROVIDER_HOSTED`). Not downloaded, not exposed by any endpoint.

### Live Call
Normalised as `LIVE_CALL`, never treated as completed. It can update an existing call's state or create the
call (inbound, correlated) - forward only. Live events do not create a timeline Activity unless the status is
already terminal. Uncorrelated live events are persisted and left `RECEIVED`; live events with an
unrecognised status are stored `IGNORED`.

### Timestamps and durations
`StartTime`/`EndTime`/`Leg*` are `yyyy-mm-dd hh:mm:ss` with no timezone in the docs. They are read as
**+05:30 (UNVERIFIED)**; override with `CALLERDESK_TIMESTAMP_UTC_OFFSET`. `calls.duration_seconds` stores
`TalkDuration` (conversation time). Leg times map to agent/customer only for outbound (Leg A = agent,
Leg B = customer, per click-to-call parameter names).

## Security limitations (be explicit)
- **CallerDesk documents no webhook signature, secret, auth header or IP allowlist.** None is invented.
  By default the endpoint is unauthenticated.
- Optional hardening (ours, not CallerDesk's): set `CALLERDESK_WEBHOOK_TOKEN` and register the URL as
  `https://<host>/api/webhooks/callerdesk?token=<token>`. The token can leak via access logs / the CallerDesk
  dashboard - defence in depth only.
- Mitigations always on: POST only, zod validation, bounded field sizes, idempotency, no echo of submitted
  data, generic error bodies (the global error handler is never reached), raw values sanitised in logs,
  no phone numbers/URLs/secrets logged.
- Ask CallerDesk support whether a signature/secret or fixed source IPs exist for webhooks.

## Environment variables
| Variable | Required | Purpose |
|---|---|---|
| `CALLERDESK_API_KEY` | **required for `POST /api/calls`** | CallerDesk `authcode` (Dashboard -> Integration Settings -> API key), sent as the `authcode` query parameter. It is the only credential; no secret/integration/login id is used. Never logged. |
| `CALLERDESK_WEBHOOK_TOKEN` | optional | Enables the URL-token check above |
| `CALLERDESK_TIMESTAMP_UTC_OFFSET` | optional (default `+05:30`) | Timezone of CallerDesk timestamps |
| `TELEPHONY_PRIMARY_PROVIDER` | optional (default `CALLERDESK`) | `CALLERDESK` \| `EXOTEL` |
| `TELEPHONY_FALLBACK_PROVIDER` | optional (default `EXOTEL`) | `CALLERDESK` \| `EXOTEL` \| `NONE` |

The webhook itself needs **no** credential to receive events.

## Provider fallback
Fallback happens **only** when the primary's `initiateOutboundCall` throws `ProviderInitiationError` of kind
`NOT_DISPATCHED` (certain that no call was placed: not configured, rejected before dialling, connection
refused/DNS). The backup is tried at most once. Never on success, never on `UNCERTAIN` (timeout, reset, 5xx,
unparseable success - the call may be ringing), never in a loop. A delayed webhook is not a failure.
For CallerDesk, `NOT_DISPATCHED` means: not configured, invalid input, a `{"type":"error"}` reply, or a connection that
was never established (DNS / refused / unreachable / connect-timeout). Everything else (timeout after sending, reset,
non-200, HTML/garbage, unknown `type`, redirect) is `UNCERTAIN`.
Exotel outbound is **not implemented** (no Exotel client/credentials exist), so a fallback attempt currently fails
closed with `NOT_DISPATCHED` and no second call can ever be placed.

## CallerDesk click-to-call - verified contract

**Sources.** CallerDesk's official public API documentation (a Postman collection published at
<https://api.callerdesk.io/>: items *Click_to_call (Normal)*, *Click2call via Member ID*, *Click2Call API (with CallGroup)*,
*Reverse C2C API*, *Get Member List*, *IVR Number List*, *Post/Get Webhook payload*) and
<https://docs.callerdesk.io/click2call-manually/>. Failure behaviour was **observed on 2026-09-21** by sending the
request with an **invalid** auth code and dummy numbers (which cannot authenticate, so cannot place a call). No real
call has ever been placed by this code.

| Item | Verified value |
|---|---|
| Endpoint | `https://app.callerdesk.io/api/click_to_call_v2` (HTTPS only; plain HTTP fails) |
| Method | `GET`, query-string parameters, no body |
| Auth | `authcode` query parameter = API key from *Integration Settings*. No auth header. |
| Headers | None required or documented |
| Required params | `calling_party_a`, `calling_party_b`, `deskphone`, `authcode`, `call_from_did=1` ("always 1, mandatory") |
| Optional params | `call_start_time` (not used), `group_name` (call-group variant, not used) |
| Agent | `calling_party_a` = the number rung **first** (leg A); 10-digit, no country code |
| Customer | `calling_party_b` = rung once A answers (leg B); 10-digit, no country code |
| Business number / CLI | `deskphone` = "DID or Deskphone assigned in account" (also the caller ID shown to the customer) |
| Two legs? | Yes - agent first, then the customer is dialled once the agent picks up |
| `campid` | **Returned by CallerDesk** in the success body; the caller does not supply it |
| Success | HTTP 200, `{"type":"success","message":"Call to Customer Initiate Successfully..","campid":<int>,"callerid":"<did>"}` |
| Failure (observed, auth) | **HTTP 200** (not 4xx), `Content-Type: text/html`, `{"type":"error","message":"Invalid Auth Code!"}` |
| Provider call id at initiation | `campid` only. The `CallSid` arrives later via webhook. |
| Alternatives | `click_to_call_v4` (agent by `member_id`, needs a CallerDesk member id we do not store); `click_to_call_v3` (reverse: customer first) |

**Consequences implemented**
- The body's `type` decides, never the HTTP status (errors are HTTP 200).
- `campid` is stored in `calls.provider_call_id`; the webhook service already correlates outbound events by `CallSid`
  first and by `campid` second, and upgrades the row to the real `CallSid`.
- The auth code is in the URL, so URLs are never logged and never appear in error messages; redirects are not followed.

## POST /api/calls

`POST /api/calls`, body `{ "leadId": "<uuid>" }`, `Authorization: Bearer <CRM JWT>`. Roles: ADMIN, MANAGER, SALESPERSON.

Flow: authorise the lead -> resolve customer number -> resolve the caller's own (agent) number -> resolve the business
number -> **atomically** create `Call(OUTBOUND, INITIATED)` unless one is already active -> `TelephonyService`
(CallerDesk primary; Exotel only after a definitive `NOT_DISPATCHED`) -> store the provider id on the Call.

| Step | Rule |
|---|---|
| Authorisation | Same as `lead.service.ts`: ADMIN any; MANAGER `assignedManagerId = self`; SALESPERSON `ownerId = self`. Unknown and inaccessible leads both return `LEAD_NOT_FOUND`. |
| Agent | The **authenticated caller**. Their own `users.phone` rings first. Never taken from the request body. |
| Customer number | `leads.normalized_mobile`, else `leads.mobile`. Accepted only if unambiguously Indian: 10 digits, or 11 with leading `0`, or 12 with leading `91`. Anything else is refused (never truncated - that could dial a stranger). |
| Business number | Active `virtual_numbers` with `provider = 'callerdesk'` (case-insensitive): the lead's group first, else a group-less number; oldest first. Sent verbatim (digits only) as `deskphone`. |
| Duplicates | Advisory locks per agent then lead, then refuse if a non-terminal Call for that lead **or** agent was updated in the last 15 min (`CALL_ALREADY_IN_PROGRESS`, 409, returns the active `callId`). |
| Provider certainly did not dial | Call -> `FAILED`, `TELEPHONY_UNAVAILABLE` (503). Immediate retry allowed. |
| Provider may have dialled | Call stays `INITIATED`, `CALL_OUTCOME_UNKNOWN` (502). A blind retry is blocked by the guard above. No fallback. |
| Accepted but storing the id fails | Still returns 201; the `campid` is logged for manual reconciliation. |

Response `201`: `{ success, message, data: { callId, status: "INITIATED", callingIdentity: { displayName, number } } }`.
Errors: `{ success:false, message, data:{ code, callId? } }` - see `call.contract.ts` for the code table. No provider name,
id, status or message ever reaches the client.

## Unresolved (not guessed)
1. **Other failure responses.** Only the auth error was observed. A `{"type":"error"}` reply is treated as a definitive
   rejection (safe to fall back). If CallerDesk ever returns `type:error` *after* starting a call, a fallback could
   double-dial - moot today because Exotel cannot dial, but confirm with CallerDesk before enabling Exotel outbound.
2. **`deskphone` number format.** The docs mix `0120xxxx` and `120xxxx`. We send the stored number verbatim: store it
   **exactly as the CallerDesk panel / `getdeskphone_v2` lists it**.
3. **Agent restrictions.** Not documented for `click_to_call_v2` (registration is only stated for the call-group,
   member-id and reverse variants). Rate limits and credit/balance errors are also undocumented.
4. **`campid` vs `CallSid`.** The official outbound sample shows `CallSid: "8397472"`, `campid: "83974xx"`,
   `Uniqueid: "8397472"` - suggestive but not proof they are equal. The webhook handles both.
5. **Webhook race.** If a Live/Report webhook arrives before we store the `campid` (milliseconds after the API reply) it
   is kept as `RECEIVED` (unmatched) and only reconciled on a retry.
6. **Webhook shape.** The `type` field and the GET delivery variant (see above).
7. **Exotel outbound** does not exist (no client/credentials); it is the declared backup but cannot dial.
8. **Failure reason**: `calls` has no column for a provider failure code, so it is logged, not stored.
9. **Non-Indian numbers** are refused; the documented contract only shows 10-digit numbers.
10. **Database is behind the schema.** The connected Neon database has only migration `20260918115918` applied; the two
    later migrations (adding `leads.assigned_manager_id`, `leads.import_batch_id`, `lead_import_batches`, and the
    round-robin tables) are pending. `POST /api/calls` (manager authorisation) and the whole lead module need
    `leads.assigned_manager_id`, so they fail with Prisma `P2022` on that database until it is migrated.
