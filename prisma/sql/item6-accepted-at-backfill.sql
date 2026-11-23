-- Item 6: fill record_request."acceptedAt" for EXISTING requests, from reliable evidence only. Run it after item6-accepted-at.sql.
-- Only rows whose acceptedAt is still NULL are touched, so it is safe to run again.   npx prisma db execute --file prisma/sql/item6-accepted-at-backfill.sql
--
-- 1) A request made by STAFF is accepted when it is created (its records go on loan at once)             -> createdAt
UPDATE "record_request" SET "acceptedAt" = "createdAt" WHERE "acceptedAt" IS NULL AND "source" = 'staff';
-- 2) A PORTAL request that staff accepted has an `accepted` entry in its history                          -> that entry's time
UPDATE "record_request" q SET "acceptedAt" = e."at"
FROM (SELECT "requestId", MAX("at") AS "at" FROM "record_request_event" WHERE "type" = 'accepted' GROUP BY "requestId") e
WHERE e."requestId" = q."id" AND q."acceptedAt" IS NULL AND q."source" = 'portal';
-- Everything else stays NULL on purpose (waiting portal requests, ones cancelled while waiting, and old accepted portal requests with no
-- history entry). The report never guesses a date for them.
-- Rollback:  UPDATE "record_request" SET "acceptedAt" = NULL;
