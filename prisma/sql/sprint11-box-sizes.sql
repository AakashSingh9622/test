-- Sprint 11 (custom box sizes): turn box.size and box_size_config.size from the old "BoxSize" enum into plain text,
-- KEEPING the values. Run once BEFORE `npx prisma db push` -- without it, db push refuses (it would drop the columns).
-- Safe to run again: it only converts a column that is still the enum.
--   npx prisma db execute --file prisma/sql/sprint11-box-sizes.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'box' AND column_name = 'size' AND udt_name = 'BoxSize') THEN
    ALTER TABLE "box" ALTER COLUMN "size" TYPE TEXT USING "size"::text;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'box_size_config' AND column_name = 'size' AND udt_name = 'BoxSize') THEN
    ALTER TABLE "box_size_config" ALTER COLUMN "size" TYPE TEXT USING "size"::text;
  END IF;
END $$;
