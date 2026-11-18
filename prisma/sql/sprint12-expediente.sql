-- Sprint 12 (Docbox "Expedientes"): a client's files, a box's expediente, and fields that belong to one expediente.
-- Additive and safe to run again.  npx prisma db execute --file prisma/sql/sprint12-expediente.sql
CREATE TABLE IF NOT EXISTS "expediente" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "createdBy" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "expediente_clientId_code_key" ON "expediente"("clientId", "code");
CREATE INDEX IF NOT EXISTS "expediente_clientId_idx" ON "expediente"("clientId");
ALTER TABLE "box" ADD COLUMN IF NOT EXISTS "expedienteId" TEXT;
ALTER TABLE "box" ADD COLUMN IF NOT EXISTS "expedienteCode" TEXT;
CREATE INDEX IF NOT EXISTS "box_expedienteId_idx" ON "box"("expedienteId");
ALTER TABLE "custom_field_def" ADD COLUMN IF NOT EXISTS "expedienteId" TEXT;
