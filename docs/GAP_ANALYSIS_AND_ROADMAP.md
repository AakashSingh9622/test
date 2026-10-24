# DWMS — Gap analysis and development roadmap

| | |
|---|---|
| Date | 24 October 2026 (revised after review, same day) |
| Compared | `DocuSoft_DWMS_Consolidated_Product_Technical_Spec.md` v1.0 (the "spec") against the three projects: this backend (`projects/test`, branch `demobase1`), the staff frontend (`projects/WMS_F`) and the client portal (`projects/docusoft-web-portal-USA/wareHouse`) |
| Audience | DocuSoft product, engineering, QA and finance |
| Stage | Prototype |

**Progress:** Sprint 1 is built in the backend (see §7). Everything from Sprint 2 onwards is still a proposal.

Status legend: ✅ built and matches the spec · 🟡 partly built or built differently · ❌ not built · ⏸ deliberately
deferred (out of scope for the prototype)

---

## 1. Decisions from the review

| Topic | Decision |
|---|---|
| Technology stack | Stay on Node.js + Express + Prisma + Postgres. No move to .NET / SQL Server. |
| Tenancy | **Not** converting to multi-tenant. One database serves one tenant (one DocuSoft agreement); each new tenant gets its own database and deployment. A DocuSoft user who works under several agreements uses each agreement's deployment; login already accepts only the rows of that deployment's agreement. |
| Users and roles | Users come from DocuSoft, and the only thing taken from DocuSoft is the admin flag (`strIsAdmin`). All other roles are assigned and stored in our Postgres database through a new user-to-role mapping table. |
| Retention and destruction | Build it, including a **certificate of destruction** that can be printed and given to the client as proof for future audits and compliance checks. |
| Contracts, charges, billing | Build them. |
| Sage and Stripe | DocuSoft's practice management system already integrates with Sage One and Stripe; reuse that integration. For now, add the connection settings only. The connection keys will come from a DocuSoft Practice API; **details to be agreed with the product owner when this feature is developed.** The Sage/Stripe proof of concept is on hold until then. |
| Engineering safeguards | Prototype stage: leave out the engineering overhead (migrations, automated test suite, background worker/outbox, correlation ids, API versioning, vault, hardening). Listed in §6 so they aren't forgotten later. |
| Physical storage model | Keep shared capacity in centimetres; add an optional `maxBoxes` per slot for exclusive positions. |
| Location hierarchy | Zone and aisle are **optional labels on the rack**; shelf = the rack's row, position = the cell. Slots, capacity and barcodes don't change. Small warehouses can ignore zones and aisles (decision 24 Oct; built in Sprint 10, taken ahead of Sprints 8 and 9). |
| Customer billing profile | Store a small local billing profile per client (billing contact, Sage contact id, tax treatment, no client master data). Planned for when billing is built, not now. |
| Movement ledger and idempotency | Went ahead with the §3 recommendations: **movement ledger built** (Sprint 1); **idempotency deferred** (option 1), revisit with option 2 before billing goes live. |

---

## 2. Summary

The current system covers most of the spec's **operational P0** (warehouse → rack → cell locations, box intake with
unique barcodes, put-away/move with atomic capacity, search, retrieval/destruction/digitize/collection orders with a
state machine, an append-only box audit trail). It is ahead of the spec on the **customer portal**: the spec schedules
the portal for P1, and ours is already live with contact-level scoping.

Remaining gaps, after the decisions above:

1. **Location history for billing** (movement ledger) and **protection against duplicate submissions**
   (idempotency) — see §3.
2. **Role model.** Four roles today, held in one column on `wh_user`; most "admin only" rules are enforced only in the
   UI. The spec has nine roles with separated duties.
3. **Retention and destruction controls.** Single-person destruction with only the client's typed name; no retention
   rules, no legal-hold record, no two-person approval, and the certificate of destruction page is a placeholder.
4. **Contracts, charge events, billing runs, invoices** — not started.
5. **Sage/Stripe connection settings** — not started.
6. **Scan-driven operations** — per-line pick scanning, a proper return flow, staging and quarantine.

---

## 3. Movement ledger and idempotency — what they mean for us

These are two separate things that the spec groups together under "custody". Each is explained below with what
happens today, what goes wrong, and what it would cost to add.

### 3.1 Movement ledger

**What happens today.** A box row stores only where it is *now* (`box.slotId`). Its history is kept in `audit_event`,
which is written for people to read on the box's History tab: locations are stored as text snapshots such as
`{ warehouse: "WH1", rack: "A-1", slot: "1-2" }`, not as ids, and some events don't carry a location at all — a
`dispatched` or `destroyed` event doesn't record which slot the box left from.

