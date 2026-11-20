-- Phase 2, stage 6: status changes on a record request. Only adds nullable columns to the two tables created in stage 5
-- (nothing else is touched). Additive and safe to run again.   npx prisma db execute --file prisma/sql/stage6-record-request-status.sql
ALTER TABLE "record_request" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
ALTER TABLE "record_request" ADD COLUMN IF NOT EXISTS "deliveredBy" JSONB;
ALTER TABLE "record_request" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3);
ALTER TABLE "record_request" ADD COLUMN IF NOT EXISTS "closedBy" JSONB;
ALTER TABLE "record_request_line" ADD COLUMN IF NOT EXISTS "returnedAt" TIMESTAMP(3);
