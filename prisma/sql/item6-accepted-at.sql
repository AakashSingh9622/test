-- Item 6 (record requests report): WHEN a record request was accepted by staff. Only ONE new, empty, nullable column -- nothing existing is changed.
-- Additive and safe to run again.   npx prisma db execute --file prisma/sql/item6-accepted-at.sql
-- Run THIS first, then the backfill (item6-accepted-at-backfill.sql), then restart the backend (the code that writes the column needs it).
-- Rollback:  ALTER TABLE "record_request" DROP COLUMN "acceptedAt";   (nothing else reads it)
ALTER TABLE "record_request" ADD COLUMN IF NOT EXISTS "acceptedAt" TIMESTAMP(3);
