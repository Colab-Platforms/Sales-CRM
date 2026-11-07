# CRM performance audit

Date: 7 Nov 2026 · Branch: `dev-ritika`

## How this was measured

All numbers below are real measurements. Nothing was estimated, and no dummy data was used.

- **Environment.**
  - Backend: run locally on port 5000.
  - Frontend: run locally on port 3002, as a production build (`next build` + `next start`). The dev server compiles each page on first visit, so it gives misleading page times; see bottleneck 5.
  - Database: the Neon database in `backend/.env` (`ep-floral-tooth`, region `ap-southeast-1`), accessed from the developer PC. Its data ends on 27 Oct, so October 2026 is the busiest real month and is used for the heavy tests.
- **API timings.** Each endpoint is called directly with a signed token for an admin, a manager (Aditya Tarkar) and a salesperson (Yash). Each figure is the median of 3 or 5 warm runs.
- **Back-to-back comparison.** For the main fix, the old and new code were measured one after the other, on the same database and network, at the same time of day. This removes most of the run-to-run network noise.
- **Page audit.** Each main page was loaded in headless Chrome, driven through the DevTools protocol, for each role. The audit records every API request, its duration, any duplicates, the time until the page was idle, and console errors.
  - It is read-only. Every non-GET request and the attendance presence stream were blocked, so loading pages as a salesperson started no shift and wrote nothing.
- **Database checks.** `EXPLAIN ANALYZE` on the main heavy queries; round-trip latency; parallel-query (pool) behaviour.
- **Correctness.** Every change was checked by comparing the complete output before and after. Identical results were required.

## 1. Root causes: the five biggest bottlenecks

### 1. `soldOrders` loaded tens of thousands of rows to credit a few hundred orders

`soldOrders` (`backend/src/modules/manager/manager.sales.ts`) decides which salesperson each sold order counts for. It feeds:

- Revenue and Orders on Reports and the manager dashboard;
- Performance Matrix;
- My Incentive Plan;
- Sales Incentives.

It used to start by loading **every** call and **every** activity the team logged in the period plus 7 days, each joined to its lead. Only after that did it look for orders among all the customers those rows touched.

Evidence, for October with all active salespeople:

| Step | Rows | Time |
|---|---:|---:|
| Window calls + lead | 7,530 | 1,597 ms |
| Window activities + lead | **35,917** | 1,878 ms |
| Orders query (5,391 lead ids and 5,368 phones in `IN` lists) | 240 | 661 ms |
| Sold orders in the period, loaded directly | 254 | **94 ms** |
| Whole `soldOrders` | 238 credited | 3.5–5.5 s |

Only the roughly 250 sold orders' customers ever matter for crediting, so almost all of that loading was wasted.

### 2. Network latency to the database, not slow SQL

| Measurement | Result |
|---|---:|
| First query (connect) from the PC | 712–979 ms |
| Warm round trip (`SELECT 1`) | **70 ms** each |
| 10 × 50 ms queries in parallel | 414 ms (the pool handles parallel queries fine) |
| 30 × 50 ms queries in parallel | 363 ms |

Server-side execution of the heavy queries (`EXPLAIN ANALYZE`):

| Query | Plan | Execution time |
|---|---|---:|
| Calls by salespeople, one month (7,477 rows) | Seq Scan | 2.8 ms |
| Sold orders in a month | Seq Scan | 10.0 ms |
| Leads received in a month by owner | Index Scan `leads_created_at_idx` | 5.9 ms |
| Leads list page 1 | Index Scan Backward `leads_created_at_idx` | 0.06 ms |
| Activities by salespeople in a window (the old `soldOrders` step) | Parallel Seq Scan | 219 ms |

The SQL itself runs in milliseconds. Time goes on round trips of about 70 ms each and on transferring large row sets from Singapore.

**Indexes.** The filters this audit was asked to check already have indexes:

- created date: `leads.created_at`, `orders.created_at`;
- assigned salesperson: `leads.owner_id`, `leads.assigned_manager_id`;
- lead status: `leads.working_status`;
- call date and salesperson: `calls.started_at`, `calls.agent_id`;
- order date and salesperson: `orders.placed_at`, `orders.confirmed_by_user_id`;
- incentive month: `incentive_months (user_id, month)` unique, `incentive_months.month`.

No missing index was found that would change these timings, so **no migration was added**.

### 3. Requests with no time limit left sections blank

The shared API client (`frontend/lib/api-client/client.ts`) had **no timeout**.

