// Tiny HS256 JWT (header.payload.signature) on top of node:crypto -- no extra dependency. Used for BOTH login
// tokens (staff session cookie and the client-portal bearer token); each gets its own secret, so one kind of
// token can never be used as the other.
const crypto = require("crypto");

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const HEADER = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));

function sign(data, secret) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

// claims: plain object. ttlSeconds: how long the token lives (exp claim is added).
function signJwt(claims, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds }));
  return `${HEADER}.${payload}.${sign(`${HEADER}.${payload}`, secret)}`;
}

// Returns the claims, or null for ANY problem (bad format, wrong signature, expired). Never throws.
function verifyJwt(token, secret) {
  try {
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    if (header !== HEADER) return null; // only HS256 -- rejects "alg: none" and algorithm swaps
    const expected = Buffer.from(sign(`${header}.${payload}`, secret));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims || typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

module.exports = { signJwt, verifyJwt };
