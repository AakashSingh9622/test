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
| B7 | Completing a collection order marks lines `received` but leaves the boxes `out` and writes no `received` event | Returned boxes look like they are still with the client until someone re-allocates them | Sprint 3 (return flow) |
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
| Hierarchy warehouse → zone → aisle → rack → shelf → position | warehouse → rack → cell (row × column) | 🟡 | Enough for the prototype |
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
| Retention category at intake | Only a `destroyAfter` date | ❌ | Retention category on the box, linked to retention rules (Sprint 4) |
| Contents and DMS links | — | ❌ | Basic content lines with optional DocuSoft document id (Sprint 5) |
| Search and export | Search ✅ (case-insensitive contains); CSV export only in the browser for one page/history | 🟡 | Server-side CSV exports for inventory, movements, audit (Sprint 5) |
| Bulk import | — | ❌ | Later |

### 5.4 Retrieval, custody, requests (spec §4.3, §6.2–§6.3)

| Spec requirement | Current state | Status | Gap / action |
|---|---|---|---|
| Request lifecycle `SUBMITTED → APPROVED → PICKING → READY → DISPATCHED/COLLECTED → RETURNED/CLOSED` + `CANCELLED`, `ON_HOLD`, `EXCEPTION` | `requested → approved → scheduled → in_progress → completed` + `cancelled`, `rejected` | 🟡 | Add `ready`, `on_hold`, `exception`; keep `scheduled` (Sprint 3) |
| Each line has its own pick/dispatch/return state | Lines exist; no endpoint sets `picked`; dispatch completes all lines at once | 🟡 | Per-line pick scan; wrong box → exception (Sprint 3) |
| Location-ordered pick list | Pick list page in the UI | 🟡 | Server sorts lines by warehouse/rack/row/column (Sprint 3) |
| Handover records recipient, time, operator, proof reference | Recipient name only | 🟡 | `proofReference` (Stage 2) |
| Return: scan receipt, put away, close line | Separate collection order; boxes stay `out` (B7) | 🟡 | Return flow: `return_pending` → put-away (Sprint 3) |
| Exceptions queue | Errors go back to the caller; nothing is queued | ❌ | `exception` table + supervisor queue (Sprint 3) |
| Dispatch jobs / courier / manifests | — | ❌ | Stage 2 |
| Customer notifications | — | ❌ | Stage 2 |

### 5.5 Customer portal (spec P1)

| Spec requirement | Current state | Status |
|---|---|---|
| Self-service search, retrieval, status | Live: summary, boxes, box history, orders, create/cancel, authorise destruction/digitize; contact-level scoping; staff-only data stripped | ✅ |
| Approvals by customer administrator | Main contact sees all orders; no approval step for other contacts' requests | 🟡 (Stage 2) |
| Download certificate of destruction | — | ❌ (Sprint 4) |
| Notifications | — | ❌ (Stage 2) |

### 5.6 Retention and destruction (spec §4.4)

| Spec requirement | Current state | Status | Gap / action |
|---|---|---|---|
| Versioned retention rules, trigger dates, eligibility | `destroyAfter` per box | ❌ | `retention_rule` table (category, trigger, duration, version); eligibility calculation; "due for review" list |
| Legal hold always overrides | Box-level `onHold` blocks new orders | 🟡 | `legal_hold` table (scope: box / client / retention category, authority, reason, start/end); only a records/compliance manager can release one; destruction hard-blocked while any hold applies |
| Manifest → separate approver → operator confirms | Client types name + picks method; any staff marks destroyed; optional witness | 🟡 | Records manager prepares the manifest (the destruction order) → a **different** authorised person approves (enforced: approver ≠ preparer) → operator confirms physical destruction |
| Certificate of destruction | Placeholder page only (`/print/destruction-certificate/[orderId]` is a stub); nothing stored | ❌ | See below |
| A scheduled job may only *suggest* | No job | ❌ | "Due for destruction" suggestions only; never destroys automatically |

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

### 5.7 Contracts, charge events, billing (spec §7) — to be built

All ❌. What gets built:

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

**Sprint 3 — scan-driven operations**
- Location state split (active/blocked/quarantined/inactive); staging location.
- Box statuses `received`, `return_pending`, `quarantined`, `permanently_withdrawn`.
- Barcode-based put-away, per-line pick scan, location-ordered pick list, order states `ready`/`on_hold`/`exception`,
  return flow (B7), exception queue. FE: Pick and Receive screens.

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

**Sprint 7 — Sage/Stripe connections**
- Connection settings; keys from the DocuSoft Practice API (to be agreed with the product owner first).
- Invoice push and payment flow, using the existing practice-management integration.

**Later — customer operations (spec P1)**
- Customer-admin approval of contacts' requests, email notifications, dispatch jobs with courier and proof of delivery.

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
| C01 legal hold + separate approvals + certificate | ❌ | Sprint 4 |
| B01–B02 pricing, re-run billing without duplicates | ❌ | Sprints 5–6 |
| S01–S04, ST01–ST03 Sage/Stripe | ❌ | Sprint 7 |
| SEC01 cross-tenant denial | ✅ by deployment (separate database per tenant) | — |