- The backend log shows the database connection dropping: `[queue] read ECONNRESET`, `Connection terminated unexpectedly`.
- When that happens, a request can stay pending indefinitely. The page keeps showing its loading state, which on the incentive pages was almost invisible.
- In one audit run, three requests on the admin Leads page stayed **pending for 90 s**. This did not reproduce in clean re-runs, and the backend log shows no error at that moment, so no cause is claimed for that run.

### 4. Superseded heavy requests kept running when filters changed

Changing the date range on Reports, Performance Matrix or Sales Incentives started a new multi-second request. The previous one kept running in the browser and competed with the new one. Each of these requests takes 0.5–6 s.

### 5. The local dev server made pages look much slower than they are (local only)

The same pages in the dev server and in the production build:

| Page (admin) | Dev server | Production build |
|---|---:|---:|
| Leads | 14,140 ms | 2,422–3,431 ms |
| Reports | 8,906 ms | 1,614 ms |
| Performance Matrix | 6,152 ms | 1,070 ms |
| Audit | 4,989 ms | 995 ms |

Dev mode compiles each page on first visit and React runs some effects twice. This affects only local development, not users. It does explain why the local CRM felt very slow.

## 2. Slow APIs and database queries

Warm API timings before any change, median of 3:

| API | Role | Before |
|---|---|---:|
| `/incentives/overview?month=2026-10` | Admin | **6,267 ms** |
| `/manager/analytics` October | Admin | **5,152 ms** |
| `/manager/analytics` October | Manager | **4,939 ms** |
| `/performance-matrix?date=2026-10-27` | Admin | **2,272 ms** |
| `/incentives/me?month=2026-10` | Salesperson | 999 ms |
| `/manager/analytics` one day | Admin | 674 ms |
| `/lead/leads?page=1&limit=20` | Admin / Manager / Salesperson | 446 / 487 / 238 ms |
| `/attendance/records`, one week | Admin / Salesperson | 354 / 397 ms |
| `/dashboard`, `/audit`, `/tasks/follow-ups`, counts | All | 73–289 ms |
| `/orders/live?first=20` | Admin | 21 ms |

The slow database work behind these endpoints is listed under bottleneck 1.

## 3. Files changed

| File | Change |
|---|---|
| `backend/src/modules/manager/manager.sales.ts` | `soldOrders`: load the period's candidate orders first, then load calls and activities only for those orders' customers. |
| `frontend/lib/api-client/client.ts` | A 90 s time limit for GET requests that do not set their own. Writes and file downloads are excluded. |
| `frontend/lib/api-client/endpoints/manager.api.ts`, `queries/manager.queries.ts` | Reports and salesperson analytics pass the query's `AbortSignal`. |
| `frontend/lib/api-client/endpoints/performance-matrix.api.ts`, `queries/performance-matrix.queries.ts` | Performance Matrix passes the `AbortSignal`. |
| `frontend/lib/api-client/endpoints/incentives.api.ts`, `queries/incentives.queries.ts` | The Sales Incentives overview passes the `AbortSignal`. |

The previous fix to the Sales Incentives loading state is also uncommitted in this working tree (`admin-incentives-page.tsx`, `my-incentive-plan.tsx`, part of `incentives.api.ts` / `incentives.queries.ts`). It adds visible loading, Retry, a timeout and safe missing fields.

## 4. Optimizations implemented

1. **`soldOrders` loads only what it needs.**
   - Candidate orders are loaded first: confirmed by the team, or not confirmed by any salesperson.
   - Calls and activities are then loaded only for those orders' customers, by lead id or phone.
   - The credit rules (CONFIRMED / ASSISTED), the 7-day window, customer matching by phone, and the call-status, payment and order-status filters are unchanged.
   - **Verified identical:** the same orders, credited salesperson, credit type, amount, payment mode and sale time in 10 of 10 cases. The cases cover all and one team, one salesperson, one day, one and two months, COD, connected and not-connected calls, and delivered.
2. **Time limit on reads.** A stalled GET now ends as an error after 90 s, so React Query's retry or the page's Retry button takes over. Writes have no time limit, so a slow save is never retried behind the user's back.
3. **Cancelling superseded requests.** Tested in the browser: switching the Reports date range three times in 0.75 s cancelled the two superseded requests after about 330 ms (`net::ERR_ABORTED`), and only the last one completed.
4. **Loading and error states on the incentive pages** (previous fix): visible placeholder cards with a spinner, an error message with Retry, and no crash when fields are missing.

**Investigated and rejected.** These changes produced identical output but no measurable gain, so they were reverted:

- **Loading the Reports lead cohort's related records in parallel instead of nested.** Same output in 7 of 7 cases, not faster: the queries compete for the same connections.
- **Replacing the cohort's 35,822 activity rows with an aggregate plus status changes.** Same output in 7 of 7 cases. Alternating benchmark, median of 5: 1,889 ms old against 1,895 ms new.
- **Polling intervals.** Follow-ups every 30 s, including background tabs so reminders fire; leads list 30 s; badge counts 60 s. These are deliberate features and were left as they are. Repeats seen in the audit were these scheduled polls, not duplicate requests.

## 5. Before-and-after measurements

### API response time, back to back, median of 5

| Screen / API | Old | New | Change |
|---|---:|---:|---:|
| Reports, one day (admin), `/manager/analytics` | 4,285 ms | **815 ms** | **5.3× faster** |
| Performance Matrix, `/performance-matrix` | 2,350 ms | **469 ms** | **5.0× faster** |
| Reports, October (manager) | 7,812 ms | **4,111 ms** | 1.9× faster |
| Sales Incentives overview, October | 5,813 ms | **3,123 ms** | 1.9× faster |
| My Incentive Plan, October (salesperson) | 791 ms | **656 ms** | 1.2× faster |
| Reports, October (admin) | 4,712 ms | **4,050 ms** | 1.2× faster |

### Database work inside `soldOrders`

| Case | Before | After |
|---|---:|---:|
| All salespeople, October | 3,585 ms | 1,170 ms |
| All salespeople, 27 Oct | 1,672 ms | 331 ms |
| Aditya's team, October | 2,510 ms | 691 ms |
| All, October, connected calls | 2,758 ms | 700 ms |
| All, October, delivered | 2,273 ms | 160 ms |

### Pages: production build, API requests per page, time to idle

| Page | Role | Requests (before → after) | Before | After |
|---|---|---|---:|---:|
| Dashboard | Manager | 8 → 8 | 1,963 ms | 1,852 ms |
| Reports | Manager | 6 → 6 | 1,224 ms | 1,115 ms |
| Performance Matrix | Manager | 6 → 6 | 787 ms | 851 ms |
| Leads | Manager | 8 → 8 | 1,242 ms | 1,260 ms |
| Dashboard | Salesperson | 8 → 8 | 1,273 ms | 1,497 ms |
| My attendance | Salesperson | 6 → 6 | 1,047 ms | 897 ms |
| Leads | Admin | 15, 3 stuck 90 s → 7 | 90,132 ms | 2,589 ms |
| Audit | Admin | 6 → 6 | 995 ms | 1,143 ms |

How to read the page timings:

- Page times on "today" (7 Nov) barely change, because the local database has almost no data for today. The gains show on days and months with data, as in the API table.
- Page timings vary by ±1–2 s between runs because of the network to Singapore. The back-to-back API medians above are the reliable comparison.
- The first page of each run also pays the roughly 1 s cold database connection.
- Requests per page stayed at **6–8**. The audit found **no duplicate fetches** beyond scheduled polling.

**Large datasets.** Reports for October covers 9,066 leads, 7,477 calls and 238 orders. It went from 4.7–7.8 s to about 4.1 s on the API; the remaining time is covered under the remaining issues.

**Frontend rendering time.** This was not measured separately. Every page reached idle within about 0.3–0.5 s of its last API response, so rendering is not a bottleneck compared with API time.

## 6. Remaining issues

1. **Reports for a whole month (~4 s) and the Sales Incentives overview (~3 s) are still the slowest screens.** They move several thousand rows (leads, calls, work sessions with status logs) over a 70 ms link. Two code-level attempts (parallel loading, aggregation) were measured and gave no gain, so they were reverted. A real gain likely needs:
   - running the backend in the **same region as the Neon database** (`ap-southeast-1`), where round trips are about 1–2 ms instead of 70 ms; and/or
   - precomputed daily summaries, which would be a larger design change with a migration.
2. **Hosting region not verified.** The live backend's region was not visible from here. If it is far from `ap-southeast-1`, every query pays that distance. This is worth checking in the hosting dashboard.
3. **Cancelled requests still finish on the server.** The browser frees its connection immediately, but Express does not stop the work behind an aborted request.
4. **The one-off 90-second stall** on the admin Leads page did not reproduce. With the read timeout, such a request now ends as an error with retry instead of loading forever.
5. **Pooled connection string.** The local `DATABASE_URL` uses Neon's direct endpoint. For production, Neon's pooler endpoint (`-pooler` host) is recommended for many concurrent connections.
6. **Unrelated failing tests.** 3 frontend tests in `components/whatsapp/inbox/discount-section.test.tsx` (teammate's module, "No QueryClient set") were already failing before this audit and are unchanged.

**Test status after the changes:**

- backend: 1,622 of 1,622 tests pass;
- frontend: type-check and lint clean, 517 of 520 tests pass (the 3 failures above);
- production build succeeds.
