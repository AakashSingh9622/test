// Staff users and their roles -- app.js mounts it at "/api/users". Sirf users.manage (DocuSoft admin).
//   GET /                     -> { items: StaffUser[], total }
//   PUT /:email/roles  { roles: Role[] }  -> StaffUser   (replaces the locally assigned roles)
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { actorFromReq } = require("../utils/actor");
const { listUsers, setUserRoles } = require("../services/roleService");

const router = express.Router();
router.use(requireAuth, requirePermission("users.manage"));

router.get("/", asyncHandler(async (_req, res) => res.json(await listUsers())));
router.put(
  "/:email/roles",
  asyncHandler(async (req, res) => res.json(await setUserRoles(req.params.email, (req.body || {}).roles, actorFromReq(req))))
);

module.exports = router;
