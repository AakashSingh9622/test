// Client-portal "login" (bina login page ke). Parent portal pehle hi DocuSoft se client ko authenticate kar chuka hota
// hai; wo humein 4 cheezein deta hai:
//    agrno           -- DocuSoft agreement number (kis organisation ka portal)
//    clientId        -- DocuSoft ClientID / OriginatorNo jis client ka data chahiye
//    contactEmail    -- us client ke kaun se contact ne kholi hai portal
//    isMainContact   -- true => client_admin (client ke saare orders), false => client_user (sirf apne orders)
// Hum agrno ko apne staff ke agrno se match karte hain; sahi ho to signed Bearer token dete hain, jisme ye sab bandh
// jaata hai. Baaki har portal API sirf us token ke clientId / email / role se kaam karti hai.
//
// SECURITY NOTE: DocuSoft ke bina, ye 4 values "claim" hain -- koi bhi jo inhe bhej sake token pa jayega.
// Isliye /api/portal/auth/login ko sirf apne parent portal ke server se (ya trusted origin se) call karwana chahiye,
// aur rate limit laga hai (portalRoutes.js). Agrno secret nahi hota.
const { PORTAL_JWT_SECRET, PORTAL_TOKEN_TTL_MINUTES } = require("../config/env");
const { signJwt } = require("../utils/jwt");
const httpError = require("../utils/httpError");
const { getDefaultDatabase, sameAgreement } = require("./appSettingService");

const MAX = { agrno: 100, clientId: 100, email: 254, name: 200 };

function text(value, field, { required = true } = {}) {
  const v = value === undefined || value === null ? "" : String(value).trim();
  if (!v) {
    if (required) throw httpError(400, `${field} is required`);
    return "";
  }
  const limit = MAX[field] ?? 200;
  if (v.length > limit) throw httpError(400, `${field} is too long`);
  return v;
}

function bool(value, field) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  throw httpError(400, `${field} must be true or false`);
}

async function login(input = {}) {
  const agrno = text(input.agrno, "agrno");
  const clientId = text(input.clientId, "clientId");
  const email = text(input.contactEmail, "email").toLowerCase();
  const isMainContact = bool(input.isMainContact, "isMainContact");
  const name = text(input.contactName, "name", { required: false });
  const clientName = text(input.clientName, "name", { required: false });

  // agrno must be the agreement this system is for (app_setting "defaultDatabase", e.g. "0003").
  const allowedAgrno = await getDefaultDatabase();
  // Ek hi generic jawab -- bahar se pata na chale ki kaunsa agrno valid hai.
  if (!allowedAgrno || !sameAgreement(agrno, allowedAgrno)) throw httpError(401, "Invalid credentials");

  const role = isMainContact ? "client_admin" : "client_user";
  const ttlSeconds = PORTAL_TOKEN_TTL_MINUTES * 60;
  const token = signJwt(
    { typ: "portal", agrno: allowedAgrno, clientId, clientName: clientName || undefined, email, name: name || undefined, role, isMainContact },
    PORTAL_JWT_SECRET,
    ttlSeconds
  );

  return {
    token,
    tokenType: "Bearer",
    expiresIn: ttlSeconds,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    user: { clientId, clientName: clientName || undefined, email, name: name || undefined, role, isMainContact },
  };
}

module.exports = { login };
