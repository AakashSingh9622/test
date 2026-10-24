// `npm run locations:refresh` -- har stored box ki CURRENT location (box.locationPath) live layout se dobara likhta hai:
// zone / aisle / shelf / position ke saath, aur rack ka asli code ("B-04" nahi, "B04"). Sprint 10 ke baad ek baar chalao
// taaki purane boxes bhi naye boxes jaisa dikhein. History (audit, movements, order lines) kabhi nahi badalti.
//   npm run locations:refresh             -> dry run (kitne boxes badlenge)
//   npm run locations:refresh -- --apply  -> likho
require("dotenv").config();

const prisma = require("../config/prisma");
const { Prisma } = require("../config/prisma");
const { refreshBoxLocations } = require("../services/locationService");

const apply = process.argv.includes("--apply");

async function main() {
  const [{ count }] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS "count" FROM "box" WHERE "slotId" IS NOT NULL`;
  if (!apply) {
    console.log(`${count} box location(s) would be refreshed. Run with --apply to write them.`);
    return;
  }
  const changed = await refreshBoxLocations(Prisma.sql`TRUE`);
  console.log(`Refreshed ${changed} box location(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
