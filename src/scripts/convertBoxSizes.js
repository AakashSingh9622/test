// `npm run sizes:convert` -- Sprint 11 (custom box sizes), run ONCE BEFORE `npx prisma db push`.
// box.size and box_size_config.size were the "BoxSize" enum (standard / large); now they are text so admins can add
// sizes. db push can't change that type without dropping the columns (it refuses), so this converts them in place and
// keeps every value. Safe to run again: it only touches a column that is still the enum. (Same SQL as
// prisma/sql/sprint11-box-sizes.sql, e.g. for the Supabase SQL editor.)
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const prisma = require("../config/prisma");

async function enumColumns() {
  return prisma.$queryRaw`
    SELECT table_name AS "table" FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'size' AND udt_name = 'BoxSize'
      AND table_name IN ('box', 'box_size_config')`;
}

async function main() {
  const before = await enumColumns();
  if (before.length === 0) {
    console.log("Nothing to do -- box sizes are already text. Next: npx prisma db push");
    return;
  }
  const sql = fs.readFileSync(path.join(__dirname, "../../prisma/sql/sprint11-box-sizes.sql"), "utf8");
  await prisma.$executeRawUnsafe(sql);
  const after = await enumColumns();
  if (after.length) throw new Error(`Still an enum: ${after.map((r) => r.table).join(", ")}`);
  console.log(`Converted ${before.map((r) => `${r.table}.size`).join(" and ")} to text (values kept). Next: npx prisma db push`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
