-- Sprint 12 (Docbox "Sedes"): a registry of sites, so a site can exist before it has a warehouse.
-- A warehouse still keeps its site as text (warehouse.site); this table only lists the names. Additive, safe to run again.
--   npx prisma db execute --file prisma/sql/sprint12-site.sql
CREATE TABLE IF NOT EXISTS "site" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "site_name_key" ON "site"("name");
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'site_saved';
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'site_deleted';
