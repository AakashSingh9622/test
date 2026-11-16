// Warehouse layout import (Docbox "Importacion de Almacen"): the shelves of a new warehouse come from a sheet with one
// row per shelf: Warehouse, Floor, Aisle, Module, Shelf.
// Mapping onto this system:  warehouse -> warehouse · floor -> zone · aisle -> aisle ("<floor>-<aisle>", so aisle 01 on
// two floors stays distinct) · module -> rack ("M<module>") · shelves of a module -> the rack's rows.
// Positions per shelf and the length of one position are not in the sheet; they are asked for once and apply to every rack.
// Everything is checked first; only a clean file creates anything. Existing warehouses, zones and aisles are reused;
// a rack that already exists is an error (rack codes are unique across warehouses).
const prisma = require("../config/prisma");
const { createWarehouse, createZone, createAisle, createRack } = require("./locationService");
const httpError = require("../utils/httpError");

const MAX_ROWS = 2000;
const text = (v) => (v === undefined || v === null ? "" : String(v).trim().replace(/\s+/g, " "));

// "North Warehouse" -> "NW", "Serreta Nave 12" -> "SN12"; made unique with a number if needed.
function codeFromName(name, taken) {
  const words = name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  let code = words.map((w, i) => (i === words.length - 1 && /\d/.test(w) ? w : w[0])).join("").slice(0, 8) || "WH";
  const base = code;
  for (let i = 2; taken.has(code); i++) code = `${base}${i}`.slice(0, 10);
  return code;
}

async function importLayout(input, actor) {
  const rows = input.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw httpError(400, "rows (non-empty array) is required");
  if (rows.length > MAX_ROWS) throw httpError(400, `At most ${MAX_ROWS} rows per file — split it`);
  const columns = Number(input.columns);
  const cellLength = Number(input.cellLengthCm);
  if (!Number.isInteger(columns) || columns < 1 || columns > 50) throw httpError(400, "columns (positions per shelf) must be a whole number from 1 to 50");
  if (!Number.isInteger(cellLength) || cellLength < 1 || cellLength > 1000) throw httpError(400, "cellLengthCm must be a whole number of cm from 1 to 1000");

  const errors = [];
  // warehouseName -> floor -> aisle -> module -> Set(shelf)
  const plan = new Map();
  rows.forEach((r, i) => {
    const rowNo = i + 2;
    const wh = text(r?.warehouse);
    const floor = text(r?.floor);
    const aisle = text(r?.aisle);
    const mod = text(r?.module);
    const shelf = Number(text(r?.shelf));
    const problems = [];
    if (!wh) problems.push("warehouse is empty");
    if (!floor) problems.push("floor is empty");
    if (!aisle) problems.push("aisle is empty");
    if (!mod) problems.push("module is empty");
    if (mod && `M${mod}`.length > 20) problems.push("module code is too long");
    if (!Number.isInteger(shelf) || shelf < 1 || shelf > 100) problems.push("shelf must be a whole number from 1 to 100");
    if (floor && `${floor}-${aisle}`.length > 20) problems.push("floor and aisle together are too long");
    if (problems.length) return errors.push({ row: rowNo, message: problems.join("; ") });
    const floors = plan.get(wh) ?? new Map();
    const aisles = floors.get(floor) ?? new Map();
    const modules = aisles.get(aisle) ?? new Map();
    const shelves = modules.get(mod) ?? new Set();
    if (shelves.has(shelf)) return errors.push({ row: rowNo, message: `shelf ${shelf} of module ${mod} is listed twice` });
    shelves.add(shelf);
    modules.set(mod, shelves);
    aisles.set(aisle, modules);
    floors.set(floor, aisles);
    plan.set(wh, floors);
  });

  // A module's shelves must be 1..N without gaps (a rack has rows 1..N).
  const racks = []; // { wh, floor, aisle, module, rows }
  for (const [wh, floors] of plan)
    for (const [floor, aisles] of floors)
      for (const [aisle, modules] of aisles)
        for (const [mod, shelves] of modules) {
          const max = Math.max(...shelves);
          if (shelves.size !== max) errors.push({ row: 0, message: `module ${mod} (${wh}, floor ${floor}) has shelves up to ${max} but only ${shelves.size} are listed — shelves must be 1…${max} with none missing` });
          racks.push({ wh, floor, aisle, module: mod, rows: max });
        }

  // Rack codes are unique across ALL warehouses, and a module listed under two aisles / floors would repeat one.
  const seen = new Map();
  for (const r of racks) {
    const code = `M${r.module}`.toLowerCase();
    if (seen.has(code)) errors.push({ row: 0, message: `module ${r.module} appears in more than one aisle or floor — each module must be unique` });
    seen.set(code, true);
  }
  const existing = await prisma.rack.findMany({ where: { code: { in: racks.map((r) => `M${r.module}`), mode: "insensitive" } }, select: { code: true } });
  for (const e of existing) errors.push({ row: 0, message: `rack ${e.code} already exists — remove those rows or use another module number` });

  if (errors.length) {
    const err = httpError(422, `${errors.length} problem${errors.length === 1 ? "" : "s"} — nothing was created`);
    err.errorCode = "IMPORT_INVALID";
    err.rowErrors = errors;
    throw err;
  }

  const summary = { warehouses: plan.size, zones: new Set(racks.map((r) => `${r.wh}|${r.floor}`)).size, aisles: new Set(racks.map((r) => `${r.wh}|${r.floor}|${r.aisle}`)).size, racks: racks.length, shelves: racks.reduce((n, r) => n + r.rows, 0) };
  if (input.dryRun) return { dryRun: true, ...summary };

  // Create. Each step reuses what exists, so a half-finished run can simply be repeated after fixing the cause.
  const allWarehouses = await prisma.warehouse.findMany();
  const takenCodes = new Set(allWarehouses.map((w) => w.code.toUpperCase()));
  for (const [whName, floors] of plan) {
    const wanted = whName.toLowerCase();
    let warehouse = allWarehouses.find((w) => w.code.toLowerCase() === wanted || w.name.toLowerCase() === wanted);
    if (!warehouse) {
      const code = codeFromName(whName, takenCodes);
      takenCodes.add(code);
      warehouse = await createWarehouse({ code, name: whName }, actor);
    }
    for (const [floor, aisles] of floors) {
      let zone = await prisma.zone.findFirst({ where: { warehouseId: warehouse.id, code: { equals: floor, mode: "insensitive" } } });
      if (!zone) zone = await createZone(warehouse.id, { code: floor, name: `Floor ${floor}` }, actor);
      for (const [aisleCode, modules] of aisles) {
        const code = `${floor}-${aisleCode}`;
        let aisle = await prisma.aisle.findFirst({ where: { warehouseId: warehouse.id, code: { equals: code, mode: "insensitive" } } });
        if (!aisle) aisle = await createAisle(warehouse.id, { code, name: `Aisle ${aisleCode}`, zoneId: zone.id }, actor);
        for (const [mod, shelves] of modules) {
          await createRack(
            warehouse.id,
            { code: `M${mod}`, label: `Module ${mod}`, rows: Math.max(...shelves), columns, cellLength: cellLength, lengthUnit: "cm", zoneId: zone.id, aisleId: aisle.id },
            actor
          );
        }
      }
    }
  }
  return { dryRun: false, ...summary };
}

module.exports = { importLayout, MAX_ROWS };
