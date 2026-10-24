# Sprint 1 — manual test log (temporary)

Temporary working file — delete once Sprint 1 testing is signed off.
Result: ✅ pass · ❌ fail · ⏳ not run yet

## Setup

| # | Step | Look for | Result | Notes |
|---|---|---|---|---|
| S1 | `npx prisma db push` **from `projects\test`** | "in sync"; `movement` table exists | ✅ | 24 Oct: first attempt never reached the DB (error in #2). Re-run → verified: `prisma migrate diff` DB vs schema is empty; `movement` table, 16 columns, `MovementType` enum, 3 indexes + FK to box all present. Restart the backend after the push |
| S2 | `npm run slots:recompute` (dry run) | List of damaged slots, or "nothing to fix" | ⏳ | Use `-- --apply` only if the list looks right |

## Slot fixes (staff_admin → Rack detail)

| # | Do this | Look for | Result | Notes |
|---|---|---|---|---|
| 1 | Block a slot with boxes in it | Blocked; used cm unchanged (not 0) | ✅ | 24 Oct |
| 2 | Unblock that slot | Back to available/full; used cm correct | ✅ | 24 Oct: first run failed with "table `public.movement` does not exist" (cause = S1). Passed after S1 |
| 3 | Register/move a box into a blocked slot | Refused: "Slot … is blocked" | ✅ | 24 Oct |
| 3b | Put a 150 cm box into a 120 cm cell (W3 / RAC3) | Not suggested; manual pick refused "doesn't have room" | ⏳ | 24 Oct first try: reported "150 cm box in 120 cm slot", but DB shows BX00000095 went into **WH2 / new-1 / 1-1 (366 cm cell, 120 → 270 used)** — fit correctly, no over-full slot in DB. Re-try with a RAC3 cell |
| 4 | Set capacity below used cm (e.g. RAC3 1-1: 100 cm used → set 90) | Refused, "already holds 100 cm"; capacity unchanged | ⏳ | |
| 5 | Set capacity = used | Status full | ⏳ | |
| 6 | Raise capacity again | Status available | ⏳ | |
| 7 | As staff_operator, try to block a slot | No button / 403 | ⏳ | |

## Movement ledger (`GET /api/boxes/<boxId>/movements` in the browser, logged in)

| # | Do this | Look for (newest first) | Result | Notes |
|---|---|---|---|---|
| 8 | Register + allocate a box | `put_away`, to slot + warehouse id | ⏳ | |
| 9 | Allocate it to the same slot again | No new row | ⏳ | |
| 10 | Move it to another slot | `transfer`, from old → to new | ⏳ | |
| 11 | Mark it missing | `marked_missing`, from slot; slot used drops | ⏳ | |
| 12 | Allocate the missing box | `found` | ⏳ | |
| 13 | Dispatch an order with a box | `dispatched`, order no. + recipient; slot freed | ⏳ | |
| 14 | Allocate the returned box | `put_away`, no "from" | ⏳ | |
| 15 | Complete a destruction order | `destroyed`, method in `reason`; slot freed | ⏳ | |

## Regression

| # | Check | Result | Notes |
|---|---|---|---|
| R1 | Register wizard, Move box, Create order, Dispatch, Destroy, Digitize — no errors | ⏳ | |
| R2 | Box History tab + Audit log unchanged | ⏳ | |
| R3 | Client portal: dashboard, boxes, orders, new request load | ⏳ | |
| R4 | Warehouse/rack capacity bars match slot totals | ⏳ | |

## Observations (not Sprint 1 bugs)

| # | Seen | Notes |
|---|---|---|
| O1 | Rack `new-1` shown as `n-ew-1` in locations | `rackLabelFor` assumes codes like `A01` (adds a dash after the first character). Cosmetic; fix pending approval |
| O2 | Box sizes: standard = 150 cm, large = 100 cm | Changed in Settings → Box sizes on 24 Oct 09:06 — confirm intended (standard is now bigger than large) |

## Red flags

- "table `movement` does not exist" → S1 not done on the right database.
- Slot shows 0 cm used with boxes inside → run S2.
