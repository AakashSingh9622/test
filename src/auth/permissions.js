// Kaunsa staff role kya kar sakta hai -- ek hi jagah. Frontend ka src/domain/permissions.ts isi ki copy hai
// (buttons chhupane ke liye); badlo to DONO saath badlo. Asli rok yahan (requirePermission middleware) hai.
//
// Har logged-in staff sab kuch DEKH sakta hai (boxes, orders, warehouses, box history); permissions sirf
// badalne wale kaamon ke liye hain.

const PERMISSIONS = [
  "layout.manage", // create warehouse / zone / aisle / rack, change a rack (cell length, zone, aisle), block or resize a slot
  "settings.manage", // box sizes and other settings
  "users.manage", // see staff users, assign / remove roles
  "audit.read", // global audit log + admin (system) audit log
  "boxes.operate", // register, print labels, put away / move, edit details, mark missing
  "boxes.hold", // place / release a hold
  "orders.operate", // create, schedule, start, cancel, dispatch, confirm destruction, digitize, complete
  "orders.approve", // approve / reject requested orders
  "orders.authorise", // record a client's destruction / digitizing authorisation
  "billing.view", // see invoices and the Sage settings
  "billing.manage", // prepare invoices, send them to Sage, change the Sage settings
  "records.manage", // retention rules and legal holds
  "records.approve", // the second signature on a destruction (must not be the person who prepared it)
];

const ROLE_PERMISSIONS = {
  staff_admin: PERMISSIONS, // DocuSoft admin -- everything
  warehouse_admin: ["layout.manage", "settings.manage", "audit.read", "boxes.operate", "boxes.hold", "orders.operate", "orders.approve"],
  operations_manager: ["audit.read", "boxes.operate", "orders.operate", "orders.approve", "orders.authorise"],
  staff_operator: ["boxes.operate", "orders.operate"],
  records_manager: ["audit.read", "boxes.hold", "orders.authorise", "records.manage", "records.approve"],
  finance_manager: ["audit.read", "billing.view", "billing.manage"],
  auditor: ["audit.read", "billing.view"],
};

// Roles an admin may hand out. staff_admin is NOT one of them: it only comes from DocuSoft's admin flag.
const ASSIGNABLE_ROLES = ["warehouse_admin", "operations_manager", "staff_operator", "records_manager", "finance_manager", "auditor"];

// DocuSoft user of this agreement with no local role and no admin flag.
const DEFAULT_ROLE = "staff_operator";

function permissionsFor(roles = []) {
  const set = new Set();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role] || []) set.add(p);
  return [...set];
}

function can(roles, permission) {
  return roles.some((role) => (ROLE_PERMISSIONS[role] || []).includes(permission));
}

// isAdmin (DocuSoft) + locally assigned roles -> the roles that actually count.
function effectiveRoles(isAdmin, localRoles = []) {
  const roles = [...(isAdmin ? ["staff_admin"] : []), ...localRoles.filter((r) => ASSIGNABLE_ROLES.includes(r))];
  return roles.length > 0 ? [...new Set(roles)] : [DEFAULT_ROLE];
}

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, ASSIGNABLE_ROLES, DEFAULT_ROLE, permissionsFor, can, effectiveRoles };
