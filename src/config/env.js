// Saare environment variables yahi ek jagah se padhte hain -- kisi aur file me
// seedha "process.env.XYZ" mat likhna, warna kisi var ka naam galat type hone par
// error sirf runtime me, kisi random jagah pe milega.
// CRITICAL vars (DB connection, signing keys) yahan hi fail-fast crash karte hain -- taaki server
// galat/missing config ke saath silently na chale.

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[env] "${name}" set nahi hai apne .env file me -- isko set karke dobara start karo.`);
  }
  return value;
}

// A signing key must be long enough that it cannot be guessed.
function requiredSecret(name) {
  const value = required(name);
  if (value.length < 32) throw new Error(`[env] "${name}" bahut chhota hai -- kam se kam 32 characters ka random string rakho.`);
  return value;
}

const list = (value) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Supabase Postgres connection string -- Prisma isko khud process.env se padhta hai, yahan sirf
// fail-fast check ke liye require kiya hai.
required("DATABASE_URL");
// Staff login token (wms_session cookie) aur client-portal token ke alag-alag signing keys.
const SESSION_JWT_SECRET = requiredSecret("SESSION_JWT_SECRET");
const PORTAL_JWT_SECRET = requiredSecret("PORTAL_JWT_SECRET");
if (SESSION_JWT_SECRET === PORTAL_JWT_SECRET) {
  throw new Error("[env] SESSION_JWT_SECRET aur PORTAL_JWT_SECRET alag hone chahiye (warna ek tarah ka token dusre ki jagah chal jayega).");
}
// Portal token kitne minute chalta hai (expire hone par portal page phir se login API call karta hai).
const PORTAL_TOKEN_TTL_MINUTES = Math.max(5, Number(process.env.PORTAL_TOKEN_TTL_MINUTES) || 60);
// Server kis port par chalega.
const PORT = process.env.PORT || 5000;
// "development" ya "production" -- logging verbosity ke liye use hota hai.
const NODE_ENV = process.env.NODE_ENV || "development";
// Frontend se CORS requests allow karne ke liye origin -- "*" nahi rakh sakte kyunki
// cookie-based auth (wms_session) ke liye credentials:true chahiye. Default Next.js dev server port hai.
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";
// Client-portal ke static pages jahan se chalte hain (browser seedha /api/portal call karta hai).
const PORTAL_ORIGINS = list(process.env.PORTAL_ORIGINS);
// Load balancer / reverse proxy ke peeche ho to 1 (rate limiting ko asli client IP dikhe).
const TRUST_PROXY = process.env.TRUST_PROXY || "0";

module.exports = {
  PORT,
  NODE_ENV,
  CORS_ORIGIN,
  CORS_ORIGINS: [...list(CORS_ORIGIN), ...PORTAL_ORIGINS],
  PORTAL_ORIGINS,
  SESSION_JWT_SECRET,
  PORTAL_JWT_SECRET,
  PORTAL_TOKEN_TTL_MINUTES,
  TRUST_PROXY,
  isProduction: NODE_ENV === "production",
};
