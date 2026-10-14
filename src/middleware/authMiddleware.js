// Request ke wms_session cookie se logged-in user attach karta hai -- jo bhi route isko use
// karega, usse pehle hi req.user ready milega (ya 401 ho chuka hoga).
const { readSessionFromRequest } = require("../auth/sessionToken");

function requireAuth(req, res, next) {
  const claims = readSessionFromRequest(req);
  if (!claims) {
    return res.status(401).json({ status: false, message: "Not authenticated" });
  }
  req.user = claims; // { userId, name, email, side, roles, clientId? }
  next();
}

module.exports = { requireAuth };
