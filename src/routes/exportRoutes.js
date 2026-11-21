// CSV exports -- app.js mounts it at "/api/exports".  GET /:kind.csv?from=&to=&clientId=&status=
//   record-shelving: any staff -- returned records with their box's location, in the pick list's walking order (?ids= or ?clientId=&from=&to=)
//   records: any staff -- the records inventory (Docbox "Exportar Archivo a Excel"): one row per record with its internal code; filters clientId, expediente,
//     status, site, warehouse(Id), zone, aisle, rack(Id), row, boxFrom/To, containerFrom/To, palletFrom/To.  /records.count -> { count } for the same filters
//   record-loans: any staff -- records on loan now, one row per record (client's own fields as columns)
//   inventory, movements: any staff · audit: audit.read · charges: billing.view
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const { requirePermission } = require("../middleware/requirePermission");
const asyncHandler = require("../utils/asyncHandler");
const { exportCsv, countRecords } = require("../services/exportService");

const router = express.Router();
router.use(requireAuth);
const csv = (kind) => asyncHandler(async (req, res) => exportCsv(kind, req.query, res));

router.get("/inventory.csv", csv("inventory"));
router.get("/movements.csv", csv("movements"));
router.get("/loans.csv", csv("loans"));
router.get("/record-loans.csv", csv("record-loans"));
router.get("/record-shelving.csv", csv("record-shelving"));
router.get("/records.csv", csv("records"));
router.get("/records.count", asyncHandler(async (req, res) => res.json({ count: await countRecords(req.query) })));
router.get("/interfiling.csv", csv("interfiling"));
router.get("/toshelve.csv", csv("toshelve"));
router.get("/audit.csv", requirePermission("audit.read"), csv("audit"));
router.get("/charges.csv", requirePermission("billing.view"), csv("charges"));

module.exports = router;
