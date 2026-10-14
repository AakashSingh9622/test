// Order status state machine -- frontend/src/mocks/orderMachine.ts se port kiya gaya, same rules.
// Spec: requested -> approved -> scheduled -> in_progress -> completed, rejected sirf requested
// se, aur cancelled completed hone tak kabhi bhi.
class OrderTransitionError extends Error {
  constructor(from, to) {
    super(`Can't move an order from "${from}" to "${to}"`);
    this.name = "OrderTransitionError";
    this.code = "invalid_transition";
    this.status = 409;
  }
}

const TRANSITIONS = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["scheduled", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
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