**Why it matters — storage billing.** You've asked for billing to be built. The main recurring charge in records storage
is *storage*: "client X had N boxes in warehouse W for D days this month". To calculate that you need, for every box,
the exact dates it entered and left storage and where it was in between. The spec says so explicitly (§7.2: derive
storage from movement history, never from the current location).

Without a ledger, the only options are:

- **Bill from today's snapshot** ("boxes stored right now × monthly rate"). A box stored on the 3rd and dispatched on
  the 20th is charged nothing if the job runs on the 31st; a box put away on the 30th is charged a full month. A past
  month can't be recalculated if an invoice is disputed.
- **Rebuild from `audit_event`**. That means matching text snapshots back to slots and inferring the missing "left
  from" locations from the previous event. It is fragile, and every billing run would scan the whole audit table.

**What adding it means.** One new table (`movement`). One extra row written inside the transactions that already move
boxes (put-away, transfer, found, dispatch, destruction, marked missing), holding the box, from/to slot and
warehouse ids, the date, who did it and the order. No screen changes are needed. Boxes moved before the ledger exists
have no rows, so storage billing starts from the day the ledger goes live (or we backfill from audit events on a
best-effort basis).

**A lighter alternative.** Add slot and warehouse id columns to `audit_event` and always fill both the "from" and the
"to" side. That avoids a new table, but billing would then read through every kind of audit event (edits, labels,
holds …), and the history table's purpose gets mixed with billing's.

**Recommendation:** add the `movement` table. It costs about the same as the alternative, and billing needs it.

### 3.2 Idempotency (duplicate-submission protection)

**What happens today.** If a request reaches the server and is saved, but the reply is lost on the way back (warehouse
Wi-Fi drops, the browser times out), the screen shows an error. The operator naturally presses the button again, and
the server treats it as a brand-new request.

**What goes wrong, per action:**

| Action | Effect of pressing it again after a lost reply |
|---|---|
| Register boxes | **A second set of boxes is created** with new barcodes, and a second set of labels is printed. Clean-up is manual. |
| Create a collection order (no boxes picked) | **A second, duplicate order.** |
| Create a dispatch/destruction/digitize order | Safe: the boxes are already reserved by the first order, so the second request fails. |
| Put away / move a box | Mostly safe: the box is already in that slot, so capacity isn't changed again, but a duplicate history entry is written. |
| Dispatch, destroy, complete an order | Safe: the order is already completed, so the second request is refused. |

Once billing exists, a duplicate box can also mean a duplicate intake charge and storage charges for a box that
doesn't exist.

**What adding it means.** The screen sends a unique key (`Idempotency-Key`) with each submission and reuses it if the
user retries. The server remembers the key together with its result: the same key returns the first result instead
of doing the work again. That needs one small table, a few lines on the server for the affected actions, and a small
change in the frontend to send the key.

**Options:**

1. **Defer it entirely** (in line with "no safeguards that don't matter yet"). Duplicates are cleaned up by hand.
2. **Protect only Register boxes and Create order** — the two actions that actually create duplicates. Small effort.
3. **Full spec version**, on every command. Not needed for the prototype.

**Recommendation:** option 1 for now, then option 2 before billing goes live, because that is when a duplicate box
starts to cost money.

> **Decided:** ledger yes (built in Sprint 1); idempotency option 1 for now, option 2 before billing goes live.

---

## 4. Bugs found during the review

| # | Problem | Impact | Plan |
|---|---|---|---|
| B1 | `PATCH /api/slots/:id` with `status: "blocked"` set `used = 0` while the boxes stayed in the cell | Capacity silently corrupted; the cell looked empty while boxes were still in it | ✅ Fixed (Sprint 1); run `npm run slots:recompute` to repair existing data |
| B2 | Unblocking a slot from the staff UI did nothing — the UI sends `"available"`/`"full"`, the backend only recognised `"blocked"` | Blocked cells could not be reopened from the app | ✅ Fixed (Sprint 1) |
| B3 | Slot capacity could be lowered below what is already stored (only the UI checked) | Over-full cells | ✅ Fixed (Sprint 1) |
| B4 | `patchSlot` turned every error into `404 Slot not found` | Misleading errors | ✅ Fixed (Sprint 1) |
| B5 | Placing/releasing a box hold is admin-only in the UI but open to any staff in the API | The rule can be bypassed | Sprint 2 (with the role model) |
| B6 | Staff login (`POST /api/auth/login`) has no rate limit | Password guessing against DocuSoft accounts | ⏸ Hardening (§6) |
| B7 | Completing a collection order marked lines `received` but left the boxes `out` and wrote no `received` event | Returned boxes looked like they were still with the client until someone re-allocated them | ✅ Fixed (Sprint 3 return flow) |
| B8 | `audit_event.boxId` is required, so warehouse/rack/slot/settings/role changes are never audited | Spec §12 requires audit of admin changes; needed once roles can be assigned | Sprint 2 |
| B9 | `API.md` "does NOT do" section is out of date (portal login and order pagination exist) | Misleading for integrators | ✅ Fixed (Sprint 1) |

