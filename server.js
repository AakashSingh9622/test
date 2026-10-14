require("dotenv").config();

const app = require("./src/app");
const connectDB = require("./src/config/db");
const prisma = require("./src/config/prisma");
const { PORT } = require("./src/config/env");

// DB connect hone ke baad hi server listen karna shuru karta hai -- isse bachta hai ki server
// "up" dikhe par har request DB error se fail ho.
async function startServer() {
  try {
    await connectDB();
    const server = app.listen(PORT, () => {
      console.log(`Warehouse API running on http://localhost:${PORT}`);
    });

    // Graceful shutdown (deploy / restart): naye connections lena band karo, chalti requests poori hone do,
    // phir DB pool band karo -- beech me kaati hui requests ya latke hue connections nahi bachte.
    let closing = false;
    const shutdown = (signal) => {
      if (closing) return;
      closing = true;
      console.log(`${signal} received -- shutting down`);
      server.close(async () => {
        await prisma.$disconnect().catch(() => {});
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10_000).unref(); // 10s me band na ho to zabardasti
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();
