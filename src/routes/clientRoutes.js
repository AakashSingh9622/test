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
const { balancesByClient } = require("../services/accountService");
const { rolesForUser } = require("../services/roleService");
const { can } = require("../auth/permissions");

const router = express.Router();
router.use(requireAuth);

// Box states that are in our warehouse (on a shelf, at Goods-In, on an order but not gone yet) vs. with the client.
const IN_STORAGE = ["received", "stored", "reserved", "picked", "digitized", "quarantined", "missing"];
const OUT = ["out", "return_pending"];
const CLOSED_ORDER = ["completed", "cancelled", "rejected"];

// GET /api/clients/stats -- for the Clients list: what we hold for every client that has boxes or orders here, in a
// few grouped queries (never one call per client). Balance / overdue only for people who may see billing.
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const roles = req.user?.side === "staff" ? await rolesForUser(req.user.userId) : [];
    const seesBilling = can(roles, "billing.view");
    const [boxGroups, orderGroups, lastBox, lastOrder, balances] = await Promise.all([
      prisma.box.groupBy({ by: ["clientId", "status"], _count: { _all: true } }),
      prisma.order.groupBy({ by: ["clientId"], where: { status: { notIn: CLOSED_ORDER } }, _count: { _all: true } }),
      prisma.box.groupBy({ by: ["clientId"], _max: { updatedAt: true } }),
      prisma.order.groupBy({ by: ["clientId"], _max: { updatedAt: true } }),
      seesBilling ? balancesByClient() : Promise.resolve(new Map()),
    ]);
    const stats = new Map();
    const row = (clientId) => {
      if (!stats.has(clientId)) stats.set(clientId, { clientId, inStorage: 0, out: 0, boxes: 0, openOrders: 0 });
      return stats.get(clientId);
    };
    for (const g of boxGroups) {
      const r = row(g.clientId);
      if (IN_STORAGE.includes(g.status)) r.inStorage += g._count._all;
      if (OUT.includes(g.status)) r.out += g._count._all;
      if (!["destroyed", "permanently_withdrawn"].includes(g.status)) r.boxes += g._count._all;
    }
    for (const g of orderGroups) row(g.clientId).openOrders = g._count._all;
    for (const g of [...lastBox, ...lastOrder]) {
      const r = row(g.clientId);
      const at = g._max.updatedAt?.toISOString();
      if (at && (!r.lastActivityAt || at > r.lastActivityAt)) r.lastActivityAt = at;
    }
    for (const [clientId, b] of balances) Object.assign(row(clientId), b);
    if (seesBilling) for (const r of stats.values()) Object.assign(r, { balance: r.balance ?? 0, overdue: r.overdue ?? 0 });
    res.json({ items: [...stats.values()], seesBilling });
  })
);

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
