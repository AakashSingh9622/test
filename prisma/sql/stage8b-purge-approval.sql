-- Phase 2, stage 8b: second-person approval of a purge by file. Only a NEW table -- nothing existing is altered.
-- Additive and safe to run again.   npx prisma db execute --file prisma/sql/stage8b-purge-approval.sql
CREATE TABLE IF NOT EXISTS "record_purge_request" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestNumber" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "purgeCount" INTEGER NOT NULL,
  "loanCount" INTEGER NOT NULL DEFAULT 0,
  "rows" JSONB NOT NULL,
  "loan" JSONB,
  "preparedBy" JSONB NOT NULL,
  "decidedBy" JSONB,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "record_purge_request_requestNumber_key" ON "record_purge_request"("requestNumber");
CREATE INDEX IF NOT EXISTS "record_purge_request_status_createdAt_idx" ON "record_purge_request"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "record_purge_request_clientId_createdAt_idx" ON "record_purge_request"("clientId", "createdAt");
