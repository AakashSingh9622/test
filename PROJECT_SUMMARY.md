# Warehouse Management API (WHMS) — Project Summary

Document/box storage warehouses ke liye backend REST API. Frontend (Next.js, `localhost:3000`) aur client portal alag projects hain; ye API unhe real Supabase database deti hai.

## Tech stack
- Node.js, Express 4, Prisma 7, Supabase Postgres (plain JavaScript)
- helmet, cors, express-rate-limit, compression

## Login
- Local password/signup nahi. Email + password **DocuSoft** se verify hote hain.
- DocuSoft me admin flag ho to `staff_admin`, warna `staff_operator`.
- Portal ke liye alag JWT (`PORTAL_JWT_SECRET`) aur routes (`/api/portal`).
- Clients/folders ki list frontend seedha DocuSoft se leta hai.

## Main features (`src/routes/`)
- **Locations:** Warehouse → Zone → Aisle → Rack → Slot, capacity tracking
- **Boxes:** register, search, allocate, hold, missing, label, custom sizes, batch correction
- **Orders:** poora lifecycle (state machine), dispatch, destroy, cancel
- **Billing:** invoices, rate cards, charge events, billing runs
- **Compliance:** retention rules, legal holds, signed destruction certificates
- **Others:** movements, exceptions, audit logs, digitize, exports, records, settings, users/roles
- **Notifications:** client ke har action par staff ko notification (per-user read state)
- **Clients list:** stats (boxes in/out, open orders, last activity, balance)

## Database
- ~30 Prisma models (`prisma/schema.prisma`): Warehouse, Box, Order, Invoice, AuditEvent, Notification, Counter, etc.
- Box/order numbers atomic `Counter` table se; multi-step actions transactions me.

## Structure
```
server.js, src/app.js     entry points
src/routes, controllers, services, middleware, auth, config, scripts, utils
prisma/schema.prisma      DB schema
API.md, docs/             endpoint reference, DB docs, roadmap
```

## Commands
| Command | Kaam |
|---|---|
| `npm install` | dependencies + `prisma generate` |
| `npm run dev` | nodemon server (port 5000) |
| `npm start` | plain run |
| `npm run slots:recompute` / `locations:refresh` / `sizes:convert` | maintenance scripts |

> Shared database use ho raha ho to `db:push` aur `seed` na chalayein.

## Env variables (`.env`, gitignored)
`PORT`, `NODE_ENV`, `DATABASE_URL`, `DIRECT_URL`, `CORS_ORIGIN`, `SESSION_JWT_SECRET`, `PORTAL_JWT_SECRET`, `PORTAL_TOKEN_TTL_MINUTES`, `PORTAL_ORIGINS`, `TRUST_PROXY` (optional)

## Status
Local setup complete; server `http://localhost:5000` par Supabase se connected.
