-- Phase 2, stage 11: clients ask for records in the portal. Only touches the two record-request tables of stage 5/6 and adds a
-- NEW history table -- nothing else is altered. Additive and safe to run again.
--   npx prisma db execute --file prisma/sql/stage11-portal-record-requests.sql

-- kind: original (the paper goes to the client, the record is put on loan) | digital (a scan; the paper never leaves the box)
-- source: staff | portal.   A request from the portal starts as status 'pending' until staff accept it.
ALTER TABLE "record_request" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'original';
ALTER TABLE "record_request" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'staff';

-- One record can be in only ONE open request at a time. lockKey = the record's id while its request is open (pending,
-- accepted, or a lent original not yet back) and NULL once it is closed; the unique index makes two simultaneous requests
-- for the same record impossible even if both pass the checks at the same moment.
ALTER TABLE "record_request_line" ADD COLUMN IF NOT EXISTS "lockKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "record_request_line_lockKey_key" ON "record_request_line"("lockKey");

-- Records already in an open request when this runs keep their place (nothing is open today, but it is safe to re-run).
UPDATE "record_request_line" l
SET "lockKey" = l."recordId"
FROM "record_request" r
WHERE r."id" = l."requestId" AND r."status" IN ('pending', 'requested', 'delivered') AND l."returnedAt" IS NULL AND l."lockKey" IS NULL;

-- The request's own history: created, accepted, delivered, returned, cancelled -- who and when. Only ever inserted.
CREATE TABLE IF NOT EXISTS "record_request_event" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "note" TEXT,
  "actor" JSONB NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "record_request_event_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "record_request"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "record_request_event_requestId_at_idx" ON "record_request_event"("requestId", "at");
