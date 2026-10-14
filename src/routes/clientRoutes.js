// Per-client detail tabs (Boxes, Orders) -- app.js inhe "/api/clients" par mount karta hai.
// Clients khud DocuSoft me rehte hain (yahan koi Client table nahi), isliye yahan sirf wahi boxes/
// orders aate hain jinpe ye DocuSoft clientId likha hai -- client ka detail/users endpoint abhi
// frontend ke mock par hi hai.
const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const asyncHandler = require("../utils/asyncHandler");
const boxService = require("../services/boxService");
const orderService = require("../services/orderService");
const prisma = require("../config/prisma");

const router = express.Router();
router.use(requireAuth);

// Client summary for the detail header. Client master data (name, attributes) stays in DocuSoft;
// here we only count what WE hold for that DocuSoft clientId. Always 200 (even for a client with no
// boxes/orders yet) -- the frontend shows the DocuSoft name if it has one.
router.get(
  "/:clientId",
  asyncHandler(async (req, res) => {
    const clientId = req.params.clientId;
    const [boxCount, openOrderCount, latest] = await Promise.all([
      prisma.box.count({ where: { clientId, status: { not: "destroyed" } } }),
      prisma.order.count({ where: { clientId, status: { notIn: ["completed", "cancelled", "rejected"] } } }),
      prisma.box.findFirst({ where: { clientId }, orderBy: { createdAt: "desc" }, select: { clientName: true } }),
    ]);
    res.json({
      id: clientId,
      code: clientId,
      name: latest?.clientName ?? clientId,
      status: "active",
      boxCount,
      openOrderCount,
      attributes: [],
    });
  })
);

router.get(
  "/:clientId/boxes",
  asyncHandler(async (req, res) => {
    const q = req.query;
    res.json(
      await boxService.searchBoxes({
        clientId: req.params.clientId,
        q: q.q,
        page: q.page ? Number(q.page) : undefined,
        pageSize: q.pageSize ? Number(q.pageSize) : undefined,
      })
    );
  })
);

router.get(
  "/:clientId/orders",
  asyncHandler(async (req, res) => {
    res.json(
      await orderService.searchOrders({
        clientId: req.params.clientId,
        contactEmail: req.query.contactEmail,
        page: req.query.page,
        pageSize: req.query.pageSize,
      })
    );
  })
);

module.exports = router;