---

## 5. Gap analysis by spec area

### 5.1 Users and roles (spec §2)

| Spec requirement | Current state | Status | Gap / action |
|---|---|---|---|
| Tenant isolation | One database per tenant (decision §1) | ✅ by deployment | No `tenantId` columns needed |
| Users | Staff verified by DocuSoft and cached in `wh_user`; portal contacts arrive in a signed token from the parent portal | ✅ | — |
| Nine roles with separated duties | One `role` column on `wh_user`: `staff_admin` (from `strIsAdmin`) or `staff_operator`; portal: `client_admin`/`client_user` | 🟡 | New `user_role` mapping table (user × role, who assigned it, when). The DocuSoft admin flag still yields `staff_admin`; every other staff role is assigned locally. Roles: warehouse admin, operator, operations manager, records/compliance manager, billing/finance manager, auditor |
| Server-side authorisation, not UI filtering | Only warehouse/rack/slot layout and box sizes are role-checked | 🟡 | Permission per action, checked against the mapping table; admin endpoint + screen to assign roles |
| Storage customer = Sage contact | Client lives only in DocuSoft; rows carry `clientId` + `clientName` | 🟡 | Local billing profile, built with billing (decision §1) |

### 5.2 Warehouse, locations, capacity (spec §4.1, §6.1)

| Spec requirement | Current state | Status | Gap / action |
|---|---|---|---|
| Hierarchy warehouse → zone → aisle → rack → shelf → position | warehouse → (zone → aisle, optional) → rack → shelf (row) → position (cell) | ✅ (Sprint 10) | — |
| Location barcodes, unique | `slot.barcode` unique | ✅ | — |
| Capacity: exclusive or shared | Shared capacity in centimetres, atomic reserve/release in SQL | ✅ | Optional `maxBoxes` per slot (decision §1) |
| Location states `ACTIVE`/`BLOCKED`/`QUARANTINED`/`INACTIVE` | `available`/`full`/`blocked` (mixes occupancy and state) | 🟡 | Split *state* from *fullness*; add quarantined/inactive (Sprint 3) |
| Receive into Goods-In/staging first, then put away | Boxes are `unallocated` with no location until put-away | 🟡 | Staging location + `received` step (Sprint 3) |
| Put-away requires scanning box **and** destination | API takes ids; scanning is done in the UI | 🟡 | Accept barcodes server-side and check the box/slot pair (Sprint 3) |
| Movement + location + capacity + audit in one transaction | Yes (`allocateBoxes`, dispatch, destroy, missing) | ✅ | — |
| Movement history with real location ids | `movement` ledger (Sprint 1) | ✅ | — |
| Same idempotency key returns the original result | — | ⏸ | Deferred (§3.2); option 2 before billing goes live |
| Corrections need a reason; history never erased | Edits/moves require a reason; audit is append-only by convention | 🟡 | Good enough for the prototype |
| Quarantined/damaged/missing excluded from picking | `missing` excluded | 🟡 | Add `quarantined` (Sprint 3) |

### 5.3 Boxes, contents, search (spec §3, §4.2)

| Spec requirement | Current state | Status | Gap / action |
|---|---|---|---|
| Immutable `BoxId`, distinct printable barcode | UUID id; `BX########` barcode, unique | ✅ | Authorised re-label keeping the same id (Sprint 3) |
| Lifecycle `REGISTERED → RECEIVED → STORED → RESERVED → PICKED → DISPATCHED → RETURN_PENDING → STORED` + `QUARANTINED`, `MISSING`, `PERMANENTLY_WITHDRAWN`, `DESTROYED` | `unallocated, stored, reserved, picked (unused), out, pending_destruction (unused), destroyed, missing, digitized` | 🟡 | Add `received`, `return_pending`, `quarantined`, `permanently_withdrawn`; make `picked` real (Sprint 3) |
| Retention category at intake | `box.retentionCategory` = code of a current retention rule | ✅ (Sprint 4) | — |
| Contents and DMS links | `box_content` lines with optional DocuSoft document id; shown in the portal | ✅ (Sprint 5) | — |
| Search and export | Search ✅; server-side streamed CSV for inventory, movements, audit, charges | ✅ (Sprint 5) | — |
| Bulk import | — | ❌ | Later |

