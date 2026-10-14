// Prisma 7 CLI config -- migrations/db push ke liye connection yahin se aata hai.
// DIRECT_URL (session pooler / direct) CLI ke liye, runtime client DATABASE_URL adapter se use karta hai.
require("dotenv/config");
const { defineConfig } = require("prisma/config");

module.exports = defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
});
