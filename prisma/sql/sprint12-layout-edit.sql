-- Sprint 12 (Docbox warehouse screens): admin history for deleting a rack / a warehouse.
-- Additive and safe to run again.  npx prisma db execute --file prisma/sql/sprint12-layout-edit.sql
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'warehouse_deleted';
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'rack_deleted';