### 5.4 Retrieval, custody, requests (spec §4.3, §6.2–§6.3)

| Spec requirement | Current state | Status | Gap / action |
|---|---|---|---|
| Request lifecycle `SUBMITTED → APPROVED → PICKING → READY → DISPATCHED/COLLECTED → RETURNED/CLOSED` + `CANCELLED`, `ON_HOLD`, `EXCEPTION` | `requested → billing → scheduled → in_progress → (ready) → completed` + `on_hold`, `cancelled`, `rejected`; mismatches go to the exception queue | ✅ (Sprint 3 + billing stage) | — |
| Each line has its own pick/dispatch/return state | Lines exist; no endpoint sets `picked`; dispatch completes all lines at once | 🟡 | Per-line pick scan; wrong box → exception (Sprint 3) |
| Location-ordered pick list | Pick list page in the UI | 🟡 | Server sorts lines by warehouse/rack/row/column (Sprint 3) |
| Handover records recipient, time, operator, proof reference | `order.delivery`: recipient, courier, tracking, dispatched at; then received by, proof reference, delivered at | ✅ (Later) | — |
| Return: scan receipt, put away, close line | Separate collection order; boxes stay `out` (B7) | 🟡 | Return flow: `return_pending` → put-away (Sprint 3) |
| Exceptions queue | Errors go back to the caller; nothing is queued | ❌ | `exception` table + supervisor queue (Sprint 3) |
| Dispatch jobs / courier / manifests | Courier + tracking on dispatch; printable delivery note | 🟡 | No separate dispatch-job/route planning |
| Customer notifications | In-app (`notification` table; portal + staff dashboards) | 🟡 | Email later (decision 24 Oct: in-app for now) |

### 5.5 Customer portal (spec P1)

| Spec requirement | Current state | Status |
|---|---|---|
| Self-service search, retrieval, status | Live: summary, boxes, box history, orders, create/cancel, authorise destruction/digitize; contact-level scoping; staff-only data stripped | ✅ |
| Approvals by customer administrator | Destruction requests from ordinary contacts wait for the main contact's approval (decision: destruction only) | ✅ |
| Download certificate of destruction | `certificate.html` (printable / save as PDF), linked from the completed order | ✅ |
| Notifications | In-app "Updates" on the dashboard; email later | 🟡 |

### 5.6 Retention and destruction (spec §4.4)

| Spec requirement | Current state | Status | Gap / action |
|---|---|---|---|
| Versioned retention rules, trigger dates, eligibility | `retention_rule` (code, years, trigger, version); due-for-destruction list | ✅ (Sprint 4) | — |
| Legal hold always overrides | `legal_hold` (box / client / category); records manager places/releases; blocks putting on and destroying | ✅ (Sprint 4) | — |
| Manifest → separate approver → operator confirms | Client authorises → records manager (not the requester) approves → operator destroys | ✅ (Sprint 4) | — |
| Certificate of destruction | `destruction_certificate`, frozen at completion; staff print page; portal page | ✅ (Sprint 4) | — |
| A scheduled job may only *suggest* | "Due for destruction" review list, computed on request | ✅ | Never destroys automatically |

**Certificate of destruction (new requirement from review).** Issued automatically when a destruction order is
completed:

- **Unique certificate number** (e.g. `COD-000123`) from the existing counter table. Content is frozen at issue and
  never changes afterwards.
- **Contents:** client name and id, order number, list of boxes (box number, barcode, description, filing date range,
  retention category), destruction method, date and place of destruction, who prepared, approved and carried it out,
  witness, and the client's authorisation (name and date).
- **Staff:** a printable page in the staff app (replaces the stub) and an endpoint returning the certificate data.
- **Client:** available to download/print from the client portal (`GET /api/portal/certificates/:id`, scoped like
  other portal data, staff-only details removed) and listed on the order.
- **Kept permanently** as audit/compliance proof, even though the boxes themselves are destroyed.
- A PDF download can be added later if a print-to-PDF from the browser is not enough.

### 5.7 Contracts, charge events, billing (spec §7) — ✅ built (Sprints 5–6)

