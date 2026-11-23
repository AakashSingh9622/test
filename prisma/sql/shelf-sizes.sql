-- "The size of each shelf varies": an optional per-shelf size list on a rack (module).
-- ONE new, nullable column -- nothing existing changes (NULL = every shelf uses the rack's cell size, as today).
-- Additive and safe to run again.   npx prisma db execute --file prisma/sql/shelf-sizes.sql
-- Rollback:  ALTER TABLE "rack" DROP COLUMN "shelfSizes";   (set every module back to one size first)
ALTER TABLE "rack" ADD COLUMN IF NOT EXISTS "shelfSizes" JSONB;
