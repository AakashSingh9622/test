// Ek hi shared PrismaClient poore process me -- har file yahin se import kare, naya client mat banao
// (har naya client apna connection pool kholta hai). Prisma 7: driver adapter (pg) zaroori hai.
require("dotenv/config");
const { PrismaPg } = require("@prisma/adapter-pg");
const { PrismaClient, Prisma } = require("@prisma/client");

// Supabase's pooler silently drops connections that sat idle for a while. If the pool still holds such a dead one,
// the next query fails with "Server has closed the connection" (this hit POST /portal/orders). So: recycle idle
// connections well before the server does, keep TCP alive, and don't wait forever for a new one.
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX) || 10,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  }),
});

module.exports = prisma;
module.exports.Prisma = Prisma;