Built as planned below, simplified for the prototype: rate cards (default + per client, dated) instead of separate
contracts; no minimum fee or billing cycle field; storage prorated by day from the movement ledger (decision 24 Oct).
Approving a billing run creates one draft invoice per client (the Sprint 7 invoice), sent to Sage as before. Original
plan:

- **Contracts and rate cards** per client, effective-dated: rate per charge type (intake, storage, retrieval,
  delivery, collection, scanning/digitizing, permanent withdrawal, destruction, other), per box size, minimum fee,
  billing cycle, VAT/tax code.
- **Charge events**, one per chargeable fact, each with a unique business identity (source, charge type, period) so
  re-running never charges twice. Service charges come from completed orders/registrations; storage charges come from
  the movement ledger (§3.1).
- **Billing runs**: generate for a closed period → finance reviews → approves; amounts and membership frozen on
  approval.
- **Invoices**: internal invoice ledger grouped by client and period, ready to hand to Sage.
- **Client billing profile** (decision §1).

### 5.8 Sage and Stripe (spec §8, §11)

All ❌. Per the review decision, we reuse DocuSoft practice management's existing Sage One and Stripe integration
rather than building our own OAuth, worker, outbox and webhook pipeline. For now:

- Add a **connection settings** record for Sage and Stripe (mode, status, last checked).
- Keys/tokens will be fetched from a **DocuSoft Practice API**, not entered or stored here. Which API, how it
  authenticates, and what it returns are **to be agreed with the product owner when this feature is developed.**
- Payment-mode routing, invoice push, checkout and reconciliation come after that discussion.

---

## 6. Deferred until after the prototype (⏸)

Kept here so they aren't lost. None of them block the prototype.

- Checked-in database migrations (keep `prisma db push` for now).
- Automated test suite.
- Background worker, transactional outbox, webhook inbox, retry/dead-letter queues.
- Correlation ids, API versioning (`/api/v1`), full machine-readable error codes.
- Optimistic concurrency version columns on box/order updates; DB-level append-only guards; `order_line (orderId, boxId)`
  unique constraint.
- Rate limit on staff login (B6); explicit `SameSite`/`Secure` cookie flags / CSRF token.
- Secrets vault; moving the DocuSoft password out of browser `localStorage`.
- `pg_trgm` search indexes, performance targets, security review, penetration test.
- Idempotency, if option 1 is chosen in §3.2.

(The error codes users actually see are pulled forward into Sprint 8 for the Spanish UI.)

---

## 7. Roadmap

Sprints are two weeks. "FE" marks work in the staff/portal frontend. Order can be changed; Sprints 1–3 are the
operational core, Sprints 4–6 add the features requested in the review.

**Sprint 1 — data-integrity fixes and ledger ✅ built (backend only; no frontend or portal changes needed)**
- B1–B4 fixed in `locationService.updateSlot` (one atomic SQL statement) and `patchSlot`; B9 fixed in `API.md`.
- `npm run slots:recompute` (dry run) / `-- --apply`: repairs slots whose `used` was zeroed by B1.
- `movement` table written by put-away, transfer, found, dispatch, destruction and marked missing;
  `GET /api/boxes/:boxId/movements`.
- Verified against a throwaway local Postgres: 25 service-level checks (every ledger path, every slot rule, the
  repair script) and HTTP checks (status codes, roles, auth).
- **Before deploying:** run `npx prisma db push` on the real database (adds the `movement` table). Until then
  allocate, move, dispatch, destroy and mark-missing will fail, because they write to that table.

**Sprint 2 — roles and permissions**
- `user_role` mapping table; DocuSoft `strIsAdmin` → `staff_admin`, all other roles assigned locally.
- Permission check per action on the server (includes B5).
- Admin endpoint to assign/remove roles; audit of role and layout/settings changes (B8). FE: Users & roles screen
  (Settings → Users is currently a stub).

**Sprint 3 — scan-driven operations ✅ built** (backend, staff frontend, client-portal labels). 80 backend checks plus
the Sprint 1/2/7 regressions pass. Order state `exception` was not added: mismatched scans go to the exception queue
instead, and a supervisor can put the order on hold.
- Location state split (active/blocked/quarantined/inactive); staging location.
- Box statuses `received`, `return_pending`, `quarantined`, `permanently_withdrawn`.
- Barcode-based put-away, per-line pick scan, location-ordered pick list, order states `ready`/`on_hold`/`exception`,
  return flow (B7), exception queue. FE: Pick and Receive screens.

