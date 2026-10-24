// Express app setup -- server.js isko DB connect hone ke baad listen karwata hai.
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");

const { CORS_ORIGINS, TRUST_PROXY, isProduction } = require("./config/env");
const authRoutes = require("./routes/authRoutes");
const warehouseRoutes = require("./routes/warehouseRoutes");
const rackRoutes = require("./routes/rackRoutes");
const slotRoutes = require("./routes/slotRoutes");
const zoneRoutes = require("./routes/zoneRoutes");
const aisleRoutes = require("./routes/aisleRoutes");
const locationRoutes = require("./routes/locationRoutes");
const boxRoutes = require("./routes/boxRoutes");
const orderRoutes = require("./routes/orderRoutes");
const auditRoutes = require("./routes/auditRoutes");
const clientRoutes = require("./routes/clientRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const digitizeRoutes = require("./routes/digitizeRoutes");
const portalRoutes = require("./routes/portalRoutes");
const userRoutes = require("./routes/userRoutes");
const adminAuditRoutes = require("./routes/adminAuditRoutes");
const invoiceRoutes = require("./routes/invoiceRoutes");
const exceptionRoutes = require("./routes/exceptionRoutes");
const recordsRoutes = require("./routes/recordsRoutes");
const billingRoutes = require("./routes/billingRoutes");
const exportRoutes = require("./routes/exportRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const meRoutes = require("./routes/meRoutes");
const { notFound, errorHandler } = require("./middleware/errorMiddleware");

const app = express();

// Load balancer / reverse proxy ke peeche ho to asli client IP (rate limiting ke liye) X-Forwarded-For se aata hai.
if (TRUST_PROXY !== "0") app.set("trust proxy", /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
app.disable("x-powered-by");

app.use(helmet());
// JSON responses (lists of boxes/orders) gzip hoke jaate hain -- bade lists par bandwidth aur load time kam.
app.use(compression());
// Sirf allow-list ke origins browser se API call kar sakte hain (staff frontend + client-portal pages).
// credentials: true -- staff ka wms_session cookie cross-origin requests me bhi bhejna/padhna zaroori hai
// jab frontend (Next.js) aur ye backend alag ports/origins par chal rahe hon. Portal Bearer token use karta hai.
app.use(
  cors({
    origin(origin, callback) {
      // origin undefined = server-to-server / curl (browser CORS ka sawal hi nahi)
      if (!origin || CORS_ORIGINS.includes(origin)) return callback(null, true);
      // Development: Live Server / http-server pick any port (5500, 5502, 8080 ...) -- localhost is always fine here.
      // In production only the allow-list above counts.
      if (!isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({ status: true, message: "Warehouse API is running" });
});

// Saare domain routes /api/* ke neeche -- frontend ka apiClient bhi hamesha /api prefix bhejta hai.
app.use("/api/auth", authRoutes);
app.use("/api/warehouses", warehouseRoutes);
app.use("/api/racks", rackRoutes);
app.use("/api/slots", slotRoutes);
app.use("/api/zones", zoneRoutes);
app.use("/api/aisles", aisleRoutes);
app.use("/api/locations", locationRoutes);
app.use("/api/boxes", boxRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/users", userRoutes);
app.use("/api/admin-audit", adminAuditRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/exceptions", exceptionRoutes);
app.use("/api/records", recordsRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/exports", exportRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/me", meRoutes);
// External scan-app API (email + base64 password + agrno in the body).
app.use("/api/digitize", digitizeRoutes);
// Client-side (portal) API: alag token (Bearer), har response us client/contact tak limited.
app.use("/api/portal", portalRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
