// Client-portal ka token check. Portal me login page nahi hota -- parent portal pehle se logged-in client ki details
// (agrno, clientId, contact email, main contact?) POST /api/portal/auth/login ko bhejta hai aur wapas ek signed token
// milta hai; baaki har API call me wo token "Authorization: Bearer <token>" me jaata hai.
//
// Ye middleware token verify karke req.portal bana deta hai. clientId / email / role HAMESHA token se aate hain,
// kabhi request body ya URL se nahi -- isliye ek client doosre client ka data maang hi nahi sakta.
const { PORTAL_JWT_SECRET } = require("../config/env");
const { verifyJwt } = require("../utils/jwt");

function requirePortalAuth(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  const claims = match ? verifyJwt(match[1].trim(), PORTAL_JWT_SECRET) : null;
  if (!claims || claims.typ !== "portal" || !claims.clientId || !claims.email) {
    // Portal page is code par token dobara maangta hai (login API phir se call karke).
    return res.status(401).json({ status: false, code: "token_invalid", message: "Not authenticated" });
  }
  req.portal = {
    agrno: claims.agrno,
    clientId: claims.clientId,
    clientName: claims.clientName || undefined,
    email: claims.email,
    name: claims.name || undefined,
    role: claims.role, // client_admin (main contact) | client_user
    isMainContact: claims.isMainContact === true,
  };
  next();
}

module.exports = { requirePortalAuth };
