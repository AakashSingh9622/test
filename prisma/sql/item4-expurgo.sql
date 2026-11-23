-- Item 4 (Peticiones, Step 13): the "Expurgo" checkbox on a record request. INFORMATION ONLY: "these records are intended for destruction".
-- It destroys nothing and does not touch the Expurgo-by-file approval flow. ONE new column; every existing request gets false.
-- NOT NULL with a constant default: Postgres adds it without rewriting the table, so it is instant and safe to run on a live database.
-- Additive and safe to run again.   npx prisma db execute --file prisma/sql/item4-expurgo.sql
-- Rollback:  ALTER TABLE "record_request" DROP COLUMN "expurgo";   (nothing else reads it)
ALTER TABLE "record_request" ADD COLUMN IF NOT EXISTS "expurgo" BOOLEAN NOT NULL DEFAULT false;
