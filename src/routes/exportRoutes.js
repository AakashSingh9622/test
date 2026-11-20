// CSV exports -- app.js mounts it at "/api/exports".  GET /:kind.csv?from=&to=&clientId=&status=
//   record-shelving: any staff -- returned records with their box's location, in the pick list's walking order (?ids= or ?clientId=&from=&to=)
//   record-loans: any staff -- records on loan now, one row per record (client's own fields as columns)
//   inventory, movements: any staff · audit: audit.read · charges: billing.view
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { exportCsv } = require("../services/exportService");

const router = express.Router();
router.use(requireAuth);
const csv = (kind) => asyncHandler(async (req, res) => exportCsv(kind, req.query, res));

router.get("/inventory.csv", csv("inventory"));
router.get("/movements.csv", csv("movements"));
router.get("/loans.csv", csv("loans"));
router.get("/record-loans.csv", csv("record-loans"));
router.get("/record-shelving.csv", csv("record-shelving"));
router.get("/interfiling.csv", csv("interfiling"));
router.get("/toshelve.csv", csv("toshelve"));
router.get("/audit.csv", requirePermission("audit.read"), csv("audit"));
router.get("/charges.csv", requirePermission("billing.view"), csv("charges"));

module.exports = router;
