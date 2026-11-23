-- Item 4 (Peticiones, Step 13): the client's own order number ("Nro. Pedido") on a record request.
-- ONE new, empty, nullable column -- nothing existing is changed. Optional free text, NOT unique, 50 characters at most.
-- Additive and safe to run again.   npx prisma db execute --file prisma/sql/item4-order-number.sql
-- Rollback:  ALTER TABLE "record_request" DROP COLUMN "orderNumber";   (nothing else reads it)
ALTER TABLE "record_request" ADD COLUMN IF NOT EXISTS "orderNumber" VARCHAR(50);
