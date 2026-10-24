// Permission gate for staff routes (kaunsa role kya kar sakta hai: src/auth/permissions.js). Roles token se nahi,
// database se aate hain (roleService, 30s cache) -- role badalte hi asar, 7 din wale token ka intezaar nahi.
// NOTE: requireAuth() isse pehle chalna zaroori hai (req.user set karne ke liye).
const { can } = require("../auth/permissions");
const { rolesForUser } = require("../services/roleService");

function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const roles = req.user?.side === "staff" ? await rolesForUser(req.user.userId) : null;
      if (!roles) return res.status(401).json({ status: false, message: "Not authenticated" });
      req.user.roles = roles; // fresh roles for the rest of the request
      if (!can(roles, permission)) {
        return res.status(403).json({ status: false, code: "forbidden", message: "You do not have access to this action" });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requirePermission };
