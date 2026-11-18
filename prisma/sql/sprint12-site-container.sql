-- Sprint 12 (Docbox "Sede" and "Contenedor"): the site a warehouse belongs to, and a container number / type on each box.
-- Additive and safe to run again.  npx prisma db execute --file prisma/sql/sprint12-site-container.sql
ALTER TABLE "warehouse" ADD COLUMN IF NOT EXISTS "site" TEXT;
ALTER TABLE "box" ADD COLUMN IF NOT EXISTS "containerNo" TEXT;
ALTER TABLE "box" ADD COLUMN IF NOT EXISTS "containerType" TEXT;
-- Admin history entries for the warehouse's site, and (later) for expedientes.
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'warehouse_updated';
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'expediente_saved';
