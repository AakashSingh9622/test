// `npm run seed` -- do real warehouses + unke racks/slots Supabase Postgres me banata hai, taaki
// GET /api/warehouses jaisi APIs ko hit karne se pehle haath se data na dalna pade.
// Shape frontend ke mock seed (frontend/src/mocks/seed/locations.ts) jaisa hi rakha hai.
require("dotenv").config();

const prisma = require("../config/prisma");

const CELL_LENGTH_CM = 400; // har cell (row x column) ki length, centimetre me (~13 ft)
const ROWS = 4;
const COLUMNS = 6;
const RACK_LETTERS = "ABCDEFGHIJ";

const WAREHOUSE_SPECS = [
  { code: "WH1", name: "Central Warehouse", address: "12 Dockside Road, London E1 8QS", rackCount: 8 },
  { code: "WH2", name: "North Warehouse", address: "4 Bridgewater Way, Manchester M4 5JB", rackCount: 6 },
];

function rackCode(index) {
  const letter = RACK_LETTERS[index % RACK_LETTERS.length];
  const number = Math.floor(index / RACK_LETTERS.length) + 1;
  return `${letter}${String(number).padStart(2, "0")}`;
}

async function seedWarehouse(spec) {
  // Dobara seed run karne par purana warehouse hata do (idempotent seed, duplicate data nahi banega).
  // Racks/slots cascade se hat jaate hain; un slots me rakhe boxes ka slotId null ho jaata hai.
  await prisma.warehouse.deleteMany({ where: { code: spec.code } });

  const warehouse = await prisma.warehouse.create({
    data: { code: spec.code, name: spec.name, address: spec.address },
  });

  for (let r = 0; r < spec.rackCount; r++) {
    const code = rackCode(r);
    const rack = await prisma.rack.create({
      data: {
        warehouseId: warehouse.id,
        code,
        label: `Rack ${code[0]}-${code.slice(1)}`,
        rows: ROWS,
        columns: COLUMNS,
        cellLengthCm: CELL_LENGTH_CM,
      },
    });

    const slots = [];
    for (let row = 1; row <= ROWS; row++) {
      for (let col = 1; col <= COLUMNS; col++) {
        const isBlocked = Math.random() < 0.04; // ~4% slots blocked, mock seed jaisa hi
        slots.push({
          rackId: rack.id,
          warehouseId: warehouse.id,
          code: `${row}-${col}`,
          barcode: `SL-${spec.code}-${code}-${row}-${col}`,
          row,
          column: col,
          capacity: CELL_LENGTH_CM,
          used: 0,
          status: isBlocked ? "blocked" : "available",
        });
      }
    }
    await prisma.slot.createMany({ data: slots });
  }

  console.log(`Seeded warehouse ${spec.code}: ${spec.rackCount} racks, ${spec.rackCount * ROWS * COLUMNS} slots.`);
}

async function run() {
  for (const spec of WAREHOUSE_SPECS) {
    await seedWarehouse(spec);
  }
  console.log("Seed complete.");
  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error("Seed failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
