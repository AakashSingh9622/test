-- Sprint 12 (Docbox loan types): an optional loan type on an order (normal | urgent | superior | fax).
-- Additive and safe to run again.  npx prisma db execute --file prisma/sql/sprint12-loan-type.sql
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS "loanType" TEXT;
