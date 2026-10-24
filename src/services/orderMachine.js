// Order status state machine -- frontend/src/mocks/orderMachine.ts se port kiya gaya, same rules.
// Spec: requested -> approved -> scheduled -> in_progress -> (ready) -> completed, rejected sirf requested
// se, aur cancelled completed hone tak kabhi bhi.
//   ready   = har box pick ho gaya (pick scan), ab dispatch / destroy baaki hai
//   on_hold = supervisor ne roka; resume HAMESHA wahi status wapas deta hai jahan se roka gaya tha
//             (Order.heldFromStatus) -- ye check orderService.resumeOrder karta hai.
class OrderTransitionError extends Error {
  constructor(from, to) {
    super(`Can't move an order from "${from}" to "${to}"`);
    this.name = "OrderTransitionError";
    this.code = "invalid_transition";
    this.status = 409;
  }
}

const TRANSITIONS = {
  requested: ["approved", "rejected", "cancelled", "on_hold"],
  approved: ["scheduled", "cancelled", "on_hold"],
  scheduled: ["in_progress", "cancelled", "on_hold"],
  in_progress: ["ready", "completed", "cancelled", "on_hold"],
  ready: ["completed", "cancelled", "on_hold"],
  on_hold: ["requested", "approved", "scheduled", "in_progress", "ready", "cancelled"],
  completed: [],
  cancelled: [],
  rejected: [],
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new OrderTransitionError(from, to);
  }
}

function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

module.exports = { OrderTransitionError, assertTransition, canTransition, TRANSITIONS };
