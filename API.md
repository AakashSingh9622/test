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

## Warehouses / Racks / Slots

```text
GET    /api/warehouses                              -> Warehouse[]
POST   /api/warehouses        {code,name,address?}   -> Warehouse            (staff_admin only, 201)
GET    /api/warehouses/:id                           -> Warehouse
GET    /api/warehouses/:id/racks                     -> Rack[]
POST   /api/warehouses/:id/racks  { code, label, rows, columns, cellLength, lengthUnit?: "cm" | "ft" }
       # every row x column cell is ONE storage location (slot) of length `cellLength` (feet are converted
       # to whole centimetres and stored); no sub-slots. Response Rack includes cellLengthCm.
                                                      -> Rack                 (staff_admin only, 201)
                                                      — also creates rows×columns Slot documents
GET    /api/racks/:id                                -> Rack
GET    /api/racks/:id/slots                          -> Slot[]
PATCH  /api/slots/:id         { status?, capacity? (cm) }  -> Slot   (staff_admin only)
POST   /api/slots/suggest     SuggestSlotsInput       -> SlotSuggestion[]
```

```ts
interface Warehouse { id: string; code: string; name: string; address?: string;
  rackCount: number; slotCount: number; usedCapacity: number; totalCapacity: number }
interface Rack { id: string; warehouseId: string; code: string; label: string;
  rows: number; columns: number; cellLengthCm: number; usedCapacity: number; totalCapacity: number }
interface Slot { id: string; rackId: string; warehouseId: string; code: string; barcode: string;
  row: number; column: number; capacity: number /* cm */; used: number /* cm of boxes inside */;
  status: "available" | "full" | "blocked" }
```

`usedCapacity`/`totalCapacity`/`rackCount`/`slotCount` are always computed live — you never set
them directly. `Slot.status` is also mostly computed (`used >= capacity` → `"full"`); the only
thing you can set directly via `PATCH` is `"blocked"` (which also zeroes `used`).

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
               | "pending_destruction" | "destroyed"
type BoxSize = "standard" | "large" // capacity is in centimetres: "large" takes 80 cm of a cell, "standard" 40 cm (src/utils/dimensions.js)

interface Box {
  id: string; boxNumber: string; barcode: string;
  clientId: string; clientName: string;
  description: string; department?: string; reference?: string;
  filingDateFrom: string; filingDateTo?: string; destroyAfter?: string; // ISO date strings
  size: BoxSize; status: BoxStatus; onHold: boolean; holdReason?: string; labelPrinted: boolean;
  slotId?: string;
  locationPath?: { warehouse: string; rack: string; slot: string }; // set once status is "stored"
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
requested ──approve──> approved ──schedule──> scheduled ──start──> in_progress ──┐
    │                      │                       │                             │
  reject                cancel                  cancel                      (type-specific
    │                      │                       │                        completion action
    v                      v                       v                        below) ──> completed
 rejected               cancelled               cancelled
```

Every order created through `POST /api/orders` from this backend is **staff-created**, so it
always starts at `approved` (skipping `requested`) — `requested` only happens for `portal`-origin
orders, which aren't created by this API yet (portal isn't wired up). Any transition not shown
above → `409 invalid_transition`.

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
- No portal/client-login support — `requestedVia: "portal"` orders can't be created via this API
  yet (only `staff`-originated orders).
- No pick/receive scanning workflow beyond what's described above (order lines have a `"picked"`
  status in the schema for this, but no endpoint sets it yet).
- `GET /api/orders` returns everything matching the filter, unpaginated (`GET /api/boxes` and
  `GET /api/audit` do support `page`/`pageSize`).

## Pagination (all list endpoints)

`GET /api/boxes`, `/api/orders`, `/api/audit`, `/api/clients/:id/boxes` and `/api/clients/:id/orders` are paginated:
`?page=1&pageSize=25` (`pageSize` is capped at **100**; `/audit` defaults to 50) and return `{ items, total }`.
Sorting is newest-first with a stable tie-break, so pages never overlap. Never ask for "everything" in one
request — loop over pages (the frontend does this for CSV exports).

Extra filters: `GET /api/boxes?rackId=&row=` (boxes stored in a rack / one row of it).
`GET /api/racks/:id/rows` -> `[{ row, boxCount, onOrderCount }]` (one SQL aggregate for the rack page).
`PATCH /api/racks/:id { cellLength, lengthUnit? }` (staff_admin) changes the cell length of every cell in the rack.

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
