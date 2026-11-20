-- Phase 2, stage 5 (Docbox "Peticiones"): requests for records. Only NEW tables -- nothing existing is altered.
-- Additive and safe to run again.   npx prisma db execute --file prisma/sql/stage5-record-requests.sql
CREATE TABLE IF NOT EXISTS "record_request" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestNumber" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "loanType" TEXT NOT NULL DEFAULT 'normal',
  "requestChannel" TEXT,
  "contactName" TEXT,
  "contactEmail" TEXT,
  "notes" TEXT,
  "recordCount" INTEGER NOT NULL DEFAULT 0,
  "requestedBy" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "record_request_requestNumber_key" ON "record_request"("requestNumber");
CREATE INDEX IF NOT EXISTS "record_request_clientId_createdAt_idx" ON "record_request"("clientId", "createdAt");
CREATE INDEX IF NOT EXISTS "record_request_status_createdAt_idx" ON "record_request"("status", "createdAt");

CREATE TABLE IF NOT EXISTS "record_request_line" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestId" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "internalCode" INTEGER NOT NULL,
  "boxNumber" TEXT NOT NULL,
  "summary" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "record_request_line_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "record_request"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "record_request_line_requestId_recordId_key" ON "record_request_line"("requestId", "recordId");
CREATE INDEX IF NOT EXISTS "record_request_line_recordId_idx" ON "record_request_line"("recordId");
