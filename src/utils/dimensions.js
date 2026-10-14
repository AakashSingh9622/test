// Physical sizes. Storage ab "box units" me nahi, centimetre me napta hai: har rack cell (row x column)
// ki ek length hai, aur har box apni length ke hisaab se cell ki jagah leta hai.

// Ek box ki length (cm) jitni jagah wo cell me gherta hai. (Pehle standard = 1 unit, large = 2 units tha;
// 1 unit = 40 cm maan kar wahi ratio rakha gaya hai -- badalna ho to sirf yahi do numbers badlo, aur
// frontend ka src/domain/dimensions.ts bhi.)
const BOX_LENGTH_CM = { standard: 40, large: 80 };

function boxLengthCm(sizeOrBox) {
  const size = typeof sizeOrBox === "string" ? sizeOrBox : sizeOrBox.size;
  return BOX_LENGTH_CM[size] ?? BOX_LENGTH_CM.standard;
}

const CM_PER_UNIT = { cm: 1, ft: 30.48 };

// User ki di hui length (cm ya feet) ko whole centimetres me convert karta hai (DB me whole cm store hote hain).
function toCentimetres(value, unit = "cm") {
  const factor = CM_PER_UNIT[unit];
  const n = Number(value);
  if (!factor) throw new Error(`Unknown length unit "${unit}" (use "cm" or "ft")`);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Length must be a positive number");
  return Math.round(n * factor);
}

module.exports = { BOX_LENGTH_CM, boxLengthCm, toCentimetres };
