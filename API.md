# Warehouse Management API — Reference

Base URL (local dev): `http://localhost:5000`. Every endpoint below is prefixed with `/api`.

This document is written for consuming this API from **any** client — including a separate
project (e.g. a client-facing portal) that isn't the staff frontend this backend was originally
built alongside. Everything you need to call it is here; you shouldn't need to read the backend's
source to use it.

## Authentication

Auth is cookie-based. There is no API-key/bearer-token mode.

1. `POST /api/auth/login` with `{ email, password }` (the user's real DocuSoft credentials).
   On success you get back `{ user, token, agrno }`. `token` is a bearer-less session token —
   **you must set it yourself** as a cookie named `wms_session` on the client making subsequent
   requests (`document.cookie = "wms_session=" + token + "; path=/"` in a browser, or an
   equivalent cookie jar in a non-browser client).
2. Every other endpoint reads that `wms_session` cookie to identify the caller. No cookie (or an
   invalid one) → `401 { message: "Not authenticated" }`.
3. `GET /api/auth/me` → returns the current user (same shape as `login`'s `user`), or `401` if not
   logged in.
4. `POST /api/auth/logout` → `{ ok: true }`. Stateless — this just tells you to discard the cookie
   client-side; the server doesn't track sessions.

Only **staff** accounts work right now (`staff_admin` / `staff_operator`, determined by DocuSoft's
own `strIsAdmin` flag on login — not something you pass in). Client/portal-user login is not wired
up yet.

```jsonc
// POST /api/auth/login response
{
  "user": { "id": "<uuid>", "name": "Jane Doe", "email": "jane@x.com", "side": "staff", "roles": ["staff_admin"] },
  "token": "<opaque session token — set as the wms_session cookie>",
  "agrno": "12345" // DocuSoft agreement number; not needed by this API, only by direct DocuSoft calls
}
```

### Roles

- `staff_admin` — everything `staff_operator` can do, plus creating warehouses/racks.
- `staff_operator` — everything else (boxes, orders, audit) with no extra restriction.

A `403 { message: "You do not have access to this resource" }` means the logged-in role doesn't
permit that specific action (currently only warehouse/rack creation is role-gated).

## Clients are NOT part of this API

There is no `/api/clients` endpoint and no Client database record. Clients live entirely in
DocuSoft and are looked up by calling DocuSoft's own API directly (not through this backend) —
see the frontend's `src/store/docusoftApi.ts` / `src/api/docusoft.ts` for that integration if
you're building a new consumer and need client lookups too.

Every place below that takes a `clientId` expects **DocuSoft's ClientID/OriginatorNo as a plain
string** — this API does not validate it against anything, it just stores whatever you send
(alongside a `clientName` you must also send, since this API can't look the name up itself).

## Common error shape

```jsonc
{ "status": false, "message": "Human-readable reason" }
```

(`GET /api/auth/me` and a few early endpoints omit `status`, just `{ "message": "..." }` — treat
both the same way: HTTP status code is authoritative, `message` is for display.)

| Status | Meaning |
|---|---|
| 400 | Bad input / invalid state for the action requested |
| 401 | Not authenticated (missing/invalid `wms_session` cookie) |
| 403 | Authenticated, but role doesn't allow this action |
| 404 | Resource doesn't exist |
| 409 | Conflict — duplicate code, or an invalid order status transition |
| 500 | Unexpected server error |

---

## Warehouses / Zones / Aisles / Racks / Slots

Hierarchy warehouse → zone → aisle → rack → shelf → position (Sprint 10). **Zone and aisle are optional** labels on the
rack (an aisle sits in a zone or straight in the warehouse; a rack in an aisle carries the aisle's zone). **Shelf = the
rack's row, position = the cell (slot)** — slots, capacity and barcodes are unchanged. Rack codes of new racks are unique
across all warehouses, so `B04-3` finds a shelf on its own.

```text
GET    /api/warehouses                              -> Warehouse[]
POST   /api/warehouses        {code,name,address?}   -> Warehouse            (staff_admin only, 201)
GET    /api/warehouses/:id                           -> Warehouse
GET    /api/warehouses/:id/racks                     -> Rack[]
POST   /api/warehouses/:id/racks  { code, label, rows, columns, cellLength, lengthUnit?: "cm" | "ft", zoneId?, aisleId? }
       # every row x column cell is ONE storage location (slot) of length `cellLength` (feet are converted
       # to whole centimetres and stored); no sub-slots. Response Rack includes cellLengthCm.
                                                      -> Rack                 (staff_admin only, 201)
                                                      — also creates rows×columns Slot documents
GET    /api/warehouses/:id/layout                    -> { zones: Zone[], aisles: Aisle[], racks: Rack[] }
       # one call for the browse picker / warehouse page; zones and aisles carry rackCount, usedCapacity, totalCapacity
POST   /api/warehouses/:id/zones   { code, name? }              -> Zone    (layout.manage, 201; code unique per warehouse)
POST   /api/warehouses/:id/aisles  { code, name?, zoneId? }     -> Aisle   (layout.manage, 201; code unique per warehouse)
PATCH  /api/zones/:id              { code?, name? }             -> Zone    (layout.manage)
PATCH  /api/aisles/:id             { code?, name?, zoneId? }    -> Aisle   (layout.manage; its racks move with it)
DELETE /api/zones/:id | /api/aisles/:id                         -> 204     (409 while it still has racks / aisles)
GET    /api/locations/resolve?code=&needCm=&warehouseId=        -> LocationLookup   (any staff)
       # "B04-3" shelf (suggestedSlotId = best fit for needCm), "B04-3-2" position, a slot barcode, or "B04" rack;
       # read from the right, so rack codes with dashes work. kind: position | shelf | rack | ambiguous | not_found
GET    /api/racks/:id                                -> Rack (with zone / aisle objects)
GET    /api/racks/:id/slots                          -> Slot[]
PATCH  /api/slots/:id         { status?, capacity? (cm) }  -> Slot   (staff_admin only)
POST   /api/slots/suggest     SuggestSlotsInput       -> SlotSuggestion[]
```

```ts
interface Warehouse { id: string; code: string; name: string; address?: string;
  rackCount: number; slotCount: number; usedCapacity: number; totalCapacity: number }
interface Rack { id: string; warehouseId: string; zoneId?: string; aisleId?: string; code: string; label: string;
  rows: number /* shelves */; columns: number /* positions per shelf */; cellLengthCm: number;
  usedCapacity: number; totalCapacity: number }
interface Zone { id: string; warehouseId: string; code: string; name?: string; rackCount?: number;
  usedCapacity?: number; totalCapacity?: number }
interface Aisle extends Zone { zoneId?: string }
interface Slot { id: string; rackId: string; warehouseId: string; code: string; barcode: string;
  row: number; column: number; capacity: number /* cm */; used: number /* cm of boxes inside */;
  status: "available" | "full" | "blocked" }
```

`usedCapacity`/`totalCapacity`/`rackCount`/`slotCount` are always computed live — you never set
them directly. `Slot.used` is never set through the API either: it is the total length of the boxes in the cell.

`PATCH /api/slots/:id` rules:

- `status: "blocked"` stops new boxes going in. Boxes already in the cell **stay there and keep counting** in `used`.
- `status: "available"` or `"full"` both mean *unblock*; the real status is then worked out from `used` and
  `capacity` (`used >= capacity` → `"full"`). Any other value → `400`.
- `capacity` must be a positive whole number of cm and can't go below `used` → otherwise `409`
  (`Slot 1-2 already holds 40 cm, which is more than 30 cm -- move boxes out first`).
- Unknown slot → `404`.

**Duplicate codes are rejected**: a warehouse `code`, and a rack `code` within the same warehouse,
must be unique. Violating either returns `409` with a specific message
(`Rack code "A01" already exists in this warehouse`).

---

## Boxes

```text
GET    /api/boxes?q=&clientId=&status=&onHold=&warehouseId=&orderId=&page=&pageSize=
                                                       -> { items: Box[], total: number }
GET    /api/boxes/:id                                 -> Box
GET    /api/boxes/:id/orders                          -> Order[]   (every order this box has ever been on)
GET    /api/boxes/:id/movements?page=&pageSize=       -> { items: Movement[], total: number }   (newest first)
POST   /api/boxes/batch       CreateBoxesBatchInput    -> Box[]                        (201)
POST   /api/boxes/mark-label-printed  { boxIds: string[] }   -> { ok: true }
POST   /api/slots/suggest     SuggestSlotsInput        -> SlotSuggestion[]
POST   /api/boxes/allocate-batch  AllocateBoxesInput   -> Box[]
PATCH  /api/boxes/:id         UpdateBoxDetailsInput     -> Box
POST   /api/boxes/:id/hold    { reason: string }        -> Box
DELETE /api/boxes/:id/hold                              -> Box
POST   /api/boxes/:id/missing { note: string }           -> Box
```

```ts
type BoxStatus = "unallocated" | "stored" | "reserved" | "picked" | "out"
               | "pending_destruction" | "destroyed" | "missing" | "digitized"
type BoxSize = string // a size code from GET /api/settings/box-sizes: "standard", "large" or one an admin added ("archive-xl")

interface Box {
  id: string; boxNumber: string; barcode: string;
  clientId: string; clientName: string;
  description: string; department?: string; reference?: string;
  filingDateFrom: string; filingDateTo?: string; destroyAfter?: string; // ISO date strings
  size: BoxSize; status: BoxStatus; onHold: boolean; holdReason?: string; labelPrinted: boolean;
  slotId?: string;
  // set once status is "stored"; zone / aisle / shelf / position since Sprint 10 (older rows: warehouse, rack, slot)
  locationPath?: { warehouse: string; zone?: string; aisle?: string; rack: string; slot: string; shelf?: number; position?: number };
  openOrder?: { id: string; orderNumber: string; type: OrderType; status: OrderStatus }; // set once "reserved"
  createdAt: string; createdBy: { id: string; name: string; side: "staff" | "client" | "system" };
}

interface CreateBoxesBatchInput {
  clientId: string; clientName: string; quantity: number; // 1 call creates `quantity` boxes
  description: string; department?: string; reference?: string;
  filingDateFrom: string; filingDateTo?: string; destroyAfter?: string; size: BoxSize;
  orderId?: string; orderNumber?: string; // stamps the "registered" audit event, optional
  overrides?: { index: number; description?: string; reference?: string }[]; // per-box overrides within the batch
}

interface SuggestSlotsInput {
  clientId: string; boxSizes: BoxSize[]; // one entry per box you're about to place
  warehouseId?: string; // restrict suggestions to one warehouse
  preferSlotIds?: string[]; // e.g. the box's previous slot, scored higher
}
interface SlotSuggestion {
  slotId: string; locationPath: { warehouse: string; rack: string; slot: string };
  freeCapacity: number; score: number; reasons: string[]; // top 5, highest score first
}

interface AllocateBoxesInput {
  allocations: { boxId: string; slotId: string }[];
  reason?: string; // recommended when re-allocating an already-stored box (a "move")
}

interface UpdateBoxDetailsInput {
  description?: string; department?: string; reference?: string;
  filingDateFrom?: string; filingDateTo?: string; destroyAfter?: string;
  reason: string; // required — recorded on the audit trail
}
```

```ts
// Custody / location ledger: one row per physical change of a box's location, never edited or deleted.
// Unlike the audit trail it holds real slot and warehouse ids, so storage time per warehouse can be worked out.
type MovementType = "put_away"   // into a slot from nowhere: a new box, or a box back from the client
                  | "transfer"   // slot -> slot (a move)
                  | "found"      // a box marked missing is placed in a slot again
                  | "dispatched" | "destroyed" | "marked_missing" // out of its slot
interface Movement {
  id: string; boxId: string; boxNumber: string; clientId: string; type: MovementType;
  fromSlotId?: string; fromWarehouseId?: string; toSlotId?: string; toWarehouseId?: string;
  fromLocation?: { warehouse: string; rack: string; slot: string }; toLocation?: { warehouse: string; rack: string; slot: string };
  orderId?: string; orderNumber?: string;
  reason?: string; // move reason, missing note, dispatch recipient or destruction method
  actor: { id: string; name: string; side: "staff" | "client" | "system" }; at: string;
}
```

Allocating a box to the slot it is already in writes no movement (nothing moved).

**Box status is derived from actions, not settable directly**: registering sets `"unallocated"`;
`allocate-batch` sets `"stored"`; creating a non-collection order with this box sets `"reserved"`;
dispatching sets `"out"`; destroying sets `"destroyed"`. There's no endpoint to set `status`
directly.

**Default search excludes destroyed boxes** — pass `status=destroyed` explicitly to include them.

---

## Orders

```text
GET    /api/orders?type=&status=&clientId=&q=         -> Order[]
POST   /api/orders             CreateOrderInput         -> Order   (201; status starts "approved")
GET    /api/orders/:id                                  -> Order
GET    /api/orders/:id/lines                            -> OrderLine[]
POST   /api/orders/:id/approve                          -> Order   (requested -> approved)
POST   /api/orders/:id/reject        { reason }          -> Order   (requested -> rejected)
POST   /api/orders/:id/schedule      { scheduledFor }     -> Order   (approved -> scheduled)
POST   /api/orders/:id/start                            -> Order   (scheduled -> in_progress)
POST   /api/orders/:id/cancel        { reason }          -> Order   (anything before completed -> cancelled)
POST   /api/orders/:id/dispatch      { recipientName }    -> Order   (dispatch orders only -> completed)
POST   /api/orders/:id/authorise-digitization   { name, note?, reference? }   (digitize orders)
POST   /api/orders/:id/digitize                      (digitize, in_progress, authorised -> boxes digitized, order completed)
POST   /api/orders/:id/authorise-destruction
                                { name, method, reference? }  -> Order  (destruction orders only)
POST   /api/orders/:id/destroy       { witness? }          -> Order   (destruction orders only -> completed;
                                                                        authorise-destruction must run first)
POST   /api/orders/:id/complete                         -> Order   (collection orders only -> completed)
```

```ts
type OrderType = "collection" | "dispatch" | "destruction" | "digitize"
type OrderStatus = "requested" | "approved" | "scheduled" | "in_progress"
                 | "completed" | "cancelled" | "rejected"
type DestructionMethod = "shred" | "pulp" | "incinerate"

interface Order {
  id: string; orderNumber: string; // e.g. "DSP-000001" / "COL-000001" / "DST-000001"
  type: OrderType; status: OrderStatus;
  clientId: string; clientName: string;
  requestedBy: { id: string; name: string; side: "staff" | "client" | "system" };
  requestedVia: "staff" | "portal";
  createdAt: string; scheduledFor?: string; completedAt?: string;
  address?: string; contactName?: string; contactPhone?: string; notes?: string;
  boxCount: number; // fixed at creation, doesn't shrink if a box is later removed
  lineSummary: Record<OrderLineStatus, number>; // recomputed on every line-status change
  destruction?: { method: DestructionMethod; authorisedBy: string; authorisedAt: string; witness?: string };
  collection?: { expectedNewBoxes: number };
}

type OrderLineStatus = "pending" | "picked" | "dispatched" | "received" | "destroyed" | "digitized" | "missing" | "removed"
interface OrderLine {
  id: string; orderId: string; boxId?: string; boxNumber?: string; status: OrderLineStatus;
  fromLocation?: { warehouse: string; rack: string; slot: string };
  scannedAt?: string; scannedBy?: { id: string; name: string; side: string };
}

interface CreateOrderInput {
  type: OrderType; clientId: string; clientName: string;
  boxIds?: string[]; // dispatch/destruction: the boxes being requested; collection: usually omitted
  expectedNewBoxes?: number; // collection orders only
  address?: string; contactName?: string; contactPhone?: string; scheduledFor?: string; notes?: string;
}
```

### Order lifecycle

```
requested ──approve──> billing ──schedule*──> scheduled ──start──> in_progress ──┐
    │                     │                       │                              │
  reject               cancel                  cancel                       (type-specific
    │                     │                       │                         completion action
    v                     v                       v                         below) ──> completed
 rejected              cancelled               cancelled
                        * only once billing is paid or waived (409 otherwise)
```

Orders created through `POST /api/orders` (staff) start at `billing`; portal requests start at `requested` and go to
`billing` when approved. `approved` exists only on orders from before the billing stage — they can still be scheduled.
Any transition not shown above → `409 invalid_transition` (plus `on_hold` / resume and `ready`, see Sprint 3).

**Billing stage** (`order.billing`): `awaiting_invoice` → `invoice_draft` → `awaiting_payment` → `paid`; with
"payment not required" (on account) → `awaiting_acknowledgement` → `acknowledged`; or `waived`. Settled = paid /
acknowledged / waived.

```text
POST /api/invoices { orderId, clientId, clientName, invoiceDate, dueDate, lines, ... }   billing.manage — the order's invoice
     (one per order, same client; every line points at the order). Deleting the draft -> awaiting_invoice again.
POST /api/invoices/:id/issued { ..., grossTotal?, currency?, stripeCustomerId? }      -> awaiting_payment (amount = grossTotal, else net)
POST /api/orders/:id/billing/payment { method: bank_transfer|card|other, reference?, amount?, note? }  billing.manage -> paid
POST /api/orders/:id/billing/waive   { reason }                                        billing.manage -> waived
POST /api/orders/:id/billing/payment-required { required }   billing.manage — false = on account: acknowledge, don't pay
POST /api/orders/:id/billing/acknowledge      { note? }      billing.manage — the client acknowledged (email / phone)
POST /api/portal/orders/:id/acknowledge-invoice               the client acknowledges in the portal -> acknowledged

POST /api/invoices/:id/payments { amount, method, reference?, date?, note? }  billing.manage — any invoice in Sage, part
     payments allowed; a fully paid order invoice also pays its order
GET  /api/invoices/sage-sync?clientId=   -> invoices to check in Sage    POST /api/invoices/sage-sync
     { items: [{ invoiceId, totalAmount, outstandingAmount }] } -> { updated, ordersPaid }   ("Update from Sage")
GET  /api/billing/accounts?from&to&q&page   -> { items: [{ clientId, clientName, invoices, paidInvoices, unpaidInvoices,
     invoiced, paid, outstanding, balance, overdue, lastInvoiceDate }], total, totals }   (billing.view)
GET  /api/billing/accounts/:clientId?from&to -> { summary, items, earlierUnpaid, drafts }   one client's statement
POST /api/portal/orders/:id/payment  { paymentIntentId, amount (minor units), currency }  card paid in the portal -> paid
```

The portal charges the card through DocuSoft's Stripe proxy (`attachCard` + `makePayment`) and then reports it; the
amount must equal the invoice total. Repeating the same `paymentIntentId` is harmless; a different one on a paid order
is `409`. The monthly charge run skips an order billed at this stage (invoice issued / paid); a waived order is charged.
Phase 1: invoice lines are typed by finance; prefilling them from the rate card comes later. Invoices carry `amountPaid`,
`outstanding`, `paidAt`, `payments` and `sageSyncedAt`; the standing accounts count invoices in Sage (`issued`) only.

Type-specific completion, once `in_progress`:
- **dispatch** → `POST /:id/dispatch` (needs `recipientName`) — releases each box's slot, box
  status → `out`, line status → `dispatched`, order → `completed`.
- **destruction** → `POST /:id/authorise-destruction` first (doesn't change order status, just
  records who/how), **then** `POST /:id/destroy` — releases each box's slot, box status →
  `destroyed`, line status → `destroyed`, order → `completed`. Calling `destroy` before
  `authorise-destruction` → `400`.
- **collection** → `POST /:id/complete` directly from `in_progress` — no boxes to release (this
  order type is about *receiving* new boxes, which you then register separately via
  `POST /api/boxes/batch`, optionally passing this order's `id`/`orderNumber`).

**Eligibility rules enforced on `boxIds` at creation** (`400` with a specific reason if violated):
- `collection` orders don't take `boxIds` in practice (a box must already be `"out"` to be
  eligible, which none newly-registered are).
- `dispatch`/`destruction`: the box must be `stored` (not already on another order, not on hold).

Rejecting or cancelling an order automatically reverts any of its boxes still `"reserved"` back to
`"stored"` and clears their `openOrder`.

---

## Audit

```text
GET /api/audit?boxId=&clientId=&orderId=&type=&visibleToClientOnly=&page=&pageSize=
    -> { items: AuditEvent[], total: number }
```

You never write audit events directly — every Box/Order action above appends the relevant ones
automatically (registration, allocation, moves, order add/remove, dispatch, destruction, holds,
etc.). This endpoint is read-only.

```ts
type AuditEventType = "registered" | "label_printed" | "allocated" | "moved" | "details_edited"
  | "added_to_order" | "removed_from_order" | "picked" | "dispatched" | "collected" | "received"
  | "refiled" | "marked_missing" | "destruction_authorised" | "destroyed" | "hold_placed"
  | "hold_released" | "status_changed"

interface AuditEvent {
  id: string; boxId: string; boxNumber: string; clientId: string; type: AuditEventType;
  at: string; actor: { id: string; name: string; side: "staff" | "client" | "system" };
  orderId?: string; orderNumber?: string;
  fromLocation?: { warehouse: string; rack: string; slot: string };
  toLocation?: { warehouse: string; rack: string; slot: string };
  changes?: { field: string; from?: string; to?: string }[];
  note?: string;
  visibleToClient: boolean; // true for client-facing event types (registered, dispatched, destroyed, etc.)
}
```

`visibleToClient` is fixed per event type (not something you set) — use it to filter what a
client-facing UI should show vs. internal-only events like `allocated`/`moved`.

---

## Worked example: register → store → dispatch

```bash
# 1. Register 2 boxes for a client (ClientID/name from DocuSoft, looked up on your side)
curl -X POST /api/boxes/batch -d '{
  "clientId": "CUST-123", "clientName": "Acme Ltd", "quantity": 2,
  "description": "2024 invoices", "filingDateFrom": "2024-01-01", "size": "standard"
}'
# -> [{ id: "box1", boxNumber: "BX00000001", status: "unallocated", ... }, { id: "box2", ... }]

# 2. Ask for slot suggestions
curl -X POST /api/slots/suggest -d '{ "clientId": "CUST-123", "boxSizes": ["standard", "standard"] }'
# -> [{ slotId: "slotA", locationPath: {...}, reasons: ["Has enough free space"] }, ...]

# 3. Allocate both boxes into the suggested slot
curl -X POST /api/boxes/allocate-batch -d '{
  "allocations": [{ "boxId": "box1", "slotId": "slotA" }, { "boxId": "box2", "slotId": "slotA" }]
}'
# -> boxes now status: "stored", locationPath set

# 4. Create a dispatch order for those boxes (status starts "approved")
curl -X POST /api/orders -d '{
  "type": "dispatch", "clientId": "CUST-123", "clientName": "Acme Ltd", "boxIds": ["box1", "box2"]
}'
# -> boxes now status: "reserved", openOrder set; order.lineSummary: { pending: 2 }

# 5. Move it through the lifecycle
curl -X POST /api/orders/<id>/schedule -d '{ "scheduledFor": "2026-10-10" }'
curl -X POST /api/orders/<id>/start
curl -X POST /api/orders/<id>/dispatch -d '{ "recipientName": "M. Jones" }'
# -> order.status: "completed"; boxes: status "out", slot freed; audit trail has 4 events per box
```

---

## Things this API deliberately does NOT do (yet)

- No Client CRUD — by design, see above.
- No pick/receive scanning workflow beyond what's described above (order lines have a `"picked"`
  status in the schema for this, but no endpoint sets it yet).
- No duplicate-submission protection (`Idempotency-Key`) yet: if a request succeeds but its reply is lost, sending it
  again repeats it. See `docs/GAP_ANALYSIS_AND_ROADMAP.md` §3.2.

(Portal orders are supported through the client-portal API below, and every list endpoint is paginated.)

## Staff roles and permissions (`/api/users`)

Staff log in with DocuSoft. Only DocuSoft's admin flag (`strIsAdmin`) is taken from DocuSoft (→ `staff_admin`); every other
staff role is assigned here and stored in `user_role` (keyed by e-mail, so a role can be given before someone's first
login). No role and not an admin → `staff_operator`. Every change-making route checks the person's **current** roles
from the database (`requirePermission`, 30 s cache cleared on change) — the 7-day session token's roles are not trusted.
Role → permission map: `src/auth/permissions.js` (the staff frontend has a copy for its buttons).

| Permission | Roles |
|---|---|
| `layout.manage`, `settings.manage` | staff_admin, warehouse_admin |
| `users.manage` | staff_admin |
| `audit.read` | staff_admin, warehouse_admin, operations_manager, records_manager, finance_manager, auditor |
| `boxes.operate`, `orders.operate` | staff_admin, warehouse_admin, operations_manager, staff_operator |
| `boxes.hold` | staff_admin, warehouse_admin, records_manager |
| `orders.approve` | staff_admin, warehouse_admin, operations_manager |
| `orders.authorise` (record a client's destruction/digitizing sign-off) | staff_admin, operations_manager, records_manager |
| `billing.view` | staff_admin, finance_manager, auditor |
| `billing.manage` | staff_admin, finance_manager |

Reading boxes, orders, warehouses and box history needs only a staff login.

```text
GET /api/users                              -> { items: StaffUser[], total }            (users.manage)
PUT /api/users/:email/roles  { roles }      -> StaffUser   replaces the local roles     (users.manage)
GET /api/admin-audit?entityType=&entityId=&action=&page=&pageSize=
                                            -> { items: AdminAuditEvent[], total }      (audit.read)
```

```ts
interface StaffUser { email: string; name?: string; hasLoggedIn: boolean; lastLoginAt?: string;
  docusoftAdmin: boolean; roles: Role[] /* assigned here */; effectiveRoles: Role[] /* what they can do */ }
interface AdminAuditEvent { id: string; action: string; entityType: "user" | "warehouse" | "rack" | "slot" | "settings" | "invoice";
  entityId?: string; summary: string; changes?: { field: string; from?: unknown; to?: unknown }[]; actor: Actor; at: string }
```

Role, warehouse/rack/slot, box-size, Sage-settings and invoice changes are written to the admin audit log.

## Invoices and Sage One (`/api/invoices`, `/api/settings/sage`)

Warehouse invoices are prepared here and **created in Sage One by the browser** — the Sage sign-in (tokens) lives in the
browser, as in DocuSoft Practice, and every Sage call goes to DocuSoft's proxy (`https://digitalpractice.net/sageone/*`).
This API never sees Sage tokens or the Sage app secret; it stores the invoice and records the hand-over:

`draft` → `POST /:id/sending` (lock, 2 min) → browser creates it in Sage → `POST /:id/issued` → `issued` (frozen).
On failure `POST /:id/send-failed` puts it back to `draft` with `lastError`. The invoice number is the Sage reference, and
the browser looks for it in Sage before creating — so a retry never makes a second Sage invoice.

```text
GET    /api/invoices?clientId=&status=&q=&page=&pageSize=   -> { items: Invoice[], total }          (billing.view)
GET    /api/invoices/suggest?clientId=&from=&to=            -> { lines, alreadyInvoicedOrders }      (billing.manage)
POST   /api/invoices            InvoiceInput                 -> Invoice (draft, "WMS-INV-000001") 201 (billing.manage)
GET    /api/invoices/:id                                     -> Invoice with lines                   (billing.view)
PUT    /api/invoices/:id        InvoiceInput                 -> Invoice   draft only                 (billing.manage)
DELETE /api/invoices/:id                                     -> { ok }    draft only                 (billing.manage)
POST   /api/invoices/:id/sending                             -> Invoice   409 if being sent now      (billing.manage)
POST   /api/invoices/:id/issued { sageInvoiceId, sageInvoiceNumber?, sageLink?, sageContactId?, sageBusinessId? }
POST   /api/invoices/:id/send-failed { message }
GET    /api/settings/sage                                    -> SageSettings                         (billing.view)
GET    /api/settings/box-sizes   -> { items: [{ code, name, lengthCm, active, builtIn, boxCount }], updatedAt, updatedBy }
POST   /api/settings/box-sizes   { name, lengthCm }                  -> BoxSizeType (201)  (settings.manage)
PATCH  /api/settings/box-sizes/:code { name?, lengthCm?, active? }   -> BoxSizeType  rename / new length / retire (false)
DELETE /api/settings/box-sizes/:code                                 -> 204 (409 if a box uses it or it's standard / large)
GET    /api/boxes/lookup?code=   current barcode or box number, any case -> Box (404 if none) -- "scan to see a box"
       Rate cards: rates.storagePerBoxMonth is { <size code>: price }.
PUT    /api/settings/sage  { defaultLedgerAccountId?, defaultLedgerAccountName?, defaultTaxRateId?, paymentTermsDays? }
```

```ts
interface InvoiceLine { kind: "storage" | "intake" | "collection" | "dispatch" | "destruction" | "digitize" | "other";
  description: string; quantity: number; unitPrice: number /* GBP, 2 dp */; taxRateId: string /* Sage id, e.g. GB_STANDARD */;
  ledgerAccountId?: string; sourceType?: "order"; sourceId?: string /* the order — never suggested twice */ }
interface InvoiceInput { clientId: string; clientName: string; periodFrom?: string; periodTo?: string;
  invoiceDate: string; dueDate: string; notes?: string; lines: InvoiceLine[] }
```

Suggested lines (for a client and period): boxes in storage, boxes registered in the period, and every order completed in
the period that isn't on an invoice yet; price = the last price used for that kind of line. `netTotal` = sum of qty x price
(VAT is worked out by Sage). Sage defaults: `defaultTaxRateId` `GB_NO_TAX` (as Practice) and 30 days unless changed.

## Scanning, returns, exceptions (Sprint 3)

Scanners are keyboard-wedge: they type the barcode and press Enter, so every scan endpoint takes a plain `barcode`
(the box's **current** barcode — after a re-label the old one no longer scans). A scan that doesn't match is refused
**and** recorded in the supervisor queue (`/api/exceptions`); scanning the same box twice is harmless.

```text
POST /api/boxes/receive        { barcode, warehouseId }        -> { box, alreadyReceived }   registered box -> "received" at that Goods-In
POST /api/boxes/put-away       { boxBarcode, slotBarcode, reason? } -> { box, slot }          onto a shelf (any box with us)
POST /api/boxes/:id/quarantine { reason }                      -> Box   (boxes.hold) stays put, can't go on any order
DELETE /api/boxes/:id/quarantine                               -> Box   (boxes.hold) back to stored / received / registered
POST /api/boxes/:id/relabel    { reason }                      -> Box   new barcode, same box (old label stops scanning)

GET  /api/orders/:id/pick-list                                 -> { order, lines }  walking order: warehouse, rack, row, column
POST /api/orders/:id/pick      { barcode }                     -> { order, boxNumber, remaining, alreadyPicked }
POST /api/orders/:id/receive   { barcode, warehouseId? }       -> { order, boxNumber, remaining, alreadyReceived }  (collection)
POST /api/orders/:id/complete  { warehouseId? }                collection: unscanned returning boxes are received now
POST /api/orders/:id/hold      { reason }                      -> Order (orders.approve)
POST /api/orders/:id/resume                                    -> Order (orders.approve) back to heldFromStatus

GET  /api/exceptions?status=open|resolved&orderId=&page=&pageSize= -> { items, total, open }  (orders.approve)
POST /api/exceptions/:id/resolve { resolution }                -> OperationException          (orders.approve)
```

Rules:

- **Pick** works on dispatch / destruction orders that are `in_progress` (or `ready`). The last pick makes the order
  `ready`. Dispatch / destroy then needs **all** boxes picked — or none (the one-click way still works).
- **Collection returns:** boxes on a collection become `return_pending` when it is created, `received` (at the chosen
  warehouse's Goods-In) when scanned or when the collection is completed, then `stored` once put away. Cancelling the
  collection makes them `out` again. (Fixes B7.)
- **Permanent withdrawal:** `POST /api/orders` with `permanentWithdrawal: true` (dispatch only) — the boxes end as
  `permanently_withdrawn` and can't come back on a collection.
- **Slots:** `PATCH /api/slots/:id` takes `status` `blocked` | `quarantined` | `inactive` (locked: no new boxes, the ones
  inside stay) or `available` / `full` (= active again).
- New statuses — box: `received`, `return_pending`, `quarantined`, `permanently_withdrawn`; order: `ready`, `on_hold`;
  slot: `quarantined`, `inactive`. New history events: `goods_in` (staff only), `quarantined`, `quarantine_released`,
  `relabelled`; movement type `received` (into a warehouse's Goods-In).

## Records: retention, legal holds, destruction, certificates (Sprint 4)

```text
GET  /api/records/retention-rules?history=true                  -> RetentionRule[]   (any staff; current only unless history)
POST /api/records/retention-rules { code, name, retentionYears, trigger, notes? } -> new version  (records.manage)
     trigger: filing_date_to | filing_date_from | registered. Saving an existing code makes version n+1 the current one.
GET  /api/records/due?before=&clientId=&page=&pageSize=          -> { items: [{ box, destructionDate, basis, heldBy, onHold }], total }  (records.manage)
GET  /api/records/legal-holds?status=&clientId=&boxId=&page=     -> { items, total }  (any staff)
GET  /api/records/legal-holds?coversBox=<boxId>                  -> the active holds covering that box (own / client / category)
POST /api/records/legal-holds { scope: box|client|category, boxId | clientId+clientName | category, authority, reason, startsAt?, endsAt? }  (records.manage)
POST /api/records/legal-holds/:id/release { note }               (records.manage; note required)
GET  /api/records/certificates?clientId=&page=                   -> { items, total }  (any staff)

POST /api/orders/:id/approve-destruction                         -> Order  (records.approve; not the person who requested it)
POST /api/orders/:id/destroy  { witness?, place? }                needs the approval; issues the certificate
GET  /api/orders/:id/certificate                                 -> DestructionCertificate (404 until destroyed)
```

- Boxes: `retentionCategory` on register / `PATCH /api/boxes/:id` must be the code of a current rule. The destruction
  date is the box's own `destroyAfter` if set, otherwise trigger date + years of its category's rule.
- A legal hold that covers a box blocks putting it on a destruction order **and** destroying it (409 naming the boxes).
- Destruction = client authorises → records manager approves (`approvedBy` ≠ requester) → operator destroys. The
  certificate (`COD-000001`, …) is frozen at that moment; the portal copy leaves out staff names.

## Pricing, charges, billing runs, exports (Sprints 5–6)

```text
GET  /api/billing/rate-cards                                     -> RateCard[]   (billing.view)
POST /api/billing/rate-cards { clientId?, clientName?, effectiveFrom, rates, taxRateId, notes? }  (billing.manage)
     rates: { storagePerBoxMonth: { standard, large }, intakePerBox, retrievalPerBox, deliveryPerOrder,
              collectionPerOrder, destructionPerBox, digitizePerBox }. No clientId = the default card.
GET  /api/billing/charges?from=&to=&clientId=&status=&billingRunId=&page= -> { items, total, amount }
POST /api/billing/charges/generate { from, to, clientId? }       -> { created, amount, clientsWithoutRateCard }  (idempotent)
POST /api/billing/charges { clientId, clientName, description, quantity, unitPrice, taxRateId, date? }  manual charge
POST /api/billing/charges/:id/void { reason }                    (not while it is in a draft run)
GET  /api/billing/runs · GET /api/billing/runs/:id               (detail has charges, per-client totals, invoices)
POST /api/billing/runs { from, to }                              -> draft run (one draft at a time)
POST /api/billing/runs/:id/approve                               -> one draft invoice per client; charges -> invoiced
DELETE /api/billing/runs/:id                                     discard a draft; its charges are open again

GET  /api/exports/inventory.csv?clientId=                        any staff
GET  /api/exports/movements.csv?from=&to=&clientId=              any staff
GET  /api/exports/audit.csv?from=&to=&clientId=                  audit.read
GET  /api/exports/charges.csv?from=&to=&clientId=&status=        billing.view

GET  /api/boxes/:id/contents · POST { description, reference?, dateFrom?, dateTo?, docusoftDocumentId? } · DELETE /api/boxes/:id/contents/:contentId
GET  /api/notifications?page=&pageSize=&unread=true   staff in-app updates (every client action) -> { items: [... read], total, unread }
GET  /api/notifications/unread-count -> { unread }      POST /api/notifications/:id/read      POST /api/notifications/read-all
GET / PUT / DELETE /api/me/signature   the signed-in staff member's signature { kind: drawn|typed|uploaded, image: data URL,
     text?, font? } -- goes on the certificates of destruction they sign; POST /orders/:id/destroy without one -> 409
     { code: "SIGNATURE_REQUIRED" }
```

- **Storage** is charged by the day: days the box was in our custody in the period (from the movement ledger) / 30 ×
  the monthly rate for its size. Services: intake per box on its registration day; retrieval/delivery/collection/
  destruction/digitize from orders completed in the period. Every charge has a unique business key, so generating
  again never charges twice. A client's own rate card beats the default one.
- Dispatch takes `{ recipientName, courier?, trackingRef? }`; `POST /api/orders/:id/delivered { receivedBy,
  proofReference?, deliveredAt? }` records proof of delivery (`order.delivery`).

## Pagination (all list endpoints)

`GET /api/boxes`, `/api/orders`, `/api/audit`, `/api/clients/:id/boxes` and `/api/clients/:id/orders` are paginated:
`?page=1&pageSize=25` (`pageSize` is capped at **100**; `/audit` defaults to 50) and return `{ items, total }`.
Sorting is newest-first with a stable tie-break, so pages never overlap. Never ask for "everything" in one
request — loop over pages (the frontend does this for CSV exports).

Extra filters: `GET /api/boxes?rackId=&row=` (boxes stored in a rack / one row of it).
`GET /api/racks/:id/rows` -> `[{ row, boxCount, onOrderCount }]` (one SQL aggregate for the rack page).
`PATCH /api/racks/:id { cellLength?, lengthUnit?, label?, zoneId?, aisleId? }` (layout.manage) changes the cell length of
every cell in the rack and / or its label and place (`null` = out of its zone / aisle; an aisle decides the zone). A new
zone / aisle — or renaming one — rewrites the **current** `locationPath` of the boxes on those racks in the same
transaction; history (audit, movements, order lines) is never rewritten. `npm run locations:refresh -- --apply` does
the same for every stored box once (old `rack: "B-04"` labels become the real code `B04`).

`POST /api/boxes/put-away { boxBarcode, slotBarcode }` also takes a shelf / position code (`B04-3`, `B04-3-2`): a shelf
goes to its best-fitting position; a code in two warehouses is refused (scan the position label) and queued.

## Orders belong to a client contact (clientId + contactEmail)

Every order is saved against a client (`clientId`) **and** the client contact it is for (`contactEmail`, stored
lower-case; `contactName` is the display name). `POST /api/orders` rejects a missing/invalid `contactEmail` with 400.
`GET /api/orders` and `GET /api/clients/:id/orders` accept `?contactEmail=` (case-insensitive).

Planned client-side (portal) rule, already available as `visibleToContactWhere()` in `services/orderService.js`:
a logged-in client contact sees only the orders of its `clientId` made for its email; a **main contact** sees every
order of its client. `clientId` / email / main-contact flag must come from the session, never from request input.

## Client portal API (`/api/portal`)

For the client-facing pages (no login page — see `docusoft-web-portal-USA/wareHouse`). Auth is a signed **Bearer
token** (HS256 JWT, `PORTAL_JWT_SECRET`), separate from the staff cookie: a staff token never works here and a portal
token never works on the staff API.

**1. Get a token** — `POST /api/portal/auth/login` (rate-limited: 20/min/IP)
```json
{ "agrno": "ACME", "clientId": "00092560", "contactEmail": "asha@client.com", "isMainContact": false,
  "contactName": "Asha Rao", "clientName": "Client Ltd" }
```
`agrno` must match the agreement of the warehouse staff (`wh_user.agreementNo`), otherwise `401 Invalid credentials`.
`isMainContact: true` => role `client_admin`, `false` => `client_user`. Response:
`{ token, tokenType: "Bearer", expiresIn, expiresAt, user: { clientId, email, name, role, isMainContact } }`.
Token lifetime: `PORTAL_TOKEN_TTL_MINUTES` (default 60) — call login again when a request returns `401 token_invalid`.

> **Trust:** these four values are *claims* made by the caller (the parent portal) — DocuSoft is not asked again.
> Call this endpoint only from your trusted portal origin (`PORTAL_ORIGINS`), over https, and keep rate limiting on.

**2. Use it** — every call: `Authorization: Bearer <token>`. clientId / email / role come **only** from the token.

| Method & path | What |
|---|---|
| `GET /auth/me` | the identity inside the token |
| `GET /summary` | box counts (total, by status, inStorage, outWithYou, …), order counts, `needsAuthorisation`, warehouses with box counts, 5 recent orders |
| `GET /boxes?q&status&includeDestroyed&page&pageSize` | the client's boxes (all contacts see all boxes). Returns `{ items, total }` |
| `GET /boxes/:id` · `GET /boxes/:id/history` | one box · its client-visible history (no staff names, no rack/slot) |
| `GET /orders?type&status&q&needsAuthorisation&page&pageSize` | orders: **contact = own (by email), main contact = all of the client** |
| `GET /orders/:id` · `GET /orders/:id/lines` | one order / its boxes (404 if not visible to this contact) |
| `POST /orders` | request an order (always status `requested`, for this client + this contact). Body: `type`, `boxIds`, `address`, `expectedNewBoxes`, `scheduledFor`, `contactPhone`, `notes`; destruction also needs `destructionAuthorisation: { name, method }` |
| `POST /orders/:id/cancel` | only while `requested` |
| `POST /orders/:id/authorise-destruction` | `{ name, method }` for a staff-created destruction order waiting for the client |
| `POST /orders/:id/payment` | billing stage: the card payment made on the order page (`{ paymentIntentId, amount, currency }`). `GET /orders?awaitingPayment=true` lists orders to pay; `/summary` has `orders.awaitingPayment`; orders carry `billing` (status, invoice number, amount, currency, and `stripeCustomerId` while waiting for payment) |
| `POST /orders/:id/acknowledge-invoice` | billing stage, payment not required (on account): the client acknowledges the invoice instead of paying; listed under `awaitingPayment=true` too |
| `POST /orders/:id/client-approve` | main contact only: approve a destruction asked for by another contact (it waits for this before the warehouse can approve). `GET /orders?needsMyApproval=true` lists them; `/summary` has `orders.needsMyApproval` |
| `GET /orders/:id/certificate` · `GET /certificates` | certificate of destruction (client copy, no staff names) |
| `GET /notifications?page&pageSize` | in-app updates on this contact's orders (main contact: all of the client's) |

`GET /boxes/:id` also returns `contents` (file-level index). Orders carry `clientApprovalRequired`, `clientApprovedBy/At`
and `delivery` (courier, tracking, received by, delivered at).

Another client's (or another contact's) data answers **404**, never 403. Lists are paginated (max 100 per page).

---

## Scan-app API — scheduled digitize orders

`POST /api/digitize/scheduled-orders` — public (no cookie / token); the body is the proof of identity.

Request (`Content-Type: application/json`):

```json
{ "email": "user@company.com", "password": "c2VjcmV0", "agrno": "0003" }
```

* `email` — the user's DocuSoft email.
* `password` — the DocuSoft password, **base64 encoded** (same form DocuSoft expects).
* `agrno` — the agreement number. It must be the agreement this system is for (`app_setting.defaultDatabase`, e.g. `0003`)
  **and** DocuSoft must list it for that email.

Success `200` — the scheduled digitize orders the client has authorised (oldest scheduled date first, at most 1000):

```json
{ "status": true, "count": 2, "orders": [ { "id": "<order id>", "name": "DGT-000002" } ] }
```

An empty list is a normal answer: `{ "status": true, "count": 0, "orders": [] }`.

Errors — always `{ "status": false, "code": "<CODE>", "message": "<English text>" }`:

| HTTP | code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `email`, `password` or `agrno` missing / wrong type; email not valid; password not valid base64 (the message lists every problem) |
| 400 | `INVALID_JSON` | the body is not valid JSON |
| 401 | `INVALID_CREDENTIALS` | wrong email, password or agrno — one message for all of them, so nothing leaks about which one was wrong |
| 405 | `METHOD_NOT_ALLOWED` | anything but POST |
| 413 | `BODY_TOO_LARGE` | body over 1 MB |
| 429 | `RATE_LIMITED` | more than 30 requests/min per IP or 10/min per email |
| 502 | `UPSTREAM_ERROR` | DocuSoft is unreachable or answered something unexpected |
| 504 | `UPSTREAM_TIMEOUT` | DocuSoft did not answer within 15 s |
| 503 | `NOT_CONFIGURED` | `defaultDatabase` is missing in `app_setting` |
| 500 | `INTERNAL_ERROR` | anything else (details are never sent to the caller) |

Responses are sent with `Cache-Control: no-store`. The password is never stored or logged.
