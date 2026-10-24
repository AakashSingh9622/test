const express = require("express");
const { resolveLocation, searchRacks } = require("../controllers/locationController");
const { requireAuth } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

router.use(requireAuth);

// Find a location by typing / scanning its code ("B04-3", "B04-3-2", a slot barcode) -- read only, any staff.
router.get("/resolve", asyncHandler(resolveLocation));
router.get("/racks", asyncHandler(searchRacks));

module.exports = router;