**Sprints 4, 5, 6 and Later ✅ built** (backend, staff frontend, client portal) — 92 backend checks for these, plus
the Sprint 1/2/3/7 regressions (202 checks) pass. Decisions (24 Oct): notifications in-app only; storage prorated by
days; client-admin approval for destruction requests only. Behaviour change: a destruction order now needs a records
manager's approval (someone other than the requester) before it can be destroyed.

**Sprint 4 — retention, legal hold, two-person destruction, certificate**
- Retention rules + retention category on boxes; due-for-review list.
- Legal holds (records manager only), hard block on destruction.
- Prepare → approve (different person) → confirm destruction.
- Certificate of destruction: issued on completion, staff print page, portal download endpoint. FE: certificate page,
  retention/hold screens. Portal project (`docusoft-web-portal-USA/wareHouse`): certificate download.

**Sprint 5 — contracts and charges**
- Contracts and rate cards; client billing profile.
- Charge events from completed services and from storage (movement ledger).
- Inventory/movement/audit CSV exports; basic box contents with DocuSoft document ids.

**Sprint 6 — billing runs and invoices**
- Billing runs: generate, review, approve, freeze.
- Invoice ledger per client/period. FE: finance screens.

**Sprint 7 — Sage/Stripe connections ✅ built (brought forward; prototype)** — per `SAGE_ONE_INTEGRATION_REPORT.md` and the
24 Oct decisions: Sage calls and tokens in the browser like Practice; manual invoices prefilled from warehouse activity
(until Sprints 5–6 exist); client ⇄ Sage contact through DocuSoft's `CCode`; Sage first, Stripe read-only.
- Backend: `invoice` / `invoice_line`, suggested lines, sending lock + issued/send-failed hand-over, Sage defaults
  (`/api/settings/sage`), `billing.view` / `billing.manage` permissions. 52 backend checks pass.
- Staff frontend: one Sage module (`src/api/sage.ts`; fixes report findings 3, 4, 6, 8), Invoices list / new / detail,
  Send to Sage (contact by CCode → Sage reference → created; an existing Sage invoice with our number is reused, never
  duplicated), Settings → Sage One, Stripe payments of the client (read-only, via Practice's proxy). 12 unit tests.
- Sending to Sage first checks that Sage One is the practice's active accounting system (`Json_GetXeroQBDetails`, as
  Practice); if not, nothing is sent and an admin is pointed to Practice → Settings, anyone else to their administrator.
- Open: verify the VAT ids (`GB_LOWER` etc.) and the whole flow against a real Sage test business. (Card payments: the
  Stripe proxy can charge a card — `attachCard` + `makePayment`, as the proposals page does; used by the billing stage
  below.)

**Billing stage in the order flow ✅ built** — the order flow is now **Request → Billing → Schedule → In progress →
Complete** (backend, staff frontend, client portal; 127 backend checks, regressions pass).
- Approving a request moves it to `billing` (staff-created orders start there). Finance raises the order's invoice
  (`POST /api/invoices` with `orderId`) and sends it to Sage; Sage's total incl. VAT is what the customer pays.
