-- Sprint 12 (Docbox "Observaciones" + "Fecha Entrada"): a free-text comment and an entry date on each box.
-- Additive and safe to run again.  npx prisma db execute --file prisma/sql/sprint12-box-comments.sql
ALTER TABLE "box" ADD COLUMN IF NOT EXISTS "comments" TEXT;
ALTER TABLE "box" ADD COLUMN IF NOT EXISTS "entryDate" DATE;
