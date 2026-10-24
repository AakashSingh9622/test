// Box kisi naye order me add ho sakta hai ya nahi -- frontend/src/domain/orders.ts se port kiya
// gaya, same rules (spec §4).
function statusText(status) {
  return status.replace(/_/g, " ");
}

function getBoxIneligibilityReason(box, type) {
  if (type === "collection") {
    if (box.openOrder) return `Already on order ${box.openOrder.orderNumber}`;
    if (box.status !== "out") return "Only boxes currently out with the client can be returned on a collection";
    return null;
  }
  // Quarantined boxes are held back from every order until a supervisor releases them (spec §4.1).
  if (box.status === "quarantined") return `Quarantined — ${box.quarantineReason || "reason not given"}`;
  // digitize: like destruction, but a box that is already digitized has nothing left to scan
  if (type === "digitize") {
    if (box.onHold) return `On hold — ${box.holdReason || "reason not given"}`;
    if (box.openOrder) return `Already on order ${box.openOrder.orderNumber}`;
    if (box.status === "digitized") return "Already digitized";
    if (box.status !== "stored") return `Box is ${statusText(box.status)}, not stored`;
    return null;
  }
  // dispatch + destruction (a digitized box is still in its slot, so it may be sent back or destroyed)
  if (box.onHold) return `On hold — ${box.holdReason || "reason not given"}`;
  if (box.openOrder) return `Already on order ${box.openOrder.orderNumber}`;
  if (box.status !== "stored" && box.status !== "digitized") return `Box is ${statusText(box.status)}, not stored`;
  return null;
}

module.exports = { getBoxIneligibilityReason };
