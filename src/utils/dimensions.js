// Physical sizes. A rack cell and a box are both box-shaped: length x height x depth in centimetres. Storage is
// measured as VOLUME in cm3 (Slot.capacity = the cell's volume, Slot.used = the volume of the boxes inside).
// The frontend mirrors the constants in src/domain/dimensions.ts -- change both together.

// Defaults for a box size's length (cm), and the height / depth every size and every cell had before they were
// entered separately (50 x 50 cm; the migration in prisma/sql/cell-volume.sql multiplies old lengths by 2500).
const BOX_LENGTH_CM = { standard: 40, large: 80 };
const DEFAULT_HEIGHT_CM = 50;
const DEFAULT_DEPTH_CM = 50;
const MAX_DIMENSION_CM = 1000; // 1000 x 1000 x 1000 = 1e9 still fits a 32-bit Int

function volumeCm3(lengthCm, heightCm = DEFAULT_HEIGHT_CM, depthCm = DEFAULT_DEPTH_CM) {
  return lengthCm * heightCm * depthCm;
}

// What a box counts for in a cell: the volume saved on it when it was registered (admin may change the sizes later; boxes
// already in slots keep the volume they were counted with). Older rows only have a length -> assume the default 50 x 50.
function boxVolumeCm3(box) {
  if (box.volumeCm3 != null) return box.volumeCm3;
  const length = box.lengthCm ?? BOX_LENGTH_CM[box.size] ?? BOX_LENGTH_CM.standard;
  return volumeCm3(length, box.heightCm ?? DEFAULT_HEIGHT_CM, box.depthCm ?? DEFAULT_DEPTH_CM);
}

// "120 L" / "1.5 m³" -- for messages.
function formatVolume(cm3) {
  const litres = cm3 / 1000;
  if (litres >= 1000) return `${Number((litres / 1000).toFixed(2))} m³`;
  return `${Number(litres.toFixed(1))} L`;
}

const httpError = require("./httpError");

const CM_PER_UNIT = { cm: 1, ft: 30.48 };

// A length the user typed (cm or feet) -> whole centimetres (DB stores whole cm). Bad input is a 400, not a 500.
function toCentimetres(value, unit = "cm", label = "Length") {
  const factor = CM_PER_UNIT[unit];
  const n = Number(value);
  if (!factor) throw httpError(400, `Unknown length unit "${unit}" (use "cm" or "ft")`);
  if (!Number.isFinite(n) || n <= 0) throw httpError(400, `${label} must be a positive number`);
  const cm = Math.round(n * factor);
  if (cm < 1 || cm > MAX_DIMENSION_CM) {
    const given = unit === "ft" ? ` (${value} feet = ${cm} cm)` : "";
    throw httpError(400, `${label} must be between 1 and ${MAX_DIMENSION_CM} cm${given}`);
  }
  return cm;
}

module.exports = {
  BOX_LENGTH_CM,
  DEFAULT_HEIGHT_CM,
  DEFAULT_DEPTH_CM,
  MAX_DIMENSION_CM,
  volumeCm3,
  boxVolumeCm3,
  formatVolume,
  toCentimetres,
};
