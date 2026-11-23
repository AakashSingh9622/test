-- Rack cells and boxes become box-shaped (length x height x depth, cm). Slot.capacity / Slot.used are now VOLUME in cm3.
-- Every existing cell and box size gets height = depth = 50 cm, so old data behaves exactly as before:
-- a cell of L cm becomes L x 50 x 50 = L x 2500 cm3, a box of L cm becomes L x 2500 cm3 (fit checks are unchanged).
-- Run ONCE per database; the DO block skips itself if the columns already exist, so running it again changes nothing.
--   npx prisma db execute --file prisma/sql/cell-volume.sql        (then restart the backend)
-- Do NOT also run `prisma db push` first -- push adds the columns and this script would then think it already ran.
-- Rollback: divide slot.capacity / slot.used by 2500 again and drop the new columns (heightCm, depthCm, volumeCm3,
--           cellHeightCm, cellDepthCm).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'rack' AND column_name = 'cellHeightCm'
  ) THEN
    RAISE NOTICE 'cell-volume: already applied, nothing to do';
    RETURN;
  END IF;

  ALTER TABLE "rack" ADD COLUMN "cellHeightCm" INTEGER NOT NULL DEFAULT 50;
  ALTER TABLE "rack" ADD COLUMN "cellDepthCm" INTEGER NOT NULL DEFAULT 50;
  ALTER TABLE "box_size_config" ADD COLUMN "heightCm" INTEGER NOT NULL DEFAULT 50;
  ALTER TABLE "box_size_config" ADD COLUMN "depthCm" INTEGER NOT NULL DEFAULT 50;
  ALTER TABLE "box" ADD COLUMN "heightCm" INTEGER;
  ALTER TABLE "box" ADD COLUMN "depthCm" INTEGER;
  ALTER TABLE "box" ADD COLUMN "volumeCm3" INTEGER;

  ALTER TABLE "slot" ALTER COLUMN "capacity" SET DEFAULT 1000000;
  UPDATE "slot" SET "capacity" = "capacity" * 2500, "used" = "used" * 2500;
  -- Boxes registered with a length keep it; their volume is that length x 50 x 50. (Boxes with no length of their own
  -- are counted from their size's length at run time, see boxVolumeCm3 in src/utils/dimensions.js.)
  UPDATE "box" SET "heightCm" = 50, "depthCm" = 50, "volumeCm3" = "lengthCm" * 2500 WHERE "lengthCm" IS NOT NULL;
END $$;
