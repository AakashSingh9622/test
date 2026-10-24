// `npm run slots:recompute` -- har slot ka `used` (cm) us slot me asli pade boxes se dobara ginta hai.
// Kyun: pehle slot block karne par `used` zero ho jaata tha jabki boxes andar hi rehte the, isliye purane blocked
// slots ke numbers galat ho sakte hain. Default sirf dikhata hai kya badlega; `--apply` dene par hi likhta hai.
//   npm run slots:recompute             -> dry run
//   npm run slots:recompute -- --apply  -> fix
require("dotenv").config();

const prisma = require("../config/prisma");
const { BOX_LENGTH_CM } = require("../utils/dimensions");

const apply = process.argv.includes("--apply");

async function main() {
  // Box ki length = registration ke waqt save hui lengthCm, purane rows me size ka default (boxAllocationService jaisa).
  // Pehle har slot ke boxes ka total, phir slots se join -- khaali slot ka total 0 (seedha LEFT JOIN box karne par
  // khaali slot ki NULL row ko size-default 40 cm mil jaata tha).
  const rows = await prisma.$queryRaw`
    SELECT s."id", s."code", s."barcode", s."used" AS "storedUsed", s."capacity", s."status",
           COALESCE(t."total", 0)::int AS "actualUsed"
    FROM "slot" s
    LEFT JOIN (
      SELECT "slotId",
             SUM(COALESCE("lengthCm",
               CASE WHEN "size" = 'large'::"BoxSize" THEN ${BOX_LENGTH_CM.large}::int ELSE ${BOX_LENGTH_CM.standard}::int END))::int AS "total"
      FROM "box" WHERE "slotId" IS NOT NULL GROUP BY "slotId"
    ) t ON t."slotId" = s."id"
    WHERE s."used" <> COALESCE(t."total", 0)
    ORDER BY s."barcode"`;

  if (rows.length === 0) {
    console.log("All slots are correct -- nothing to fix.");
    return;
  }
  console.table(rows.map((r) => ({ slot: r.barcode, status: r.status, capacity: r.capacity, stored: r.storedUsed, actual: r.actualUsed })));
  if (!apply) {
    console.log(`${rows.length} slot(s) are wrong. Run again with --apply to fix them.`);
    return;
  }

  for (const r of rows) {
    // blocked slot blocked hi rehta hai; baaki ka available/full asli used se.
    await prisma.$executeRaw`
      UPDATE "slot"
      SET "used" = ${r.actualUsed}::int,
          "status" = CASE
            WHEN "status" = 'blocked'::"SlotStatus" THEN "status"
            WHEN ${r.actualUsed}::int >= "capacity" THEN 'full'::"SlotStatus"
            ELSE 'available'::"SlotStatus" END,
          "updatedAt" = NOW()
      WHERE "id" = ${r.id}`;
  }
  console.log(`Fixed ${rows.length} slot(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
