// Generic role gate -- abhi sirf staff_admin use hota hai, par staff_operator/client_admin/
// client_user routes aane par bhi yahi middleware reuse hoga, bas allowedRoles badal jaayenge.
// NOTE: requireAuth() isse pehle chalna zaroori hai (req.user set karne ke liye).
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const roles = (req.user && req.user.roles) || [];
    const hasAccess = roles.some((role) => allowedRoles.includes(role));
    if (!hasAccess) {
      return res.status(403).json({ status: false, message: "You do not have access to this resource" });
    }
    next();
  };
}

module.exports = { requireRole };
