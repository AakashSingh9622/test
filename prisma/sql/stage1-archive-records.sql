-- Phase 2, stage 1 (Docbox "records"): a record is one row inside a box, with its own internal code. Only NEW tables --
-- no existing table is altered. Additive and safe to run again.   npx prisma db execute --file prisma/sql/stage1-archive-records.sql
CREATE TABLE IF NOT EXISTS "archive_record" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "internalCode" INTEGER NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientName" TEXT NOT NULL,
  "expedienteId" TEXT,
  "expedienteCode" TEXT,
  "boxId" TEXT NOT NULL,
  "boxNumber" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'archived',
  "fields" JSONB,
  "comments" TEXT,
  "createdBy" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "archive_record_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "box"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "archive_record_internalCode_key" ON "archive_record"("internalCode");
CREATE INDEX IF NOT EXISTS "archive_record_clientId_expedienteId_idx" ON "archive_record"("clientId", "expedienteId");
CREATE INDEX IF NOT EXISTS "archive_record_boxId_idx" ON "archive_record"("boxId");
CREATE INDEX IF NOT EXISTS "archive_record_clientId_status_idx" ON "archive_record"("clientId", "status");
CREATE INDEX IF NOT EXISTS "archive_record_status_idx" ON "archive_record"("status");

CREATE TABLE IF NOT EXISTS "archive_record_event" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "recordId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "note" TEXT,
  "actor" JSONB NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "archive_record_event_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "archive_record"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "archive_record_event_recordId_at_idx" ON "archive_record_event"("recordId", "at");
