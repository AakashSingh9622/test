-- Sprint 12 (Docbox "Expedientes - Clientes"): the delivery-note template (Formato) and the order of the fields on it
-- (Ordenacion C1,C2,C3) belong to the expediente. Additive, safe to run again.
--   npx prisma db execute --file prisma/sql/sprint12-expediente-format.sql
ALTER TABLE "expediente" ADD COLUMN IF NOT EXISTS "format" TEXT NOT NULL DEFAULT 'Albaran';
ALTER TABLE "expediente" ADD COLUMN IF NOT EXISTS "deliveryColumns" JSONB NOT NULL DEFAULT '[]';
