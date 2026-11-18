-- Sprint 12 (Docbox "Contactos - Clientes", "Permisos Web"): which of the client's expedientes (files) a contact may see
-- on the portal. An empty list means every file (so existing contacts keep working). Additive, safe to run again.
--   npx prisma db execute --file prisma/sql/sprint12-contact-files.sql
ALTER TABLE "contact_permission" ADD COLUMN IF NOT EXISTS "expedienteIds" JSONB NOT NULL DEFAULT '[]';
