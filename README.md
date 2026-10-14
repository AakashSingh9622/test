# Warehouse Management API

Real backend for the Warehouse Management UI (`warehouse-management-system-frontend`), which until
now ran entirely on a mock API (MSW + localStorage, see that repo's `CLAUDE.md`/`PLAN.md`). This
backend replaces that mock layer with Supabase Postgres-backed data (via Prisma): auth, Warehouse/Rack/Slot, Box, Order
(full lifecycle), and Audit are all real now — see **[API.md](./API.md)** for the complete,
consumer-facing endpoint reference (written so it can be used from any client, not just the
staff frontend this was built alongside — e.g. a separate portal project).

Stack: **Node.js + Express 4 + Prisma 7 + Supabase Postgres (plain JavaScript, no TypeScript)**.

## How login works (the part that's different from a normal app)

There is no local password/signup here. Credentials are verified against an existing, external
system — **DocuSoft** — the same one `docusoft-MCP` (a sibling project) already talks to:

1. User submits `email` + plaintext `password` to `POST /api/auth/login`.
2. The backend base64-encodes the password (DocuSoft's SOAP-ish `.asmx` API expects that) and
   calls DocuSoft's `Json_GetAgreementList` endpoint (`src/services/docusoftClient.js`).
3. If the response's `Table` array is empty → **401 invalid credentials**.
4. Role is decided from there: if **any** row has `strIsAdmin === true` → `staff_admin`; otherwise
   → `staff_operator`. Both can log in — only permissions differ (e.g. only `staff_admin` can
   `POST /api/warehouses`, gated by `requireRole` in `src/middleware/requireRole.js`). client_admin/
   client_user are a future pass.
5. On success, the matching row's data (`strUserName`, `intUserId`, `vAgreementNo`) is upserted into
   the `wh_user` table (`WHUser` model in `prisma/schema.prisma`) as a login-identity cache.
6. The backend issues its **own session token** — see the trade-off below — and returns
   `{ user, token, agrno }`. The frontend's existing `useAuth.tsx` writes `token` into the
   `wms_session` cookie itself (unchanged), so `src/proxy.ts` on the frontend keeps working as-is,
   and separately stashes `agrno` + the user's email/password so it can call DocuSoft's
   `Json_GetFolders`/`Json_GetClientsByFolder` **directly from the browser** — see "Clients/Folders"
   below. The backend never stores or replays the password for that — it only needs it once, for
   step 2 above.

**Token trade-off (deliberate, documented in code comments):** the token is base64url-encoded JSON
of the session claims — **not a signed JWT** — because that's exactly what the frontend's mock
already issued and `src/auth/session-shared.ts` expects to decode. This was the explicit choice
made so the frontend needs zero changes. It means the token is forgeable client-side (same as the
mock always was) — fine for an internal admin tool today, flagged with a comment at
`src/auth/sessionToken.js` for whoever upgrades it to a real signed JWT later.

## Database design

One Prisma model per frontend domain type (`prisma/schema.prisma`) (`frontend/src/api/types.ts` is the source of truth
for field names), except **Client — there is no Client model**. Clients live only in DocuSoft and
are fetched live from the frontend (see above); `Box`/`Order`/`AuditEvent` store just the DocuSoft
`clientId` (ClientID/OriginatorNo) as a plain string reference plus a denormalized `clientName`,
never a foreign key — this API never validates a `clientId` against anything, it just stores what
it's given.

| Model | Routes live? | Notes |
|---|---|---|
| `WHUser` (`wh_user` table) | yes (auth) | Login identity cache, no password stored |
| `Warehouse` | yes | `rackCount`/`slotCount`/`usedCapacity`/`totalCapacity` computed on read, not stored |
| `Rack` | yes | `usedCapacity`/`totalCapacity` computed on read |
| `Slot` | yes | `used`/`status` are maintained fields (see below), not purely computed |
| `Box` | **yes** | full register/search/allocate/hold/missing/label flow — see API.md |
| `Order` / `OrderLine` | **yes** | full lifecycle state machine (`src/services/orderMachine.js`) — see API.md |
| `AuditEvent` | **yes** | read-only search; every Box/Order action above writes these automatically |

Why some fields are computed and some are stored: `Warehouse.rackCount` etc. are always derived
from its `Rack`/`Slot` documents via aggregation (`src/services/locationService.js`) so they can
never drift out of sync with reality. `Slot.used`/`Slot.status`, on the other hand, change
transactionally alongside box allocation (a future pass), so they're maintained fields recomputed
on write — exactly the trade-off the frontend's own mock (`src/mocks/store.ts`) already made, kept
here for consistency.

Rows go through `src/utils/serialize.js` before leaving the API: it drops `null` columns (the frontend's zod schemas use `.optional()`, not `.nullable()`), formats "which day" dates as `YYYY-MM-DD`, and exposes `Order.collectionInfo` as `collection`. IDs are plain UUID strings (`id`). Multi-step actions (dispatch, destroy, cancel, allocate-batch, register batch) run inside a Prisma `$transaction`, and box/order numbers come from an atomic `counter` table (`src/services/counterService.js`).

## Setup

```bash
npm install              # postinstall runs `prisma generate` (plain-JS client in node_modules)
cp .env.example .env   # then fill in DATABASE_URL / DIRECT_URL (see below)
npx prisma db push      # creates the tables in Supabase from prisma/schema.prisma
npm run seed            # creates 2 warehouses + racks + slots so there's data to query
npm run dev              # nodemon, or `npm start` for a plain run
```

`.env` (gitignored, never commit it):

```env
PORT=5000
NODE_ENV=development
# Supabase Dashboard > Connect > Session pooler. URL-encode special chars in the password.
DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
DIRECT_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
CORS_ORIGIN=http://localhost:3000
```

`CORS_ORIGIN` must be an exact origin (not `*`) because the `wms_session` cookie needs
credentialed CORS (`Access-Control-Allow-Credentials`) once the frontend and this API run on
different ports/origins.

## Clients/Folders are NOT proxied through this backend

`Json_GetFolders` and `Json_GetClientsByFolder` are called **directly from the frontend** browser
code (`frontend/src/api/docusoft.ts`), straight to DocuSoft's `.asmx` endpoint — not through this
API. Reference for the exact request/response shape:
`C:\Aakash Singh\projects\docusoftpractice` (a plain-JS project that already calls these same
endpoints from the browser). This backend's only DocuSoft touchpoint is the login step above; it
deliberately does not cache or replay the user's password for anything else — the frontend handles
its own direct DocuSoft calls using the `agrno` this backend's login response hands back, plus the
email/password the user already typed into the login form.

## API surface

See **[API.md](./API.md)** for the full, worked-example reference (auth, Warehouses/Racks/Slots,
Boxes, Orders + lifecycle diagram, Audit). Response shapes intentionally match what
`frontend/src/mocks/store.ts` already produced, so pointing the staff frontend at this backend
needs no frontend code changes for these routes beyond swapping the data source.

## What's next

Portal/client-side login (`client_admin`/`client_user` via DocuSoft) isn't wired up yet, so
`requestedVia: "portal"` orders can't be created through this API — only `staff`-originated ones.
A pick/receive barcode-scanning workflow (order lines have a `"picked"` status in the schema, but
no endpoint sets it yet) is also not built.
