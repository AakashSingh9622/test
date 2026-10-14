// Staff session token (wms_session cookie). Ab ye ek SIGNED JWT (HS256) hai -- pehle sirf base64 JSON tha jo koi
// bhi forge kar sakta tha. Client-portal login ke baad ye API internet par khuli hai, isliye signature zaroori hai.
//
// Frontend ka src/auth/session-shared.ts sirf payload padhta hai (route guard ke liye, signature verify nahi
// karta); asli verification har API request par yahin hoti hai.
const { SESSION_JWT_SECRET } = require("../config/env");
const { signJwt, verifyJwt } = require("../utils/jwt");

const SESSION_COOKIE = "wms_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 din -- frontend ki cookie max-age ke barabar

// claims: { userId, name, email, side, roles, clientId? } -> signed token string
function encodeSession(claims) {
  return signJwt(claims, SESSION_JWT_SECRET, SESSION_TTL_SECONDS);
}

// Token ko claims me badalta hai; galat signature / expired / corrupt par null.
function decodeSession(token) {
  return verifyJwt(token, SESSION_JWT_SECRET);
}

// Request ke "Cookie" header se wms_session value nikalta hai aur verify karta hai.
function readSessionFromRequest(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!match) return null;
  return decodeSession(match.slice(SESSION_COOKIE.length + 1));
}

module.exports = { SESSION_COOKIE, encodeSession, decodeSession, readSessionFromRequest };
