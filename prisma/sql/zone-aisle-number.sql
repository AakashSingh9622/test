-- A short, globally unique number for every floor (zone) and aisle, shown next to its code: "Floor 01 (21)", "Aisle 01 (15)".
-- System-given, never reused, never edited. Existing rows are numbered by creation date (oldest = 1); new ones continue
-- from there via the column's sequence (Prisma: @default(autoincrement())).
-- Safe to run again (skips what already exists).   npx prisma db execute --file prisma/sql/zone-aisle-number.sql
-- Rollback:  ALTER TABLE "zone" DROP COLUMN "number"; ALTER TABLE "aisle" DROP COLUMN "number";
--            DROP SEQUENCE IF EXISTS "zone_number_seq"; DROP SEQUENCE IF EXISTS "aisle_number_seq";
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zone', 'aisle'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = t AND column_name = 'number') THEN
      RAISE NOTICE '%.number already exists, skipped', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ADD COLUMN "number" INTEGER', t);
    EXECUTE format(
      'UPDATE %1$I SET "number" = n.rn FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt", id) AS rn FROM %1$I) n WHERE %1$I.id = n.id',
      t
    );
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I OWNED BY %I."number"', t || '_number_seq', t);
    EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX("number") FROM %I), 0) + 1, false)', t || '_number_seq', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "number" SET DEFAULT nextval(%L)', t, t || '_number_seq');
    EXECUTE format('ALTER TABLE %I ALTER COLUMN "number" SET NOT NULL', t);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I ("number")', t || '_number_key', t);
  END LOOP;
END $$;