- The customer pays by card on the order page in the portal (Stripe through DocuSoft's proxy, like the proposals page;
  needs the client's Stripe customer on its DocuSoft card), or finance records a bank transfer. Finance may waive
  billing with a reason (no charge). **Schedule is locked until paid, acknowledged or waived** (decision 24 Oct).
- **Payment not required** (clients billed monthly / annually on account): a tick on the order's Billing card. The
  invoice is still raised and sent to Sage, but the customer only **acknowledges** it in the portal (or finance records
  the acknowledgement); the order then goes ahead and the invoice stays owed on the client's account.
- **Standing accounts** (Billing → Accounts): per client, for a period — invoices raised, how many paid, invoiced /
  paid / owed — plus the whole balance and how much is overdue; a statement page per client. Paid amounts come from
  portal card payments, payments finance records on an invoice (part payments allowed) and **Update from Sage** (reads
  each invoice's outstanding amount from Sage in the browser; a fully paid order invoice also settles its order).
- Orders from before the billing stage show "Approved" in the progress steps and can still be scheduled.
- An order billed at this stage is left out of the monthly charge run (no double billing); a waived one is still charged
  by the run.
- **Phase 2 (when the rate card work is picked up): prefill the order's invoice lines from the client's rate card.**
  Phase 1 (now): finance types the lines (decision 24 Oct).
- Open: the WMS doesn't mark the Sage invoice paid — record the payment in Sage too (the Sage proxy has no payment
  call); "Update from Sage" then brings it back. A card payment is reported by the portal; staff can check it against
  Stripe on the order page. A card that needs 3-D Secure isn't handled by the proxy's `makePayment` (same as the
  proposals page). Next: a billing cycle per client (pay per order / monthly / annual) sets "payment not required"
  automatically — Sprint 9.

**Sprint 8 — UI language: English / Spanish (proposed)** — staff frontend and client portal; no backend change except
error codes.
- Language button in the header of both apps: **English (default)** / **Español**. The choice is remembered in the
  browser and applies straight away, without reloading the page.
- **Translation files, not the browser's translator.** Every piece of UI text moves into an English and a Spanish
  message file (staff app: `next-intl`; portal: a small `t()` helper reading the same kind of JSON file). The Spanish
  text is first machine-translated, then checked by a Spanish speaker against a short glossary of warehouse terms
  (put-away, slot, legal hold, retention category …).
- Why not the browser's built-in translation: the page translation in Chrome/Edge/Safari is started by the user, not by
  our button, and each browser behaves differently; it rewrites the page text behind React's back, a known cause of
  crashes in React apps; and it also translates barcodes, box numbers, client names and descriptions. Chrome's
  on-device Translator API can be called from a button, but it works only in desktop Chrome, downloads a language model
  on first use, and has the same React and wording problems. Neither lets us review what operators and clients read.
- Dates and numbers follow the chosen language (`date-fns` locale / `Intl`).
- API error messages are English text today. Errors shown to users get a code that the frontend translates — the
  user-facing subset of the error codes deferred in §6.
- Not translated: what people type (box descriptions, notes, client and contact names) and barcodes. **Open question
  for the product owner:** should documents given to clients (certificate of destruction, delivery note, invoices) be
  issued in the client's language?
- Most of the effort is moving text out of every screen into the message files; the staff app is the larger part.

**Sprint 9 — client billing cycle (planned)** — backend, staff frontend, client portal. Every client gets a billing
cycle that decides how its orders are billed at the billing stage:
- **Pay per order** (default): each order's invoice must be paid (portal card / recorded payment) before scheduling —
  today's behaviour.
- **Monthly / annual (on account)**: the order's "Payment not required" is ticked automatically — the client only
  acknowledges the invoice and the order goes ahead; the invoice stays owed on the standing account. Finance can still
  untick it for one order (e.g. a large job paid up front).
- Stored per client in a small `client_billing_profile` table keyed by the DocuSoft client id (clients themselves stay
  in DocuSoft): cycle, effective from, who changed it — history kept, every change in the admin log.
- Staff: set the cycle on the client (Billing → Accounts → client, and visible on the order's Billing card); the
  Accounts list shows each client's cycle and can be filtered by it.
- Portal: the client sees its billing cycle; on-account clients see "acknowledge" instead of "pay".
- Open question for the product owner: should monthly / annual clients get **one periodic invoice** (the billing run,
  Sprint 6) instead of one invoice per order? If so, their orders would only need acknowledging an order summary, not
  an invoice, and the billing run would pick their orders up at month / year end.

**Sprint 10 — warehouse hierarchy: zones and aisles ✅ built** (taken ahead of Sprints 8 and 9, which wait) — backend and
staff frontend; no portal change (clients only see the warehouse name). Spec hierarchy warehouse → zone → aisle → rack → shelf → position (§5.2), built on top of
today's layout instead of replacing it (decision 24 Oct):

| Level | Comes from |
|---|---|
| Warehouse | as today |
| Zone | **new**, optional, set on the rack |
| Aisle | **new**, optional, set on the rack; sits in a zone **or straight in the warehouse** (changed while building: a small warehouse that only numbers its aisles shouldn't have to invent a zone) |
| Rack | as today |
| Shelf | the rack's row (already has row stats and row blocking) |
| Position | the cell / slot (row × column) — capacity in cm, barcode, `box.slotId` all unchanged |

- **Database (additive, plain `db push`, no backfill):** new `zone` (warehouse, code, name) and `aisle` (warehouse,
  zone?, code, name) tables; `rack.zoneId` / `rack.aisleId`, both optional, indexed. A rack may have a zone without an aisle; an
  aisle implies its zone. Existing racks start with neither. New admin actions: zone/aisle created, updated, deleted;
  rack moved to another zone/aisle. Deleting a zone or aisle that still has racks is refused.
- **Small warehouses lose nothing:** with no zones, screens and pickers look exactly like today (empty levels are
  skipped; racks without a zone/aisle are grouped under "No zone").
- **Two ways to choose a location** (registration's allocate step, Move box, put-away):
  1. **Browse:** warehouse → zone → aisle → rack → shelf/position grid. One call returns a warehouse's whole tree (zones →
     aisles → racks with capacity totals) and the browser filters the dropdowns — same number of calls as today
     (warehouse list, warehouse contents, rack grid).
  2. **Type or scan a code:** `B04-3` = rack B04, shelf 3 → the app fills in warehouse, zone, aisle and rack and picks
     the best-fitting position on that shelf (the user can change it); `B04-3-2` = that exact position; the full slot
     barcode (`SL-…`) still works. One indexed lookup (`GET /api/locations/resolve?code=`), read from the right so rack
     codes containing dashes still resolve; no match → "did you mean" suggestions; a wrong scan still goes to the
     exceptions queue.
- **Rack codes unique across all warehouses** for new and renamed racks, so a code is enough on its own. If existing
  racks share a code in two warehouses, the lookup asks which warehouse instead of guessing.
- **Location snapshot** (`box.locationPath`, audit, movement, order lines) gains optional `zone` and `aisle`; old
  snapshots stay as they are (history is append-only) and display fine because only keys are added. One shared
  formatter shows "WH1 › Zone A › Aisle 3 › Rack B04 › Shelf 3 · Position 2", skipping missing parts. Replaces
  `rackLabelFor` (fixes the `n-ew-1` rack label bug). Moving a rack to another zone/aisle refreshes the stored location of
  the boxes already in it, in the same transaction.
- **Capacity totals** per zone and aisle from one grouped query (cm used per rack), like the warehouse/rack totals today.
- **Staff screens:** warehouse page manages zones and aisles and groups racks under them; Add/Edit rack gets Zone and
  Aisle; rack page calls rows "Shelf 1…n"; location paths everywhere use the shared formatter; new print page for shelf
  / position labels (today only box labels print).
- **Nice to have in the same sprint:** suggestions also prefer the client's aisle/zone; pick lists sorted zone → aisle →
  rack → shelf (shorter walk).
- **Not affected:** slots and capacity, existing barcodes, put-away/allocation/pick logic, storage billing (box-days per
  warehouse from the movement ledger), the billing stage, the portal.
- **Not in scope (would need the full model):** shelves with their own names, or a different number of positions per
  shelf in one rack — block or deactivate single positions instead.
- Built as: `GET /warehouses/:id/layout`, zone / aisle create / rename / move / remove (`layout.manage`, admin log),
  `PATCH /racks/:id` takes label / zoneId / aisleId, `GET /locations/resolve`, put-away by shelf code, suggestions
  prefer the client's aisle / zone, pick lists in walking order, CSV export with the full path, optional
  `npm run locations:refresh -- --apply` to rewrite old stored locations once. Staff app: Zones & aisles dialog and
  grouped racks on the warehouse page, zone / aisle in Add / Edit rack, rows shown as shelves with their code, one
  "type a code or browse" picker for registration and Move box, shelf / position label printing
  (`/print/location-labels`). A numbers-only rack code is refused (`12-3` would read as a shelf).

**Later — customer operations (spec P1)**
- Customer-admin approval of contacts' requests, email notifications, dispatch jobs with courier and proof of delivery.
  Built: main-contact approval of destruction requests, in-app notifications, courier/tracking + proof of delivery,
  delivery note. Not yet: email.

---

## 8. Spec stories → where they land

| Story | Today | Lands in |
|---|---|---|
| W01 warehouse + barcode locations | ✅ (state split pending) | Sprint 3 |
| W02 receive and label 100 boxes | ✅ | — |
| W03 scan box into location, atomic + history | 🟡 (ledger ✅) | Sprint 3 (barcode check) |
| W04 replay after timeout, no duplicate | ⏸ | Idempotency option 2, before billing goes live |
| W05 scoped search, cross-customer denial | ✅ | — |
| W06 retrieve and return, custody history | 🟡 | Sprint 3 |
| W07 correction cannot erase history | 🟡 | Good enough for the prototype |
| P01 portal retrieval | ✅ | — |
| C01 legal hold + separate approvals + certificate | ✅ | Sprint 4 |
| B01–B02 pricing, re-run billing without duplicates | ✅ | Sprints 5–6 |
| S01–S04, ST01–ST03 Sage/Stripe | 🟡 (Sage built; Stripe read-only) | Sprint 7 |
| SEC01 cross-tenant denial | ✅ by deployment (separate database per tenant) | — |
