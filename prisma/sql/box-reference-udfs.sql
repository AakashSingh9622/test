-- The client's DocuSoft Reference UDF values on each box ({ "<field name>": "<value>" }), filled in on Register boxes.
-- Additive and safe to run again.  npx prisma db execute --file prisma/sql/box-reference-udfs.sql
ALTER TABLE "box" ADD COLUMN IF NOT EXISTS "referenceUdfs" JSONB;
