// Atomic auto-increment counters (box numbers, per-type order numbers). Postgres me ek hi
// INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement atomic hota hai, isliye do parallel
// requests kabhi same number nahi paatin.
const prisma = require("../config/prisma");

async function nextSequence(name, db = prisma) {
  const rows = await db.$queryRaw`
    INSERT INTO "counter" ("id", "seq") VALUES (${name}, 1)
    ON CONFLICT ("id") DO UPDATE SET "seq" = "counter"."seq" + 1
    RETURNING "seq"`;
  return Number(rows[0].seq);
}

module.exports = { nextSequence };
