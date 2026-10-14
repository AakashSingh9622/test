// Supabase Postgres (Prisma) connection -- server.js boot ke time connectDB() call karta hai,
// taaki galat DATABASE_URL par server "up" dikhane ke bajaye turant fail ho jaye.
const prisma = require("./prisma");

async function connectDB() {
  await prisma.$connect();
  const [{ current_database: dbName }] = await prisma.$queryRaw`SELECT current_database()`;
  console.log(`Postgres connected -> database: "${dbName}"`);
}

module.exports = connectDB;
